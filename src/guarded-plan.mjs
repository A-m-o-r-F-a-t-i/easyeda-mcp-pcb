import { expectedForRpc } from './execution-context.mjs';
import { executeBridgeCode, loadPlanSource, validatePlanSource, readPcb } from './bridge.mjs';
import { preflightGeometry, assertPreflightClear } from './copper-preflight.mjs';
import { buildExplicitPlan, buildRemainingPlan, verifiedContiguousPrefix, executionLedger } from './plan-workflow.mjs';
import { runKeepoutPlan } from './keepout.mjs';
import { validateTextPlanSource } from './advanced.mjs';
import { connectGateway, gatewayError, hashObject, prepareGatewayState } from './gateway-client.mjs';
import { contextRpc, contextVerifiedPublicWrite, runGuardedNative } from './execution-context.mjs';
import { prepareGeometryTransport, circularReadbackRequests, verifyCircularCopperReadback } from './geometry-transport.mjs';
import { verifyNativeViaPrecision } from './native-precision.mjs';
import { buildBatchCode } from './runtime.mjs';
import { createWorkflowReceipt } from './workflow-receipt.mjs';

export function assertGuardMatchesPlan(guard, raw, normalized) {
  if (guard?.schema !== 'easyeda-pcb-guard/v1' || guard.planSha256 !== hashObject(raw)) throw gatewayError('EPOCH_MISMATCH', 'The plan changed after preparation; validate and prepare the new plan');
  for (const field of ['windowId', 'projectUuid', 'documentUuid']) if (guard.target?.[field] !== normalized.target[field]) throw gatewayError('TARGET_CHANGED', 'Prepared guard and plan target differ');
}

const changedStatuses = new Set(['created', 'modified', 'deleted']);
// Pure-line suffixes use the same guarded, independently verified adapter as mixed geometry.
const bridgeGeometryKinds = new Set(['line', 'arc', 'polyline', 'pad', 'fill', 'pour', 'stackup', 'component', 'via']);
const padOverlapKinds = new Set(['component', 'pad', 'via']);

export function requiresBridgeGeometryRuntime(kind, operations = []) {
  return kind === 'geometry' && operations.some(operation => bridgeGeometryKinds.has(operation.kind));
}

export function resolveProtectedBatchSize(normalized) {
  const size = normalized?.options?.batchSize;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw gatewayError('INVALID_REQUEST', 'Protected plan batchSize must be an integer from 1 to 100');
  return size;
}

export function summarizePadOverlapGate(normalized, confirmedResults = [], failureCode = null) {
  const operationIds = (normalized?.operations ?? [])
    .filter(operation => padOverlapKinds.has(operation.kind) && /\.(create|modify)$/.test(operation.type))
    .map(operation => operation.id);
  if (failureCode === 'PAD_OVERLAP_BLOCKED') return {
    state: 'BLOCKED',
    nextPlacementRoundAllowed: false,
    relevantOperationCount: operationIds.length,
    checkedOperationCount: confirmedResults.filter(result => result?.overlapGuard).length,
    missingEvidenceOperationIds: operationIds.filter(id => !confirmedResults.some(result => result?.id === id && result?.overlapGuard)),
    scope: 'different-component pads and standalone pad/via versus component pads',
  };
  if (!operationIds.length) return {
    state: 'NOT_APPLICABLE',
    nextPlacementRoundAllowed: true,
    relevantOperationCount: 0,
    checkedOperationCount: 0,
    missingEvidenceOperationIds: [],
    scope: 'different-component pads and standalone pad/via versus component pads',
  };
  const checked = new Set(confirmedResults.filter(result => result?.overlapGuard).map(result => result.id));
  const missingEvidenceOperationIds = operationIds.filter(id => !checked.has(id));
  return {
    state: missingEvidenceOperationIds.length ? 'UNVERIFIED' : 'CLEAR',
    nextPlacementRoundAllowed: missingEvidenceOperationIds.length === 0,
    relevantOperationCount: operationIds.length,
    checkedOperationCount: operationIds.length - missingEvidenceOperationIds.length,
    missingEvidenceOperationIds,
    scope: 'different-component pads and standalone pad/via versus component pads',
  };
}

/** Summarize verified writes without treating validation, no-ops or deployment as PCB progress. */
export function summarizeBoardDelta(normalized, confirmedResults, remainingOperationIds = []) {
  const operations = new Map((normalized?.operations ?? []).map(operation => [operation.id, operation]));
  const statusCounts = {}, changedByKind = {}, changedOperationIds = [], unchangedOperationIds = [];
  const changedPrimitiveIds = new Set();
  for (const result of confirmedResults ?? []) {
    const status = String(result?.status ?? 'unknown');
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (!changedStatuses.has(status)) { unchangedOperationIds.push(result?.id ?? null); continue; }
    changedOperationIds.push(result.id);
    const kind = operations.get(result.id)?.kind ?? 'unknown';
    changedByKind[kind] = (changedByKind[kind] ?? 0) + 1;
    for (const primitiveId of result.primitiveIds ?? (result.primitiveId ? [result.primitiveId] : [])) changedPrimitiveIds.add(primitiveId);
  }
  const visibleBoardChange = changedOperationIds.length > 0;
  return {
    confirmedOperationCount: confirmedResults?.length ?? 0,
    changedOperationCount: changedOperationIds.length,
    unchangedOperationCount: unchangedOperationIds.length,
    changedPrimitiveCount: changedPrimitiveIds.size,
    statusCounts,
    changedByKind,
    changedOperationIds,
    unchangedOperationIds,
    remainingOperationIds,
    visibleBoardChange,
    progressClass: visibleBoardChange ? 'BOARD_CHANGED' : 'NO_BOARD_CHANGE',
    nextAction: visibleBoardChange
      ? 'Continue with the next dependency-ready PCB operations. Run broad audits at the stage boundary, not before every write.'
      : 'Do not report PCB progress. Reconcile live state, then execute the next dependency-ready write or switch to an independent board region.',
  };
}

export function continuationDetails(normalized, confirmedResults, failedOperationId = null) {
  const confirmedIds = new Set(confirmedResults.map(item => item.id));
  const remainingOperationIds = normalized.operations.filter(operation => !confirmedIds.has(operation.id)).map(operation => operation.id);
  const boardDelta = summarizeBoardDelta(normalized, confirmedResults, remainingOperationIds);
  return {
    confirmedPlanOperations: confirmedResults,
    failedOperationId,
    remainingOperationIds,
    boardDelta,
    workflowReceipt: createWorkflowReceipt({ mode: 'execute', boardDelta, failedOperationId, remainingOperationIds }),
    nextAction: 'Read the exact live objects for the failed operation, remove already confirmed operation IDs, prepare a new guard, and execute only the remaining plan suffix. Do not replay the full plan.',
  };
}

const preparedChecks = new Map();
const failedBatches = new Map();
const preparedKey = (sha, expected) => JSON.stringify([sha,expected.generationId,expected.bridgeGenerationId,expected.changeEpoch,expected.sourceHash]);
async function checkLivePlan(normalized,session,expected,bridgeUrl) {
  const snapshot=(await readPcb({kind:'auditSnapshot',target:normalized.target},{bridgeUrl})).result;
  await session.rpc('events.getState',{}, { expected: expectedForRpc(expected) });
  return assertPreflightClear(preflightGeometry(normalized,snapshot));
}
/** Geometry-only read modes share the executor's identity and native geometry matching. */
export async function runPlan(source, { kind = 'geometry', mode = 'execute', guard, executionId, bridgeUrl } = {}) {
  if (!['geometry', 'text'].includes(kind) || !(kind==='geometry'?['build','reconcile','validate','prepare','execute']:['validate','prepare','execute']).includes(mode)) throw gatewayError('INVALID_REQUEST', 'Unknown plan kind or mode');
  const input = kind === 'geometry' ? await loadPlanSource(source) : null;
  if(mode==='build'){
    const target=input.raw?.target;
    if(!target?.projectUuid||!target?.windowId||!target?.documentUuid)throw gatewayError('INVALID_REQUEST','Build requires the exact plan target');
    const session=await connectGateway({target,bridgeUrl,requireV2:true}),expected=await prepareGatewayState(session);
    const snapshot=(await readPcb({kind:'auditSnapshot',target},{bridgeUrl})).result;
    const needed=[...new Set((input.raw.operations??[]).map(op=>String(op.type).split('.')[0]).filter(kind=>kind==='pour'||kind==='polyline').map(kind=>kind==='pour'?'pours':'polylines'))];
    if(needed.length){const extra=(await readPcb({kind:'snapshot',include:needed,target},{bridgeUrl})).result;for(const key of needed){if(!Array.isArray(extra[key]))throw gatewayError('PLAN_CONSTRUCTION_FAILED','Required native inventory unavailable',{kind:key});snapshot[key]=extra[key];}}
    await session.rpc('events.getState',{}, { expected: expectedForRpc(expected) });
    return {ok:true,mode,source:input.source,...buildExplicitPlan(input.raw,snapshot),expected,boardProgressCredited:false};
  }
  if (input?.raw?.schema === 'easyeda-pcb-keepout-plan/v1') return runKeepoutPlan(input, { mode, guard, executionId, bridgeUrl });
  const validated = kind === 'geometry' ? await validatePlanSource({ plan: input.raw }) : await validateTextPlanSource(source);
  if (input) validated.loaded = input;
  const { loaded, normalized, summary } = validated;
  const transport = kind === 'geometry' ? prepareGeometryTransport(loaded.raw) : null;
  const planSha256 = hashObject(loaded.raw);
  if (mode === 'validate') return { ok: true, mode, source: loaded.source, planSha256, summary, wrotePCB: false, workflowReceipt: createWorkflowReceipt({ mode }) };
  if(mode==='reconcile'){
    const session=await connectGateway({target:normalized.target,bridgeUrl,requireV2:true}),expected=await prepareGatewayState(session);
    const job={mode:'reconcile',target:normalized.target,toleranceMil:normalized.options.toleranceMil,operations:normalized.operations};
    const readPass=async()=>{const results=[];for(let offset=0;offset<job.operations.length;offset+=100){const response=await executeBridgeCode(session.bridge,buildBatchCode({...job,operations:job.operations.slice(offset,offset+100)}));if(!response?.ok)throw gatewayError('RECONCILIATION_UNVERIFIED','Native object reconciliation incomplete',{response});results.push(...response.results);}return {ok:true,results};};
    const first=await readPass();
    const second=await readPass();
    if(!first?.ok||!second?.ok)throw gatewayError('RECONCILIATION_UNVERIFIED','Native object reconciliation was incomplete',{first,second});
    if(JSON.stringify(first)!==JSON.stringify(second))throw gatewayError('CONCURRENT_CHANGE','Exact plan objects changed during reconciliation');
    await session.rpc('events.getState',{}, { expected: expectedForRpc(expected) });
    const remaining=buildRemainingPlan(loaded.raw,normalized,second.results),failed=failedBatches.get(planSha256);
    let adaptiveBatch=null;
    if(remaining.remainingPlan&&failed&&['REQUEST_TIMEOUT','RESPONSE_TOO_LARGE','FILE_TOO_LARGE'].includes(failed.code)&&failed.batchSize>1){const next=Math.max(1,Math.floor(failed.batchSize/2));remaining.remainingPlan.options={...remaining.remainingPlan.options,batchSize:next};adaptiveBatch={previous:failed.batchSize,next,reason:failed.code,scope:'only independently observed pending operations; no automatic replay'};}
    return {ok:true,mode,source:loaded.source,target:normalized.target,planSha256,expected,...remaining,adaptiveBatch,observations:second.results,readOnly:true,wrotePCB:false,boardProgressCredited:false,saved:'NOT_EVALUATED',meaning:'APPLIED means matching current objects, not new writes by this call; prepare the returned remainder before execution'};
  }
  if (mode === 'prepare') {
    const session = await connectGateway({ target: normalized.target, bridgeUrl, requireV2: true });
    if (kind === 'geometry' && normalized.operations.some(op => op.kind === 'via' && !op.type.endsWith('.delete'))) {
      const capabilities = (await session.rpc('system.capabilities', {}, {windowOnly:true})).result;
      verifyNativeViaPrecision(normalized, capabilities.clientVersion);
    }
    const expected = await prepareGatewayState(session);
    const preflight=kind==='geometry'?await checkLivePlan(normalized,session,expected,bridgeUrl):null;
    if(preflight){const key=preparedKey(planSha256,expected);preparedChecks.set(key,{preflight,createdAt:Date.now()});while(preparedChecks.size>16)preparedChecks.delete(preparedChecks.keys().next().value);}
    return { ok: true, mode, source: loaded.source, summary, preflight, wrotePCB: false, guard: { schema: 'easyeda-pcb-guard/v1', planSha256, target: session.target, expected }, eventCoverage: expected.eventCoverage, nativeTransaction: false, workflowReceipt: createWorkflowReceipt({ mode }) };
  }
  assertGuardMatchesPlan(guard, loaded.raw, normalized);
  return runGuardedNative({ target: guard.target, expected: guard.expected, executionId, bridgeUrl }, async () => {
    let preflight=null;
    if(kind==='geometry'){
      const key=preparedKey(planSha256,guard.expected),cached=preparedChecks.get(key);
      if(cached&&Date.now()-cached.createdAt<300000)preflight=cached.preflight;
      else {const session=await connectGateway({target:guard.target,bridgeUrl,requireV2:true});preflight=await checkLivePlan(normalized,session,guard.expected,bridgeUrl);}
      assertPreflightClear(preflight);preparedChecks.delete(key);
    }
    if (kind === 'geometry' && normalized.operations.some(op => op.kind === 'via' && !op.type.endsWith('.delete'))) {
      const capabilities = (await contextRpc('system.capabilities', {})).result;
      verifyNativeViaPrecision(normalized, capabilities.clientVersion);
    }
    const size = resolveProtectedBatchSize(normalized);
    const useBridgeGeometryRuntime = requiresBridgeGeometryRuntime(kind, normalized.operations);
    const results = [];
    let batches = 0, saves = 0, circularReadbackObjects = 0;
    const attemptedOperationIds=[];
    try {
      for (let offset = 0; offset < normalized.operations.length; offset += size) {
        const operations = normalized.operations.slice(offset, offset + size);
        let batchResult;
        attemptedOperationIds.push(...operations.map(op=>op.id));
        if (useBridgeGeometryRuntime) {
          const adapter = await contextVerifiedPublicWrite('pcb.geometryLegacy', async (context, expected) => {
            const result = await executeBridgeCode(context.session.bridge, buildBatchCode({ target: normalized.target, toleranceMil: normalized.options.toleranceMil, operations }));
            let observed;
            try{observed=await prepareGatewayState(context.session);}catch(error){error.details={...(error.details??{}),observedBatchResult:result,observedOperationIds:verifiedContiguousPrefix(operations,result?.results).map(r=>r.id)};throw error;}
            return { ok: true, sourceBefore: { sha256: expected.sourceHash }, sourceAfter: { sha256: observed.sourceHash }, batchResult: result };
          });
          batchResult = adapter.batchResult;
        } else {
          const response = await contextRpc(kind === 'geometry' ? 'pcb.applyGeometryBatch' : 'pcb.applyTextBatch', { plan: transport?.wirePlan ?? loaded.raw, operationOffset: offset, maxOperations: size }, { write: true });
          batchResult = response.result;
        }
        const verifiedPrefix = verifiedContiguousPrefix(operations,batchResult?.results);
        if (!batchResult?.ok || verifiedPrefix.length!==operations.length) {
          results.push(...verifiedPrefix);
          if (verifiedPrefix.length && normalized.options.saveAfterBatch) { await contextRpc('pcb.save', {}, { write: true }); saves++; }
          const failedOperationId = batchResult?.error?.operationId ?? operations[verifiedPrefix.length]?.id ?? null;
          const failureCode = batchResult?.error?.code ?? null;
          const overlapBlocked = failureCode === 'PAD_OVERLAP_BLOCKED';
          throw gatewayError(overlapBlocked && verifiedPrefix.length === 0 ? 'PAD_OVERLAP_BLOCKED' : 'PARTIAL_SUCCESS', overlapBlocked
            ? 'A placement batch was blocked by physical pad overlap. Keep the verified prefix, replan the conflicting placement, and do not begin another placement round.'
            : 'A plan batch stopped after a verified prefix. Reconcile the failed object and continue only the remaining suffix.', {
            outcome: verifiedPrefix.length ? 'partial' : 'no-confirmed-change',
            response: batchResult,
            blockingCause: failureCode,
            padOverlapGate: summarizePadOverlapGate(normalized, results, failureCode),
            ...continuationDetails(normalized, results, failedOperationId),
          });
        }
        // Preserve the native verified prefix even when later circular checks or save fail.
        results.push(...verifiedPrefix);
        if (transport?.circles.length) {
          const requests = circularReadbackRequests(operations, batchResult.results);
          for (const request of requests) {
            const read = await contextRpc('pcb.read', {request:{...request, offset:0, limit:2000}});
            if (read.result?.hasMore || read.result?.total !== request.ids.length) throw gatewayError('PARTIAL_SUCCESS', 'Circular keepout readback is incomplete; inspect written copper', {response:batchResult});
            try {
              const checked = verifyCircularCopperReadback(transport.circles, request.kind, request.ids, read.result.items);
              circularReadbackObjects += checked.checkedObjects;
            } catch (error) {
              throw gatewayError('PARTIAL_SUCCESS', error.message, {writtenBatch:batchResult, requiresReadbackBeforeRetry:true});
            }
          }
        }
        batches++;
        if (normalized.options.saveAfterBatch) { await contextRpc('pcb.save', {}, { write: true }); saves++; }
      }
      if (!normalized.options.saveAfterBatch) { await contextRpc('pcb.save', {}, { write: true }); saves++; }
      const boardDelta = summarizeBoardDelta(normalized, results, []);
      const padOverlapGate = summarizePadOverlapGate(normalized, results);
      return { ok: true, mode, source: loaded.source, planSha256, summary, preflight, completedOperationCount: results.length, batchCount: batches, saveCount: saves, executionLedger:executionLedger(normalized,results,[],attemptedOperationIds,'SAVED'), boardDelta, padOverlapGate, workflowReceipt: createWorkflowReceipt({ mode, boardDelta }), checkpoint:{target:normalized.target,phase:normalized.phase,confirmedOperationIds:results.map(r=>r.id),remainingOperationIds:[],saveCount:saves}, ...(transport ? {constraintEnforcement:{...transport.enforcement, circularReadbackObjects}} : {}), requiresRepour: results.some(item => item.requiresRepour), requiresVisualReview: true, results };
    } catch (error) {
      failedBatches.set(planSha256,{batchSize:size,code:error.code});while(failedBatches.size>16)failedBatches.delete(failedBatches.keys().next().value);
      error.details={...(error.details??{}),executionLedger:executionLedger(normalized,results,error.details?.observedOperationIds??[],attemptedOperationIds,'UNKNOWN_OR_PARTIAL'),saveCount:saves};
      const failedOperationId = error.details?.failedOperationId ?? error.details?.response?.error?.operationId ?? null;
      const failureCode = error.code === 'PAD_OVERLAP_BLOCKED' ? error.code : error.details?.response?.error?.code ?? null;
      error.details = { ...(error.details ?? {}), padOverlapGate: error.details?.padOverlapGate ?? summarizePadOverlapGate(normalized, results, failureCode), ...continuationDetails(normalized, results, failedOperationId), confirmedBatchCount: batches, source: loaded.source, planSha256, checkpoint:{target:normalized.target,phase:normalized.phase,confirmedOperationIds:results.map(r=>r.id),observedOperationIds:error.details?.observedOperationIds??[],requiresReconcile:true}, nextAction:'Call pcb_execute_plan mode=reconcile with the original plan; do not replay verified or observed writes. Prepare only the returned remainingPlan.' };
      throw error;
    }
  });
}

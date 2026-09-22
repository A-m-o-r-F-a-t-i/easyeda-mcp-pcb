import { executeBridgeCode, loadPlanSource, validatePlanSource } from './bridge.mjs';
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

/** One public plan tool, three explicit phases; validators and guard preparation remain internal. */
export async function runPlan(source, { kind = 'geometry', mode = 'execute', guard, executionId, bridgeUrl } = {}) {
  if (!['geometry', 'text'].includes(kind) || !['validate', 'prepare', 'execute'].includes(mode)) throw gatewayError('INVALID_REQUEST', 'Unknown plan kind or mode');
  const input = kind === 'geometry' ? await loadPlanSource(source) : null;
  if (input?.raw?.schema === 'easyeda-pcb-keepout-plan/v1') return runKeepoutPlan(input, { mode, guard, executionId, bridgeUrl });
  const validated = kind === 'geometry' ? await validatePlanSource({ plan: input.raw }) : await validateTextPlanSource(source);
  if (input) validated.loaded = input;
  const { loaded, normalized, summary } = validated;
  const transport = kind === 'geometry' ? prepareGeometryTransport(loaded.raw) : null;
  const planSha256 = hashObject(loaded.raw);
  if (mode === 'validate') return { ok: true, mode, source: loaded.source, planSha256, summary, wrotePCB: false, workflowReceipt: createWorkflowReceipt({ mode }) };
  if (mode === 'prepare') {
    const session = await connectGateway({ target: normalized.target, bridgeUrl, requireV2: true });
    if (kind === 'geometry' && normalized.operations.some(op => op.kind === 'via' && !op.type.endsWith('.delete'))) {
      const capabilities = (await session.rpc('system.capabilities', {}, {windowOnly:true})).result;
      verifyNativeViaPrecision(normalized, capabilities.clientVersion);
    }
    const expected = await prepareGatewayState(session);
    return { ok: true, mode, source: loaded.source, summary, wrotePCB: false, guard: { schema: 'easyeda-pcb-guard/v1', planSha256, target: session.target, expected }, eventCoverage: expected.eventCoverage, nativeTransaction: false, workflowReceipt: createWorkflowReceipt({ mode }) };
  }
  assertGuardMatchesPlan(guard, loaded.raw, normalized);
  return runGuardedNative({ target: guard.target, expected: guard.expected, executionId, bridgeUrl }, async () => {
    if (kind === 'geometry' && normalized.operations.some(op => op.kind === 'via' && !op.type.endsWith('.delete'))) {
      const capabilities = (await contextRpc('system.capabilities', {})).result;
      verifyNativeViaPrecision(normalized, capabilities.clientVersion);
    }
    const size = Math.min(normalized.options.batchSize, 24);
    const useLegacyGeometry = kind === 'geometry' && normalized.operations.some(op => ['arc', 'polyline', 'pad', 'fill', 'stackup'].includes(op.kind));
    const results = [];
    let batches = 0, saves = 0, circularReadbackObjects = 0;
    try {
      for (let offset = 0; offset < normalized.operations.length; offset += size) {
        const operations = normalized.operations.slice(offset, offset + size);
        let batchResult;
        if (useLegacyGeometry) {
          const adapter = await contextVerifiedPublicWrite('pcb.geometryLegacy', async (context, expected) => {
            const result = await executeBridgeCode(context.session.bridge, buildBatchCode({ target: normalized.target, toleranceMil: normalized.options.toleranceMil, operations }));
            const observed = await prepareGatewayState(context.session);
            return { ok: true, sourceBefore: { sha256: expected.sourceHash }, sourceAfter: { sha256: observed.sourceHash }, batchResult: result };
          });
          batchResult = adapter.batchResult;
        } else {
          const response = await contextRpc(kind === 'geometry' ? 'pcb.applyGeometryBatch' : 'pcb.applyTextBatch', { plan: transport?.wirePlan ?? loaded.raw, operationOffset: offset, maxOperations: size }, { write: true });
          batchResult = response.result;
        }
        const verifiedPrefix = Array.isArray(batchResult?.results) ? batchResult.results.filter(item => item?.verified === true) : [];
        if (!batchResult?.ok || !Array.isArray(batchResult.results) || batchResult.results.some(item => item.verified !== true)) {
          results.push(...verifiedPrefix);
          if (verifiedPrefix.length && normalized.options.saveAfterBatch) { await contextRpc('pcb.save', {}, { write: true }); saves++; }
          const failedOperationId = batchResult?.error?.operationId ?? operations[verifiedPrefix.length]?.id ?? null;
          throw gatewayError('PARTIAL_SUCCESS', 'A plan batch stopped after a verified prefix. Reconcile the failed object and continue only the remaining suffix.', {
            outcome: verifiedPrefix.length ? 'partial' : 'no-confirmed-change',
            response: batchResult,
            ...continuationDetails(normalized, results, failedOperationId),
          });
        }
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
        results.push(...batchResult.results);
        batches++;
        if (normalized.options.saveAfterBatch) { await contextRpc('pcb.save', {}, { write: true }); saves++; }
      }
      if (!normalized.options.saveAfterBatch) { await contextRpc('pcb.save', {}, { write: true }); saves++; }
      const boardDelta = summarizeBoardDelta(normalized, results, []);
      return { ok: true, mode, source: loaded.source, planSha256, summary, completedOperationCount: results.length, batchCount: batches, saveCount: saves, boardDelta, workflowReceipt: createWorkflowReceipt({ mode, boardDelta }), ...(transport ? {constraintEnforcement:{...transport.enforcement, circularReadbackObjects}} : {}), requiresRepour: results.some(item => item.requiresRepour), requiresVisualReview: true, results };
    } catch (error) {
      const failedOperationId = error.details?.failedOperationId ?? error.details?.response?.error?.operationId ?? null;
      error.details = { ...(error.details ?? {}), ...continuationDetails(normalized, results, failedOperationId), confirmedBatchCount: batches, source: loaded.source, planSha256 };
      throw error;
    }
  });
}

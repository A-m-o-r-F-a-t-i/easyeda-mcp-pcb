import { contextRpc, contextVerifiedObservedWrite, executionContextFor } from './execution-context.mjs';
import {evaluateSyncExpectations,validateSyncExpectations} from './sync-expectations.mjs';
import crypto from 'node:crypto';
import { buildConstraintCode } from './constraint-runtime.mjs';
import { assertAllowedTarget, executeBridgeCode, loadPlanSource, resolveBridge, saveDocument } from './bridge.mjs';
import { buildPcbToolsCode } from './pcb-tools-runtime.mjs';
import { textPlanSummary, validateTextPlan } from './text-plan.mjs';
import { buildTextBatchCode } from './text-runtime.mjs';

const DEFAULT_TIMEOUT_MS = 65_000;
const LONG_TIMEOUT_MS = 180_000;

function fail(message, details) {
  const error = new Error(message);
  if (details !== undefined) error.details = details;
  throw error;
}

function batchesOf(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function snapshotDigest(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(snapshot))).digest('hex');
}

async function callPcbTools(request, { bridgeUrl = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  assertAllowedTarget(request.target);
  const context = executionContextFor(request.target);
  const write = ['rebuildPours', 'importChanges', 'realTimeDrc'].includes(request.kind);
  // EasyEDA V4.1.60 requires the MCP-owned import runtime to complete the native confirmation dialog.
  // Execute that one write directly, then advance the guarded state only after Protocol v2 observes a new epoch and source hash.
  if (context && request.kind === 'importChanges') {
    return contextVerifiedObservedWrite('pcb.importChanges', async () => ({
      bridge: context.session.bridge,
      result: await executeBridgeCode(context.session.bridge, buildPcbToolsCode(request), timeoutMs),
    }));
  }
  if (context) return { bridge: context.session.bridge, result: (await contextRpc('pcb.nativeTools', { request }, { write })).result };
  if (!write && request.target?.windowId && request.target?.projectUuid) {
    const { connectGateway } = await import('./gateway-client.mjs');
    const session = await connectGateway({ target: request.target, bridgeUrl });
    if (session.protocolVersion === 2) return { bridge: session.bridge, result: (await session.rpc('pcb.nativeTools', { request })).result };
  }
  const bridge = await resolveBridge({ bridgeUrl, windowId: request.target?.windowId, requireEda: true });
  return {
    bridge,
    result: await executeBridgeCode(bridge, buildPcbToolsCode(request), timeoutMs),
  };
}

async function callConstraint(request, { bridgeUrl = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  assertAllowedTarget(request.target);
  const context = executionContextFor(request.target);
  const write = request.kind === 'manage';
  if (context) return { bridge: context.session.bridge, result: (await contextRpc('pcb.constraints', { request }, { write })).result };
  if (!write && request.target?.windowId && request.target?.projectUuid) {
    const { connectGateway } = await import('./gateway-client.mjs');
    const session = await connectGateway({ target: request.target, bridgeUrl });
    if (session.protocolVersion === 2) return { bridge: session.bridge, result: (await session.rpc('pcb.constraints', { request })).result };
  }
  const bridge = await resolveBridge({ bridgeUrl, windowId: request.target?.windowId, requireEda: true });
  return {
    bridge,
    result: await executeBridgeCode(bridge, buildConstraintCode(request), timeoutMs),
  };
}

export async function getPcbCapabilities({ target, bridgeUrl = null }) {
  const response = await callPcbTools({ kind: 'capabilities', target }, { bridgeUrl });
  return { ok: true, bridge: { baseUrl: response.bridge.baseUrl, windowId: response.bridge.windowId }, ...response.result };
}

export async function pickPcbPrimitives({ target, units, point, region, offset, limit, bridgeUrl = null }) {
  if ((point == null) === (region == null)) fail('Provide exactly one of point or region');
  const request = point
    ? { kind: 'pick', mode: 'point', target, units, point }
    : { kind: 'pick', mode: 'region', target, units, region, offset, limit };
  const response = await callPcbTools(request, { bridgeUrl });
  return { ok: true, bridge: { baseUrl: response.bridge.baseUrl, windowId: response.bridge.windowId }, ...response.result };
}

export async function rebuildPours({ target, pourIds, allowCollateralRebuild = false, save = true, bridgeUrl = null }) {
  const response = await callPcbTools({ kind: 'rebuildPours', target, pourIds, allowCollateralRebuild }, { bridgeUrl, timeoutMs: LONG_TIMEOUT_MS });
  const saved = save ? await saveDocument(response.bridge, target) : null;
  return {
    ok: true,
    bridge: { baseUrl: response.bridge.baseUrl, windowId: response.bridge.windowId },
    saved,
    ...response.result,
  };
}

export async function controlRealTimeDrc({ target, action, bridgeUrl = null }) {
  const response = await callPcbTools({ kind: 'realTimeDrc', target, action }, { bridgeUrl });
  return { ok: true, bridge: { baseUrl: response.bridge.baseUrl, windowId: response.bridge.windowId }, ...response.result };
}

export async function readConstraints({ target, bridgeUrl = null }) {
  const response = await callConstraint({ kind: 'read', target }, { bridgeUrl });
  return { ok: true, bridge: { baseUrl: response.bridge.baseUrl, windowId: response.bridge.windowId }, ...response.result };
}

export async function manageConstraintGroup({ target, operation, save = true, bridgeUrl = null }) {
  const response = await callConstraint({ kind: 'manage', target, operation }, { bridgeUrl });
  const saved = save ? await saveDocument(response.bridge, target) : null;
  return { ok: true, bridge: { baseUrl: response.bridge.baseUrl, windowId: response.bridge.windowId }, saved, ...response.result };
}

export async function validateTextPlanSource(source) {
  const loaded = await loadPlanSource(source);
  const normalized = validateTextPlan(loaded.raw);
  return { loaded, normalized, summary: textPlanSummary(normalized) };
}

export async function executeTextPlanSource(source, { bridgeUrl = null } = {}) {
  const { loaded, normalized, summary } = await validateTextPlanSource(source);
  assertAllowedTarget(normalized.target);
  const bridge = await resolveBridge({ bridgeUrl, windowId: normalized.target.windowId, requireEda: true });
  const batches = batchesOf(normalized.operations, normalized.options.batchSize);
  const results = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batchResult = await executeBridgeCode(bridge, buildTextBatchCode({
      target: normalized.target,
      toleranceMil: normalized.options.toleranceMil,
      operations: batches[batchIndex],
    }));
    results.push(...(batchResult?.results ?? []));
    if (!batchResult?.ok) fail(`PCB text plan stopped in batch ${batchIndex + 1}: ${batchResult?.error?.message ?? 'unknown operation error'}`, {
      source: loaded.source,
      summary,
      batchIndex,
      completedOperationCount: results.length,
      results,
      error: batchResult?.error ?? null,
    });
    if (normalized.options.saveAfterBatch) await saveDocument(bridge, normalized.target);
  }
  if (!normalized.options.saveAfterBatch) await saveDocument(bridge, normalized.target);
  return {
    ok: true,
    source: loaded.source,
    bridge: { baseUrl: bridge.baseUrl, windowId: bridge.windowId },
    summary,
    batchCount: batches.length,
    completedOperationCount: results.length,
    resultCounts: results.reduce((counts, item) => { counts[item.status] = (counts[item.status] ?? 0) + 1; return counts; }, {}),
    requiresVisualAndManufacturingCheck: true,
    results,
  };
}

export async function readSchematicSyncState({ target, bridgeUrl = null }) {
  const response = await callPcbTools({ kind: 'syncSnapshot', target }, { bridgeUrl, timeoutMs: LONG_TIMEOUT_MS });
  return {
    bridge: response.bridge,
    snapshot: response.result.snapshot,
    digest: snapshotDigest(response.result.snapshot),
    runtimeHash: response.result.runtimeHash,
    association: response.result.snapshot.association,
    counts: response.result.counts,
  };
}

export async function prepareSchematicSync({ target, bridgeUrl = null }) {
  const state = await readSchematicSyncState({ target, bridgeUrl });
  return {
    ok: true,
    bridge: { baseUrl: state.bridge.baseUrl, windowId: state.bridge.windowId },
    digest: state.digest,
    runtimeHash: state.runtimeHash,
    association: state.association,
    counts: state.counts,
    limitations: [
      'The public API exposes importChanges but not a typed change-preview list.',
      'This digest guards the PCB state used for preflight; it does not prove schematic electrical correctness.',
      'Import may preserve old copper. Re-read affected pads, traces, pours, rules, and silkscreen after import.',
    ],
  };
}

export async function importSchematicChanges({ target, schematicUuid, expectedBeforeDigest, expectedAfter, save = true, bridgeUrl = null }) {
  validateSyncExpectations(expectedAfter);
  const preflight = await callPcbTools({ kind: 'syncSnapshot', target }, { bridgeUrl, timeoutMs: LONG_TIMEOUT_MS });
  const actualBeforeDigest = snapshotDigest(preflight.result.snapshot);
  evaluateSyncExpectations(preflight.result.snapshot,expectedAfter); // Validate the goal before native writes, without requiring it to already match.
  if (actualBeforeDigest !== expectedBeforeDigest.toLowerCase()) fail('PCB state changed or digest is stale; run pcb_prepare_schematic_sync again', {
    expectedBeforeDigest,
    actualBeforeDigest,
  });
  if (preflight.result.snapshot.association.schematicUuid !== schematicUuid) fail('Associated schematic UUID mismatch', {
    expected: preflight.result.snapshot.association.schematicUuid,
    received: schematicUuid,
  });
  const response = await callPcbTools({
    kind: 'importChanges',
    target,
    schematicUuid,
    expectedRuntimeHash: preflight.result.runtimeHash,
  }, { bridgeUrl, timeoutMs: LONG_TIMEOUT_MS });
  const beforeDigest = snapshotDigest(response.result.before.snapshot);
  const afterDigest = snapshotDigest(response.result.after.snapshot);
  if (beforeDigest !== expectedBeforeDigest.toLowerCase()) fail('Runtime preflight digest changed before import; inspect current PCB state', { beforeDigest, expectedBeforeDigest });
  const changed = beforeDigest !== afterDigest;
  if (response.result.imported !== true || !changed) fail('EasyEDA accepted importChanges but no schematic changes were applied to the PCB', {
    nativeAccepted: response.result.nativeAccepted === true,
    confirmationUiAvailable: response.result.confirmationUiAvailable === true,
    confirmationRequired: response.result.confirmationRequired === true,
    confirmationApplied: response.result.confirmationApplied === true,
    imported: response.result.imported === true,
    savedByTool: false,
    beforeDigest,
    afterDigest,
    requiresReadbackBeforeRetry: true,
  });
  const postconditions=evaluateSyncExpectations(response.result.after.snapshot,expectedAfter);
  if(postconditions.verified===false)fail('ECO import changed the PCB but explicit postconditions were not met; inspect and reconcile the current PCB',{imported:true,savedByTool:false,beforeDigest,afterDigest,postconditions,requiresReconciliation:true});
  const saved = save ? await saveDocument(response.bridge, target) : null;
  return {
    ok: true,
    bridge: { baseUrl: response.bridge.baseUrl, windowId: response.bridge.windowId },
    postconditions,
    postconditionsVerified:postconditions.verified,
    nativeAccepted: response.result.nativeAccepted === true,
    confirmationUiAvailable: response.result.confirmationUiAvailable === true,
    confirmationRequired: response.result.confirmationRequired === true,
    confirmationApplied: response.result.confirmationApplied === true,
    imported: true,
    saved,
    association: response.result.after.snapshot.association,
    beforeDigest,
    afterDigest,
    changed,
    beforeCounts: Object.fromEntries(Object.entries(response.result.before.snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
    afterCounts: Object.fromEntries(Object.entries(response.result.after.snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
    requiresCopperAndSilkscreenReconciliation: true,
    note: 'The API call completed and the PCB state was re-read. This does not approve retained copper, connectivity, DRC, or user-facing silkscreen.',
  };
}

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { connectGateway, gatewayError, prepareGatewayState } from './gateway-client.mjs';
import { createRecoveryDirective } from './workflow-receipt.mjs';

const storage = new AsyncLocalStorage();
export function expectedForRpc(state) {
  if (!state || typeof state.generationId !== 'string' || typeof state.bridgeGenerationId !== 'string' || !Number.isSafeInteger(state.changeEpoch) || state.changeEpoch < 0 || !/^[0-9a-f]{64}$/.test(state.sourceHash ?? '')) throw gatewayError('INVALID_REQUEST', 'A prepared generation/epoch/source state is required');
  return { generationId: state.generationId, bridgeGenerationId: state.bridgeGenerationId, changeEpoch: state.changeEpoch, sourceHash: state.sourceHash };
}
export function executionContextFor(target) {
  const context = storage.getStore();
  if (!context) return null;
  for (const key of ['windowId', 'projectUuid', 'documentUuid']) {
    if (target?.[key] !== context.session.target[key]) throw gatewayError('TARGET_CHANGED', 'Nested operation attempted to change the guarded target');
  }
  return context;
}
export async function contextRpc(operation, args = {}, { write = false } = {}) {
  const context = storage.getStore();
  if (!context) throw gatewayError('INVALID_REQUEST', 'No guarded native execution context');
  const executionId = write ? `${context.executionId}:${context.sequence++}:${operation}` : null;
  const response = await context.session.rpc(operation, { ...args, ...(executionId ? { executionId } : {}) }, { expected: context.expected });
  if (write) {
    const source = response.result?.sourceAfter?.sha256;
    if (!/^[0-9a-f]{64}$/.test(source ?? '')) throw gatewayError('PARTIAL_SUCCESS', 'Write returned without a verified source hash; read actual state', { outcome: 'unknown', executionId });
    context.expected = expectedForRpc({ generationId: response.state.generationId, changeEpoch: response.state.changeEpochAfter, sourceHash: source, bridgeGenerationId: response.bridgeGenerationId });
    context.operations.push({ operation, executionId, replayed: response.replayed === true });
  }
  return response;
}

/** Internal public-API adapters must attest both source hashes before advancing state. */
export function validatePublicWriteTransition(before, result, observed) {
  if (result?.ok !== true || result.sourceBefore?.sha256 !== before.sourceHash || !/^[0-9a-f]{64}$/.test(result.sourceAfter?.sha256 ?? '')) throw gatewayError('PARTIAL_SUCCESS', 'Public API adapter returned no verified source transition');
  for (const key of ['generationId', 'bridgeGenerationId']) if (observed[key] !== before[key]) throw gatewayError('GENERATION_MISMATCH', 'Gateway restarted during public API adapter');
  if (observed.changeEpoch < before.changeEpoch || observed.sourceHash !== result.sourceAfter.sha256) throw gatewayError('PARTIAL_SUCCESS', 'Observed state differs from adapter readback; do not adopt it');
  return expectedForRpc(observed);
}

export async function contextVerifiedPublicWrite(operation, adapter) {
  const context = storage.getStore();
  if (!context) throw gatewayError('INVALID_REQUEST', 'No guarded public API execution context');
  if (!['pcb.keepoutRecords','pcb.geometryLegacy','pcb.componentCleanup'].includes(operation)) throw gatewayError('INVALID_REQUEST', 'Unsupported internal public API adapter');
  const expected = { ...context.expected };
  await context.session.rpc('events.getState', {}, { expected });
  const executionId = `${context.executionId}:${context.sequence++}:${operation}`;
  const result = await adapter(context, expected);
  const observed = await prepareGatewayState(context.session);
  context.expected = validatePublicWriteTransition(expected, result, observed);
  context.operations.push({ operation, executionId, replayed: false, transport: 'verified-public-api-with-v2-state', nativeTransaction: false });
  return result;
}

/** Adopt a direct native write only when Protocol v2 independently observes a new epoch and source hash. */
export function validateObservedWriteTransition(before, observed) {
  for (const field of ['generationId', 'bridgeGenerationId']) {
    if (observed?.[field] !== before?.[field]) throw gatewayError('GENERATION_MISMATCH', 'Gateway restarted during observed native write');
  }
  if (!Number.isSafeInteger(observed?.changeEpoch) || observed.changeEpoch <= before.changeEpoch || observed.sourceHash === before.sourceHash) {
    throw gatewayError('PARTIAL_SUCCESS', 'Native write returned without an independently observed document change; read actual state before retrying', {
      before: { changeEpoch: before.changeEpoch, sourceHash: before.sourceHash },
      observed: { changeEpoch: observed?.changeEpoch ?? null, sourceHash: observed?.sourceHash ?? null },
      outcome: 'unknown',
    });
  }
  return expectedForRpc(observed);
}

export async function contextVerifiedObservedWrite(operation, adapter) {
  const context = storage.getStore();
  if (!context) throw gatewayError('INVALID_REQUEST', 'No guarded observed-write execution context');
  if (operation !== 'pcb.importChanges') throw gatewayError('INVALID_REQUEST', 'Unsupported observed native write');
  const expected = { ...context.expected };
  await context.session.rpc('events.getState', {}, { expected });
  const executionId = `${context.executionId}:${context.sequence++}:${operation}`;
  const result = await adapter(context, expected);
  const observed = await prepareGatewayState(context.session);
  context.expected = validateObservedWriteTransition(expected, observed);
  context.operations.push({ operation, executionId, replayed: false, transport: 'verified-observed-native-write', nativeTransaction: false });
  return result;
}

/** Scope guards across native mutation + save; no error branch silently falls back to v1. */
export async function runGuardedNative({ target, expected, executionId, bridgeUrl }, operation) {
  const state = expectedForRpc(expected);
  const context = { session: null, expected: state, executionId: executionId ?? crypto.randomUUID(), sequence: 0, operations: [] };
  try {
    context.session = await connectGateway({ target, bridgeUrl, requireV2: true });
    await context.session.rpc('events.getState', {}, { expected: state });
    return await storage.run(context, async () => {
      const result = await operation();
      await context.session.rpc('events.getState', {}, { expected: context.expected });
      return { ...result, execution: { executionId: context.executionId, transport: 'typed-v2', operations: context.operations, finalExpected: context.expected, eventCoverage: expected.eventCoverage ?? 'partial', nativeTransaction: false } };
    });
  } catch (error) {
    const details = error?.details ?? {};
    const confirmedOperationNames = context.operations.map(item => item.operation);
    error.details = {
      ...details,
      executionId: context.executionId,
      confirmedOperations: context.operations,
      lastConfirmedExpected: context.expected,
      requiresReadbackBeforeRetry: true,
      recoveryDirective: createRecoveryDirective({
        errorCode: error?.code ?? 'UNKNOWN',
        executionId: context.executionId,
        failedOperationId: details.failedOperationId ?? details.response?.error?.operationId ?? null,
        remainingOperationIds: details.remainingOperationIds ?? [],
        confirmedOperationNames,
      }),
    };
    throw error;
  }
}

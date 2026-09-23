import { getPcbCapabilities, importSchematicChanges, prepareSchematicSync, readSchematicSyncState } from './advanced.mjs';
import { auditGeometry } from './audit.mjs';
import { inspectGroupQuality } from './group-quality.mjs';
import { readPcb, saveDocument } from './bridge.mjs';
import { analyzeConnectivity } from './connectivity.mjs';
import { connectGateway, gatewayError, hashObject, prepareGatewayState } from './gateway-client.mjs';
import { expectedForRpc, runGuardedNative } from './execution-context.mjs';
import { compareAssociatedNetlists } from './netlist-compare.mjs';
import { readNativeBoardInfo } from './native-board-info.mjs';
import { isWindowReconnectError, rediscoverExactPcbTarget } from './inspection.mjs';
import { VERSION as MCP_VERSION } from './plan.mjs';
import { evaluateSyncExpectations } from './sync-expectations.mjs';

export async function statusPcb({ target, include = [], bridgeUrl }) {
  const response = await readPcb({ kind: 'status', target }, { bridgeUrl });
  const session = await connectGateway({ target, bridgeUrl });
  const result = { ok: true, ...response, target: session.target, runtime: { mcpVersion: MCP_VERSION, protocolVersion: session.protocolVersion, gatewayVersion: session.gatewayVersion, bridgeVersion: session.bridge.health.bridgeVersion ?? 'legacy', bridgeGenerationId: session.bridge.health.bridgeGenerationId ?? null } };
  if (include.includes('capabilities')) result.capabilities = session.protocolVersion === 2 ? (await session.rpc('system.capabilities', {}, { windowOnly: true })).result : await getPcbCapabilities({ target, bridgeUrl });
  if (include.includes('nativeInfo')) result.nativeInfo = await readNativeBoardInfo({ target, bridgeUrl });
  if (include.includes('changeState')) result.expected = session.protocolVersion === 2 ? await prepareGatewayState(session) : { available: false, code: 'CLIENT_UNSUPPORTED', reason: 'Generation-bound state requires Protocol v2' };
  return result;
}

export async function auditPcb({ target, snapshot, checks = ['geometry'], toleranceMil, detailLimit = 100, net, nativeUnroutedCount, groups, referenceLayers, bridgeUrl }) {
  if ((target === undefined) === (snapshot === undefined)) throw gatewayError('INVALID_REQUEST', 'Provide exactly one of target or snapshot');
  if (snapshot !== undefined && bridgeUrl !== undefined) throw gatewayError('INVALID_REQUEST', 'bridgeUrl applies only to a live target');
  let data = snapshot, source = 'provided snapshot', session = null, expected = null;
  if (target) {
    session = await connectGateway({ target, bridgeUrl });
    if (session.protocolVersion === 2) expected = await prepareGatewayState(session);
    const response = await readPcb({ kind: 'auditSnapshot', target }, { bridgeUrl });
    data = response.result; source = { target: session.target, bridge: response.bridge };
    if (checks.includes('connectivity')) {
      data.coverage ??= {}; data.coverage.observedExcludedCounts = {};
      for (const kind of ['poured', 'regions']) {
        try { data.coverage.observedExcludedCounts[kind] = (await readPcb({ kind, target, limit: 1 }, { bridgeUrl })).result.total; }
        catch (error) {
          if (['TARGET_CHANGED', 'GENERATION_MISMATCH', 'EPOCH_MISMATCH', 'CONCURRENT_CHANGE', 'PERMISSION_DENIED'].includes(error.code)) throw error;
          data.coverage.observedExcludedCounts[kind] = { error: error.message };
        }
      }
    }
    if (expected) await session.rpc('events.getState', {}, { expected: expectedForRpc(expected) });
  }
  if (groups !== undefined && !checks.includes('groupQuality')) throw gatewayError('INVALID_REQUEST', 'groups require checks=groupQuality');
  const result = { ok: true, readOnly: true, source, checks };
  if (checks.includes('groupQuality')) result.groupQuality = inspectGroupQuality(data, { groups, referenceLayers, detailLimit });
  if (checks.includes('geometry')) result.geometry = auditGeometry(data, { toleranceMil, detailLimit });
  if (checks.includes('connectivity')) result.connectivity = analyzeConnectivity(data, { net, toleranceMm: toleranceMil === undefined ? undefined : toleranceMil * 0.0254, maxDetails: Math.min(detailLimit, 2000), nativeUnroutedCount });
  return result;
}

function countSnapshotArrays(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
}

function reconnectFailure(originalError, message, details) {
  originalError.details = {
    ...(originalError.details ?? {}),
    reconnectVerification: { message, ...details },
    requiresReadbackBeforeRetry: true,
  };
  return originalError;
}

export async function recoverSchematicImportAfterReconnect({
  target,
  bridgeUrl,
  schematicUuid,
  expectedBeforeDigest,
  expectedAfter,
  save,
  comparisonBefore,
  executionId,
  originalError,
}, overrides = {}) {
  if (!isWindowReconnectError(originalError)) throw originalError;
  const api = {
    rediscoverExactPcbTarget,
    readSchematicSyncState,
    compareAssociatedNetlists,
    saveDocument,
    connectGateway,
    prepareGatewayState,
    ...overrides,
  };
  const recovered = await api.rediscoverExactPcbTarget({ target, bridgeUrl });
  const recoveredTarget = recovered.target;
  const observed = await api.readSchematicSyncState({ target: recoveredTarget, bridgeUrl: recovered.bridgeUrl ?? bridgeUrl });
  if (observed.association?.schematicUuid !== schematicUuid) {
    throw reconnectFailure(originalError, 'Recovered PCB is associated with a different schematic', {
      expectedSchematicUuid: schematicUuid,
      actualSchematicUuid: observed.association?.schematicUuid ?? null,
      recoveredTarget,
    });
  }
  if (observed.digest === expectedBeforeDigest.toLowerCase()) {
    throw reconnectFailure(originalError, 'Recovered PCB still matches the pre-import digest; no requested change was verified', {
      expectedBeforeDigest,
      recoveredDigest: observed.digest,
      recoveredTarget,
    });
  }
  const postconditions = evaluateSyncExpectations(observed.snapshot, expectedAfter);
  if (postconditions.verified === false) {
    throw reconnectFailure(originalError, 'Recovered PCB changed, but explicit ECO postconditions were not met', {
      postconditions,
      recoveredDigest: observed.digest,
      recoveredTarget,
    });
  }
  const comparisonAfter = await api.compareAssociatedNetlists({
    target: recoveredTarget,
    expectedSchematicUuid: schematicUuid,
    offset: 0,
    limit: 1000,
    bridgeUrl: recovered.bridgeUrl ?? bridgeUrl,
  });
  if (comparisonAfter.inSync !== true) {
    throw reconnectFailure(originalError, 'Recovered PCB still differs from the associated schematic', {
      remainingDifferences: comparisonAfter.total,
      counts: comparisonAfter.counts,
      recoveredDigest: observed.digest,
      recoveredTarget,
    });
  }
  const saved = save ? await api.saveDocument(observed.bridge, recoveredTarget) : false;
  const finalState = await api.readSchematicSyncState({ target: recoveredTarget, bridgeUrl: recovered.bridgeUrl ?? bridgeUrl });
  if (finalState.digest !== observed.digest) {
    throw reconnectFailure(originalError, 'PCB changed again while reconnect verification and save were completing', {
      observedDigest: observed.digest,
      finalDigest: finalState.digest,
      recoveredTarget,
    });
  }
  const finalComparison = await api.compareAssociatedNetlists({
    target: recoveredTarget,
    expectedSchematicUuid: schematicUuid,
    offset: 0,
    limit: 1000,
    bridgeUrl: recovered.bridgeUrl ?? bridgeUrl,
  });
  if (finalComparison.inSync !== true) {
    throw reconnectFailure(originalError, 'Associated netlists diverged after reconnect verification', {
      remainingDifferences: finalComparison.total,
      counts: finalComparison.counts,
      recoveredTarget,
    });
  }
  const session = await api.connectGateway({ target: recoveredTarget, bridgeUrl: recovered.bridgeUrl ?? bridgeUrl, requireV2: true });
  const finalExpected = await api.prepareGatewayState(session);
  return {
    ok: true,
    mode: 'execute',
    target: session.target,
    wrotePCB: true,
    alreadyInSync: false,
    nativeAccepted: null,
    confirmationUiAvailable: null,
    confirmationRequired: null,
    confirmationApplied: null,
    imported: true,
    saved,
    association: finalState.association,
    beforeDigest: expectedBeforeDigest.toLowerCase(),
    afterDigest: finalState.digest,
    changed: true,
    beforeCounts: null,
    afterCounts: countSnapshotArrays(finalState.snapshot),
    postconditions,
    postconditionsVerified: postconditions.verified,
    comparisonBefore,
    comparisonAfter: finalComparison,
    recoveredAfterWindowReconnect: true,
    replayAvoided: true,
    recovery: {
      originalWindowId: target.windowId,
      recoveredWindowId: session.target.windowId,
      discoveryAttempt: recovered.attempt,
      verification: ['exact-project-document', 'changed-sync-digest', 'explicit-postconditions', 'associated-netlists-in-sync', 'post-save-stability'],
    },
    execution: {
      executionId,
      transport: 'verified-reconnect-readback',
      operations: [{ operation: 'pcb.importChanges', executionId, replayed: false, confirmation: 'final-state-readback' }],
      finalExpected,
      eventCoverage: finalExpected.eventCoverage ?? 'partial',
      nativeTransaction: false,
    },
    requiresCopperAndSilkscreenReconciliation: true,
    note: 'The native import response was lost when EasyEDA rebuilt its window connection. The write was not replayed; success is based on an exact target reconnect, changed digest, explicit postconditions, synchronized associated netlists, save, and stable final readback.',
  };
}

function semanticComparisonHash(comparison) {
  if (comparison.hasMore) throw gatewayError('FILE_TOO_LARGE', 'ECO comparison exceeds the guarded preview limit; preserve an unapproved state');
  // Bind only stable comparison data; wall-clock and transport metadata are excluded.
  const data = { ...comparison };
  for (const key of ['bridge', 'timestamp', 'checkedAt', 'durationMs']) delete data[key];
  return hashObject(data);
}
export async function synchronizePcb({ target, mode = 'preflight', schematicUuid, expectedBeforeDigest, expectedAfter, expected, expectedComparisonDigest, executionId, save = true, bridgeUrl }) {
  const session = await connectGateway({ target, bridgeUrl, requireV2: mode === 'execute' });
  if (mode === 'preflight') {
    const state = session.protocolVersion === 2 ? await prepareGatewayState(session) : null;
    const preflight = await prepareSchematicSync({ target, bridgeUrl });
    const comparison = await compareAssociatedNetlists({ target, expectedSchematicUuid: schematicUuid, offset: 0, limit: 1000, bridgeUrl });
    if (state) await session.rpc('events.getState', {}, { expected: expectedForRpc(state) });
    return { ...preflight, mode, target: session.target, wrotePCB: false, schematicUuid: preflight.association?.schematicUuid, expectedBeforeDigest: preflight.digest, expectedComparisonDigest: semanticComparisonHash(comparison), expected: state, comparison };
  }
  if (!schematicUuid || !expectedBeforeDigest || !expectedComparisonDigest) throw gatewayError('INVALID_REQUEST', 'ECO execution requires all fields returned by preflight');
  let comparisonBefore = null;
  try {
    return await runGuardedNative({ target: session.target, expected, executionId, bridgeUrl }, async () => {
      comparisonBefore = await compareAssociatedNetlists({ target: session.target, expectedSchematicUuid: schematicUuid, offset: 0, limit: 1000, bridgeUrl });
      if (semanticComparisonHash(comparisonBefore) !== expectedComparisonDigest) throw gatewayError('EPOCH_MISMATCH', 'Associated schematic comparison changed after preflight');

      if (comparisonBefore.inSync === true) {
        const current = await prepareSchematicSync({ target: session.target, bridgeUrl });
        if (current.digest !== expectedBeforeDigest.toLowerCase()) throw gatewayError('EPOCH_MISMATCH', 'PCB state changed after synchronization preflight');
        return {
          ...current,
          mode,
          target: session.target,
          wrotePCB: false,
          alreadyInSync: true,
          nativeAccepted: false,
          imported: false,
          changed: false,
          saved: false,
          comparisonBefore,
          comparisonAfter: comparisonBefore,
          note: 'Associated schematic and PCB were already synchronized; no native import was invoked.',
        };
      }

      const imported = await importSchematicChanges({ target: session.target, schematicUuid, expectedBeforeDigest, expectedAfter, save, bridgeUrl });
      const comparisonAfter = await compareAssociatedNetlists({ target: session.target, expectedSchematicUuid: schematicUuid, offset: 0, limit: 1000, bridgeUrl });
      if (comparisonAfter.inSync !== true) throw gatewayError('METHOD_FAILED', 'Schematic import changed the PCB but associated netlist differences remain', false, {
        remainingDifferences: comparisonAfter.total,
        counts: comparisonAfter.counts,
        requiresReconciliation: true,
      });
      return {
        ...imported,
        mode,
        target: session.target,
        wrotePCB: imported.changed === true,
        alreadyInSync: false,
        comparisonBefore,
        comparisonAfter,
      };
    });
  } catch (error) {
    if (!isWindowReconnectError(error) || !comparisonBefore || comparisonBefore.inSync === true) throw error;
    return recoverSchematicImportAfterReconnect({
      target: session.target,
      bridgeUrl,
      schematicUuid,
      expectedBeforeDigest,
      expectedAfter,
      save,
      comparisonBefore,
      executionId: executionId ?? error?.details?.executionId,
      originalError: error,
    });
  }
}

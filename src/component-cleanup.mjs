import { executeBridgeCode } from './bridge.mjs';
import { connectGateway, gatewayError, hashObject, prepareGatewayState } from './gateway-client.mjs';
import { contextRpc, contextVerifiedPublicWrite, executionContextFor, runGuardedNative } from './execution-context.mjs';
import { buildComponentCleanupCode } from './component-cleanup-runtime.mjs';
import { createWorkflowReceipt } from './workflow-receipt.mjs';

const GUARD_SCHEMA = 'easyeda-pcb-component-cleanup-guard/v1';

function normalizeOptions(input) {
  const options = {
    unlockComponents: input.unlockComponents !== false,
    deleteReferenceDesignators: input.deleteReferenceDesignators !== false,
  };
  if (!options.unlockComponents && !options.deleteReferenceDesignators) throw gatewayError('INVALID_REQUEST', 'At least one cleanup action is required');
  return options;
}

function previewDigest(preview, options) {
  return hashObject({ schema: 'easyeda-pcb-component-cleanup-preview/v1', options, preview });
}

function assertGuard(guard, target, options) {
  if (guard?.schema !== GUARD_SCHEMA || typeof guard.previewSha256 !== 'string' || !guard.expected) throw gatewayError('INVALID_REQUEST', 'A prepared component-cleanup guard is required');
  for (const field of ['windowId', 'projectUuid', 'documentUuid']) {
    if (guard.target?.[field] !== target[field]) throw gatewayError('TARGET_CHANGED', 'Cleanup guard and target differ');
  }
  if (guard.options?.unlockComponents !== options.unlockComponents || guard.options?.deleteReferenceDesignators !== options.deleteReferenceDesignators) {
    throw gatewayError('INVALID_REQUEST', 'Cleanup options changed after preflight');
  }
}

function cleanupSummary(preview, options) {
  return {
    componentCount: preview.counts.components,
    lockedComponentCount: options.unlockComponents ? preview.counts.lockedComponents : 0,
    designatorAttributeCount: options.deleteReferenceDesignators ? preview.counts.designatorAttributes : 0,
    preservedIndependentStringCount: preview.counts.independentStrings,
    preservedNonDesignatorAttributeCount: preview.counts.attributes - preview.counts.designatorAttributes,
    plannedChangeCount:
      (options.unlockComponents ? preview.counts.lockedComponents : 0) +
      (options.deleteReferenceDesignators ? preview.counts.designatorAttributes : 0),
  };
}

export async function cleanupComponents(request) {
  const mode = request.mode ?? 'preflight';
  if (!['preflight', 'execute'].includes(mode)) throw gatewayError('INVALID_REQUEST', 'Cleanup mode must be preflight or execute');
  const options = normalizeOptions(request);
  const target = request.target;

  if (mode === 'preflight') {
    const session = await connectGateway({ target, bridgeUrl: request.bridgeUrl, requireV2: true });
    const expected = await prepareGatewayState(session);
    const result = await executeBridgeCode(session.bridge, buildComponentCleanupCode({ target: session.target, mode: 'preview' }));
    if (result?.ok !== true || !result.preview) throw gatewayError('INVALID_RESPONSE', 'Component cleanup preview failed');
    const summary = cleanupSummary(result.preview, options);
    return {
      ok: true,
      mode,
      wrotePCB: false,
      summary,
      guard: {
        schema: GUARD_SCHEMA,
        target: session.target,
        expected,
        previewSha256: previewDigest(result.preview, options),
        options,
      },
      workflowReceipt: createWorkflowReceipt({ mode: 'prepare' }),
    };
  }

  assertGuard(request.guard, target, options);
  return runGuardedNative({
    target,
    expected: request.guard.expected,
    executionId: request.executionId,
    bridgeUrl: request.bridgeUrl,
  }, async () => {
    const context = executionContextFor(target);
    const previewResult = await executeBridgeCode(context.session.bridge, buildComponentCleanupCode({ target, mode: 'preview' }));
    if (previewResult?.ok !== true || !previewResult.preview) throw gatewayError('INVALID_RESPONSE', 'Component cleanup preview failed during execution');
    const currentDigest = previewDigest(previewResult.preview, options);
    if (currentDigest !== request.guard.previewSha256) throw gatewayError('EPOCH_MISMATCH', 'PCB component/text state changed after cleanup preflight; prepare a new guard');
    const summary = cleanupSummary(previewResult.preview, options);
    if (summary.plannedChangeCount === 0) {
      return {
        ok: true,
        mode,
        wrotePCB: false,
        summary,
        completedCount: 0,
        results: [],
        verification: {
          allComponentsUnlocked: !options.unlockComponents || previewResult.preview.counts.lockedComponents === 0,
          allComponentDesignatorsDeleted: !options.deleteReferenceDesignators || previewResult.preview.counts.designatorAttributes === 0,
          independentStringsUnchanged: true,
          nonDesignatorAttributesUnchanged: true,
          componentIdentityAndGeometryUnchanged: true,
        },
        workflowReceipt: createWorkflowReceipt({ mode: 'execute' }),
      };
    }

    const adapter = await contextVerifiedPublicWrite('pcb.componentCleanup', async (nativeContext, expected) => {
      const cleanupResult = await executeBridgeCode(nativeContext.session.bridge, buildComponentCleanupCode({
        target,
        mode: 'execute',
        expectedPreview: previewResult.preview,
        ...options,
      }), 180_000);
      const observed = await prepareGatewayState(nativeContext.session);
      return {
        ok: true,
        sourceBefore: { sha256: expected.sourceHash },
        sourceAfter: { sha256: observed.sourceHash },
        cleanupResult,
      };
    });
    const result = adapter.cleanupResult;
    if (result?.wrotePCB) await contextRpc('pcb.save', {}, { write: true });
    if (result?.ok !== true) {
      throw gatewayError('PARTIAL_SUCCESS', result?.error?.message ?? 'Component cleanup stopped before full verification', {
        outcome: result?.wrotePCB ? 'partial' : 'no-confirmed-change',
        confirmedResults: result?.results ?? [],
        completedCount: result?.completedCount ?? 0,
        requiresReadbackBeforeRetry: true,
      });
    }
    const boardDelta = {
      confirmedOperationCount: result.completedCount,
      changedOperationCount: result.completedCount,
      unchangedOperationCount: 0,
      changedPrimitiveCount: result.completedCount,
      statusCounts: result.results.reduce((counts, item) => {
        counts[item.status] = (counts[item.status] ?? 0) + 1;
        return counts;
      }, {}),
      changedByKind: {
        component: result.results.filter(item => item.type === 'component.unlock').length,
        attribute: result.results.filter(item => item.type === 'attribute.delete-designator').length,
      },
      changedOperationIds: result.results.map(item => `${item.type}:${item.primitiveId}`),
      unchangedOperationIds: [],
      remainingOperationIds: [],
      visibleBoardChange: result.completedCount > 0,
      progressClass: result.completedCount > 0 ? 'BOARD_CHANGED' : 'NO_BOARD_CHANGE',
      nextAction: 'Continue PCB placement and silkscreen work with components left movable and functional text preserved.',
    };
    return {
      ok: true,
      mode,
      wrotePCB: result.wrotePCB,
      summary,
      completedCount: result.completedCount,
      results: result.results,
      beforeCounts: result.beforeCounts,
      afterCounts: result.afterCounts,
      verification: result.verification,
      boardDelta,
      workflowReceipt: createWorkflowReceipt({ mode: 'execute', boardDelta }),
    };
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { importSchematicChanges } from '../src/advanced.mjs';
import { runGuardedNative, validateObservedWriteTransition } from '../src/execution-context.mjs';

const bridgeUrl = 'http://127.0.0.1:49620';
const target = {
  windowId: 'window-1',
  projectUuid: 'project-1',
  documentUuid: 'pcb-1',
  tabId: 'tab-1',
};
const generationId = 'generation-1';
const bridgeGenerationId = 'bridge-generation-1';
const hashBefore = '1'.repeat(64);
const hashAfter = '2'.repeat(64);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function snapshotDigest(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(snapshot))).digest('hex');
}

function rpcEnvelope(operation, result, { epoch, sourceHash, changeEpochAfter = epoch } = {}) {
  return {
    success: true,
    operation,
    windowId: target.windowId,
    bridgeGenerationId,
    result,
    state: {
      documentUuid: target.documentUuid,
      generationId,
      changeEpoch: epoch,
      changeEpochAfter,
      sourceHash,
    },
  };
}

test('GI01 native schematic import advances guarded expected state before save and final guard', async () => {
  const originalFetch = globalThis.fetch;
  const beforeSnapshot = {
    association: { schematicUuid: 'schematic-1' },
    components: [],
    pads: [],
    lines: [],
  };
  const afterSnapshot = {
    association: { schematicUuid: 'schematic-1' },
    components: [{ primitiveId: 'component-1', uniqueId: 'source-1', designator: 'U1', name: 'MCU' }],
    pads: [{ primitiveId: 'pad-1', componentPrimitiveId: 'component-1', padNumber: '1', net: 'GND' }],
    lines: [],
  };
  let epoch = 1;
  let sourceHash = hashBefore;
  let executeCount = 0;
  let saveCount = 0;

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/health')) {
      return jsonResponse({
        service: 'easyeda-bridge',
        status: 'ok',
        edaConnected: true,
        bridgeVersion: '2.0.0',
        bridgeGenerationId,
        protocolVersions: [1, 2],
      });
    }
    if (href.endsWith('/eda-windows')) {
      return jsonResponse({
        activeWindowId: target.windowId,
        windows: [{ windowId: target.windowId, connected: true, protocolVersions: [1, 2], gatewayVersion: '1.1.4' }],
      });
    }
    if (href.endsWith('/execute')) {
      executeCount += 1;
      epoch = 2;
      sourceHash = hashAfter;
      return jsonResponse({
        success: true,
        windowId: target.windowId,
        result: {
          nativeAccepted: true,
          confirmationUiAvailable: true,
          confirmationRequired: true,
          confirmationApplied: true,
          imported: true,
          changed: true,
          before: { snapshot: beforeSnapshot, runtimeHash: 'runtime-before' },
          after: { snapshot: afterSnapshot, runtimeHash: 'runtime-after' },
        },
      });
    }
    if (href.endsWith('/rpc')) {
      const request = JSON.parse(options.body);
      const expected = request.expected;
      if (expected) {
        assert.equal(expected.generationId, generationId);
        assert.equal(expected.bridgeGenerationId, bridgeGenerationId);
        assert.equal(expected.changeEpoch, epoch);
        if (expected.sourceHash !== undefined) assert.equal(expected.sourceHash, sourceHash);
      }
      if (request.operation === 'target.inspect') {
        return jsonResponse(rpcEnvelope(request.operation, { ...target }, { epoch, sourceHash }));
      }
      if (request.operation === 'events.getState') {
        return jsonResponse(rpcEnvelope(request.operation, { generationId, changeEpoch: epoch, eventCoverage: 'partial' }, { epoch, sourceHash }));
      }
      if (request.operation === 'document.sourceHash') {
        return jsonResponse(rpcEnvelope(request.operation, { sha256: sourceHash }, { epoch, sourceHash }));
      }
      if (request.operation === 'pcb.nativeTools') {
        assert.equal(request.arguments.request.kind, 'syncSnapshot');
        return jsonResponse(rpcEnvelope(request.operation, {
          snapshot: beforeSnapshot,
          runtimeHash: 'runtime-before',
          counts: { components: 0, pads: 0, lines: 0 },
        }, { epoch, sourceHash }));
      }
      if (request.operation === 'pcb.save') {
        saveCount += 1;
        epoch = 3;
        return jsonResponse(rpcEnvelope(request.operation, {
          saved: true,
          sourceAfter: { sha256: sourceHash },
        }, { epoch, sourceHash, changeEpochAfter: epoch }));
      }
      throw new Error(`Unexpected RPC operation: ${request.operation}`);
    }
    throw new Error(`Unexpected request: ${href}`);
  };

  try {
    const result = await runGuardedNative({
      target,
      bridgeUrl,
      executionId: 'guarded-import',
      expected: {
        generationId,
        bridgeGenerationId,
        changeEpoch: 1,
        sourceHash: hashBefore,
        eventCoverage: 'partial',
      },
    }, () => importSchematicChanges({
      target,
      bridgeUrl,
      schematicUuid: 'schematic-1',
      expectedBeforeDigest: snapshotDigest(beforeSnapshot),
      expectedAfter: { components: [{ uniqueId: 'source-1', designator: 'U1' }] },
      save: true,
    }));

    assert.equal(result.imported, true);
    assert.equal(result.changed, true);
    assert.equal(result.saved, true);
    assert.equal(result.postconditionsVerified, true);
    assert.equal(executeCount, 1);
    assert.equal(saveCount, 1);
    assert.deepEqual(result.execution.operations.map(item => item.operation), ['pcb.importChanges', 'pcb.save']);
    assert.equal(result.execution.operations[0].transport, 'verified-observed-native-write');
    assert.equal(result.execution.finalExpected.changeEpoch, 3);
    assert.equal(result.execution.finalExpected.sourceHash, hashAfter);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GI02 observed native write is not adopted without a new epoch and source hash', () => {
  const before = {
    generationId,
    bridgeGenerationId,
    changeEpoch: 1,
    sourceHash: hashBefore,
  };
  assert.throws(
    () => validateObservedWriteTransition(before, { ...before }),
    error => error?.code === 'PARTIAL_SUCCESS' && error?.details?.outcome === 'unknown',
  );
  assert.throws(
    () => validateObservedWriteTransition(before, { ...before, generationId: 'generation-2', changeEpoch: 2, sourceHash: hashAfter }),
    error => error?.code === 'GENERATION_MISMATCH',
  );
});

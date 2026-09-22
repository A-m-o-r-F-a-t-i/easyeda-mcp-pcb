import test from 'node:test';
import assert from 'node:assert/strict';
import { isWindowReconnectError, openTarget, rediscoverExactPcbTarget } from '../src/inspection.mjs';
import { recoverSchematicImportAfterReconnect } from '../src/production-tools.mjs';

const baseUrl = 'http://127.0.0.1:49620';
const oldTarget = {
  windowId: 'window-old',
  projectUuid: 'project-4310',
  documentUuid: 'pcb-4310',
  tabId: 'tab-old',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('window reconnect errors are recognized without accepting unrelated failures', () => {
  const disconnected = new Error('EDA window disconnected after native operation');
  disconnected.code = 'WINDOW_DISCONNECTED';
  disconnected.details = { outcome: 'unknown' };
  assert.equal(isWindowReconnectError(disconnected), true);
  assert.equal(isWindowReconnectError(new Error('ordinary validation error')), false);
});

test('pcb_open_target verifies the exact project and PCB after a window-id rebuild without replaying openDocument', async () => {
  const originalFetch = globalThis.fetch;
  let rotated = false;
  const executeWindowIds = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/health')) {
      return jsonResponse({
        service: 'easyeda-bridge',
        status: 'ok',
        edaConnected: true,
        bridgeVersion: '2.0.0',
        bridgeGenerationId: 'bridge-generation',
        protocolVersions: [1, 2],
      });
    }
    if (href.endsWith('/eda-windows')) {
      const windowId = rotated ? 'window-new' : oldTarget.windowId;
      return jsonResponse({
        activeWindowId: windowId,
        windows: [{ windowId, connected: true, protocolVersions: [1, 2], gatewayVersion: '1.1.4' }],
      });
    }
    if (href.endsWith('/execute')) {
      const request = JSON.parse(options.body);
      executeWindowIds.push(request.windowId);
      if (request.windowId === oldTarget.windowId) {
        rotated = true;
        return jsonResponse({
          error: {
            code: 'WINDOW_DISCONNECTED',
            message: 'EDA window disconnected after openDocument',
            details: { outcome: 'unknown' },
          },
        }, 503);
      }
      assert.equal(request.windowId, 'window-new');
      return jsonResponse({
        success: true,
        windowId: 'window-new',
        result: {
          project: { uuid: oldTarget.projectUuid, name: 'QDrive' },
          document: {
            uuid: oldTarget.documentUuid,
            documentType: 3,
            parentProjectUuid: oldTarget.projectUuid,
            tabId: 'tab-new',
          },
          boards: [{ name: 'Board1', pcbUuid: oldTarget.documentUuid, pcbName: 'PCB1', schematicUuid: 'sch-4310' }],
        },
      });
    }
    throw new Error(`Unexpected request: ${href}`);
  };
  try {
    const result = await openTarget({
      target: oldTarget,
      expectedCurrentDocumentUuid: 'schematic-page',
      bridgeUrl: baseUrl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'opened_after_window_reconnect');
    assert.equal(result.verified, true);
    assert.equal(result.target.windowId, 'window-new');
    assert.equal(result.target.documentUuid, oldTarget.documentUuid);
    assert.equal(result.recovery.replayed, false);
    assert.deepEqual(executeWindowIds, [oldTarget.windowId, 'window-new']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exact reconnect discovery rejects duplicate windows for the same project and PCB', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/health')) return jsonResponse({ service: 'easyeda-bridge', status: 'ok', edaConnected: true });
    if (href.endsWith('/eda-windows')) {
      return jsonResponse({
        activeWindowId: 'window-a',
        windows: [
          { windowId: 'window-a', connected: true },
          { windowId: 'window-b', connected: true },
        ],
      });
    }
    if (href.endsWith('/execute')) {
      const request = JSON.parse(options.body);
      return jsonResponse({
        success: true,
        windowId: request.windowId,
        result: {
          project: { uuid: oldTarget.projectUuid, name: 'QDrive' },
          document: { uuid: oldTarget.documentUuid, documentType: 3, parentProjectUuid: oldTarget.projectUuid, tabId: `tab-${request.windowId}` },
          boards: [],
        },
      });
    }
    throw new Error(`Unexpected request: ${href}`);
  };
  try {
    await assert.rejects(
      rediscoverExactPcbTarget({ target: oldTarget, bridgeUrl: baseUrl, attempts: 1, delayMs: 0 }),
      error => error?.code === 'AMBIGUOUS_TARGET_RECONNECT',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('schematic import recovery accepts only an exact changed and synchronized final state, then saves without replay', async () => {
  const disconnected = new Error('Bridge HTTP 503: EDA window disconnected');
  disconnected.code = 'WINDOW_DISCONNECTED';
  disconnected.details = { outcome: 'unknown', executionId: 'eco-exec' };
  const recoveredTarget = { ...oldTarget, windowId: 'window-new', tabId: 'tab-new' };
  const snapshot = {
    association: { schematicUuid: 'sch-4310' },
    components: [{ primitiveId: 'component-1', uniqueId: 'source-1', designator: 'U1', name: 'MCU' }],
    pads: [{ primitiveId: 'pad-1', componentPrimitiveId: 'component-1', padNumber: '1', net: 'GND' }],
    lines: [],
  };
  const syncState = {
    bridge: { baseUrl, windowId: recoveredTarget.windowId },
    snapshot,
    digest: 'b'.repeat(64),
    runtimeHash: 'runtime-after',
    association: snapshot.association,
    counts: { components: 1, pads: 1, lines: 0 },
  };
  let saveCount = 0;
  let syncReadCount = 0;
  const result = await recoverSchematicImportAfterReconnect({
    target: oldTarget,
    bridgeUrl: baseUrl,
    schematicUuid: 'sch-4310',
    expectedBeforeDigest: 'a'.repeat(64),
    expectedAfter: { components: [{ uniqueId: 'source-1', designator: 'U1' }] },
    save: true,
    comparisonBefore: { inSync: false, total: 3, counts: { component: 1, net: 2 } },
    executionId: 'eco-exec',
    originalError: disconnected,
  }, {
    rediscoverExactPcbTarget: async () => ({ ok: true, attempt: 2, bridgeUrl: baseUrl, target: recoveredTarget }),
    readSchematicSyncState: async () => { syncReadCount += 1; return syncState; },
    compareAssociatedNetlists: async () => ({ inSync: true, total: 0, counts: { component: 0, net: 0 } }),
    saveDocument: async (bridge, target) => {
      saveCount += 1;
      assert.equal(bridge.windowId, recoveredTarget.windowId);
      assert.equal(target.windowId, recoveredTarget.windowId);
      return true;
    },
    connectGateway: async () => ({ target: recoveredTarget, protocolVersion: 2 }),
    prepareGatewayState: async () => ({
      generationId: 'generation-new',
      changeEpoch: 1,
      bridgeGenerationId: 'bridge-generation',
      sourceHash: 'c'.repeat(64),
      eventCoverage: 'partial',
    }),
  });
  assert.equal(result.imported, true);
  assert.equal(result.saved, true);
  assert.equal(result.recoveredAfterWindowReconnect, true);
  assert.equal(result.replayAvoided, true);
  assert.equal(result.target.windowId, recoveredTarget.windowId);
  assert.equal(result.postconditionsVerified, true);
  assert.equal(result.execution.transport, 'verified-reconnect-readback');
  assert.equal(saveCount, 1);
  assert.equal(syncReadCount, 2);
});

test('schematic import recovery preserves unknown outcome when the final digest did not change', async () => {
  const disconnected = new Error('EDA window disconnected');
  disconnected.code = 'WINDOW_DISCONNECTED';
  disconnected.details = { outcome: 'unknown' };
  const recoveredTarget = { ...oldTarget, windowId: 'window-new' };
  let saved = false;
  await assert.rejects(
    recoverSchematicImportAfterReconnect({
      target: oldTarget,
      bridgeUrl: baseUrl,
      schematicUuid: 'sch-4310',
      expectedBeforeDigest: 'a'.repeat(64),
      save: true,
      comparisonBefore: { inSync: false, total: 1, counts: { component: 1, net: 0 } },
      executionId: 'eco-exec',
      originalError: disconnected,
    }, {
      rediscoverExactPcbTarget: async () => ({ ok: true, attempt: 1, bridgeUrl: baseUrl, target: recoveredTarget }),
      readSchematicSyncState: async () => ({
        bridge: { baseUrl, windowId: recoveredTarget.windowId },
        snapshot: { association: { schematicUuid: 'sch-4310' }, components: [], pads: [] },
        digest: 'a'.repeat(64),
        association: { schematicUuid: 'sch-4310' },
      }),
      saveDocument: async () => { saved = true; return true; },
    }),
    error => error === disconnected && /no requested change was verified/i.test(error.details?.reconnectVerification?.message ?? ''),
  );
  assert.equal(saved, false);
});

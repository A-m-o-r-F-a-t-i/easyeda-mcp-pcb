import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPlanSource, normalizeBridgeUrl, requiresMcpOwnedRead, validatePlanSource } from '../src/bridge.mjs';

const minimalPlan = {
  schema: 'easyeda-pcb-plan/v2', intent: 'bridge test', target: { documentUuid: 'pcb-doc-1' }, units: 'mil', phase: 'route',
  constraints: { minTrackWidth: 4, minViaHole: 8, minAnnularRing: 3, allowedLayers: ['TOP', 'BOTTOM'] },
  operations: [{ id: 'l1', type: 'line.create', net: 'N1', layer: 'TOP', start: [10, 10], end: [50, 10], width: 8 }],
};

test('accepts only the local EasyEDA bridge port range', () => {
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:49620'), 'http://127.0.0.1:49620');
  assert.equal(normalizeBridgeUrl('http://localhost:49629'), 'http://localhost:49629');
  assert.throws(() => normalizeBridgeUrl('https://127.0.0.1:49620'), /must be http/i);
  assert.throws(() => normalizeBridgeUrl('http://example.com:49620'), /127\.0\.0\.1/i);
  assert.throws(() => normalizeBridgeUrl('http://127.0.0.1:49999'), /49620-49629/i);
});

test('loads and validates an inspectable plan file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyeda-pcb-mcp-'));
  const file = path.join(dir, 'plan.json');
  await fs.writeFile(file, JSON.stringify(minimalPlan));
  try {
    const { loaded, summary } = await validatePlanSource({ planPath: file });
    assert.equal(loaded.source, path.resolve(file));
    assert.equal(summary.expandedOperationCount, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('requires exactly one plan source', async () => {
  await assert.rejects(() => loadPlanSource({}), /exactly one/i);
  await assert.rejects(() => loadPlanSource({ planPath: 'x.json', plan: minimalPlan }), /exactly one/i);
});

test('routes geometry kinds unknown to older Gateways through MCP-owned readback', () => {
  assert.equal(requiresMcpOwnedRead({ kind: 'polylines' }), true);
  assert.equal(requiresMcpOwnedRead({ kind: 'poured' }), true);
  assert.equal(requiresMcpOwnedRead({ kind: 'snapshot', include: ['components', 'polylines'] }), true);
  assert.equal(requiresMcpOwnedRead({ kind: 'lines' }), false);
  assert.equal(requiresMcpOwnedRead({ kind: 'snapshot', include: ['components', 'lines'] }), false);
});

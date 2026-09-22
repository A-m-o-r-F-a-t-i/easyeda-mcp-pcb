import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatchCode, buildReadCode } from '../src/runtime.mjs';

test('read code contains the exact target and no Node dependency', () => {
  const code = buildReadCode({ kind: 'status', target: { documentUuid: 'doc-123' } });
  assert.match(code, /doc-123/);
  assert.doesNotMatch(code, /node:/);
  assert.match(code, /document\/type mismatch/i);
});

test('batch code carries expected-state guards and target UUID', () => {
  const code = buildBatchCode({
    target: { documentUuid: 'doc-123' }, toleranceMil: 0.02,
    operations: [{ id: 'l1', type: 'line.create', kind: 'line', state: { net: 'N1', layer: 1, startX: 10, startY: 10, endX: 20, endY: 10, lineWidth: 8, primitiveLock: false } }],
  });
  assert.match(code, /doc-123/);
  assert.match(code, /independent geometry readback/i);
  assert.match(code, /already_exists/);
});

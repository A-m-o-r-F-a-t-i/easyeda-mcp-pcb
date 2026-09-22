import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requiresBridgeGeometryRuntime,
  resolveProtectedBatchSize,
  summarizePadOverlapGate,
} from '../src/guarded-plan.mjs';

test('placement-sensitive geometry always uses the collision-aware bridge runtime', () => {
  for (const kind of ['component', 'pad', 'via']) {
    assert.equal(requiresBridgeGeometryRuntime('geometry', [{ kind }]), true, kind);
  }
  assert.equal(requiresBridgeGeometryRuntime('geometry', [{ kind: 'line' }]), false);
  assert.equal(requiresBridgeGeometryRuntime('text', [{ kind: 'component' }]), false);
});

test('protected geometry execution honors requested batches through one hundred', () => {
  assert.equal(resolveProtectedBatchSize({ options: { batchSize: 80 } }), 80);
  assert.equal(resolveProtectedBatchSize({ options: { batchSize: 100 } }), 100);
  assert.throws(() => resolveProtectedBatchSize({ options: { batchSize: 101 } }), /1 to 100/);
});

test('pad overlap gate must be clear before another placement round', () => {
  const normalized = { operations: [
    { id: 'move-u1', kind: 'component', type: 'component.modify' },
    { id: 'route-a', kind: 'line', type: 'line.create' },
  ] };
  const clear = summarizePadOverlapGate(normalized, [{ id: 'move-u1', overlapGuard: { preflight: { checked: true } } }]);
  assert.equal(clear.state, 'CLEAR');
  assert.equal(clear.nextPlacementRoundAllowed, true);
  const unverified = summarizePadOverlapGate(normalized, []);
  assert.equal(unverified.state, 'UNVERIFIED');
  assert.equal(unverified.nextPlacementRoundAllowed, false);
  const blocked = summarizePadOverlapGate(normalized, [], 'PAD_OVERLAP_BLOCKED');
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.nextPlacementRoundAllowed, false);
});

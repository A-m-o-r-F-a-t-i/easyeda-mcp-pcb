import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../src/plan.mjs';

function basePlan(operations) {
  return {
    schema: 'easyeda-pcb-plan/v2',
    intent: 'unit test',
    target: { documentUuid: 'pcb-doc-1', projectUuid: 'project-1' },
    units: 'mm',
    phase: 'route',
    constraints: {
      noRightAngle: true,
      minTrackWidth: 0.1,
      minViaHole: 0.2,
      minAnnularRing: 0.075,
      allowedLayers: ['TOP', 'BOTTOM', 'INNER_1', 'INNER_2'],
      reservedLayers: { INNER_1: ['GND'] },
      boardBounds: { minX: 0, maxX: 50, minY: 0, maxY: 30 },
    },
    options: { batchSize: 16, saveAfterBatch: true },
    operations,
  };
}

test('validates and expands a chamfered route and through via', () => {
  const plan = validatePlan(basePlan([
    { id: 'r1', type: 'route.create', net: 'SIG', layer: 'TOP', points: [[1, 1], [4, 1], [5, 2], [8, 2]], width: 0.2 },
    { id: 'v1', type: 'via.create', net: 'SIG', position: [8, 2], holeDiameter: 0.3, diameter: 0.6 },
  ]));
  assert.equal(plan.inputUnits, 'mm');
  assert.equal(plan.operations.length, 4);
  assert.deepEqual(plan.operations.map(op => op.type), ['line.create', 'line.create', 'line.create', 'via.create']);
});

test('rejects a 90-degree copper corner', () => {
  assert.throws(() => validatePlan(basePlan([
    { id: 'r1', type: 'route.create', net: 'SIG', layer: 'TOP', points: [[1, 1], [4, 1], [4, 4]], width: 0.2 },
  ])), /90\/135\/reverse|right\/acute\/reverse/i);
});

test('rejects non-GND copper on a reserved plane layer', () => {
  assert.throws(() => validatePlan(basePlan([
    { id: 'l1', type: 'line.create', net: 'SIG', layer: 'INNER_1', start: [1, 1], end: [4, 1], width: 0.2 },
  ])), /Reserved plane layer/i);
});

test('requires explicit replan policy before moving a routed component', () => {
  const raw = basePlan([{ id: 'dummy', type: 'line.create', net: 'SIG', layer: 'TOP', start: [1, 1], end: [4, 1], width: 0.2 }]);
  raw.phase = 'relayout';
  raw.operations = [{
    id: 'move-u1', type: 'component.modify', primitiveId: 'U1-ID',
    expected: { designator: 'U1', x: 100, y: 100, rotation: 0, layer: 1, primitiveLock: false },
    set: { x: 120 }, affectedNets: ['SIG'],
  }];
  assert.throws(() => validatePlan(raw), /copperPolicy/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../src/plan.mjs';
import { batchRuntime, readRuntime } from '../src/runtime.mjs';
import { continuationDetails, summarizeBoardDelta } from '../src/guarded-plan.mjs';

const target = { documentUuid: 'pcb-pad', projectUuid: 'project-pad', windowId: 'window-pad' };
const basePlan = operations => ({
  schema: 'easyeda-pcb-plan/v2',
  intent: 'standalone mechanical holes and motor terminal pads',
  target,
  units: 'mm',
  phase: 'layout',
  constraints: {
    minTrackWidth: 0.15,
    minViaHole: 0.3,
    minAnnularRing: 0.15,
    allowedLayers: ['TOP', 'BOTTOM', 'INNER_1', 'INNER_2'],
    boardBounds: { minX: 0, minY: 0, maxX: 50, maxY: 50 },
  },
  operations,
});

function padFixture({ failCreateAt = null, clientVersion = null, normalizeBareNpthPad = false, normalizeBareNpthPadNumber = false, normalizeBareNpthPosition = false, normalizeStandalonePthPad = false, normalizeStandalonePthPosition = false, normalizeStandaloneSmdPad = false, normalizeStandaloneSmdPosition = false, omitStandaloneSmdDefaults = false, nanStandaloneSmdHoleRotation = false, divergentSingleGet = false, expandRoundHoleReadback = false, mutateCreated = null } = {}) {
  let sequence = 0;
  let createCount = 0;
  let items = [];
  const api = {
    getAll: async () => items,
    get: async primitiveId => {
      if (Array.isArray(primitiveId)) return items.filter(item => primitiveId.includes(item.primitiveId));
      const item = items.find(value => value.primitiveId === primitiveId);
      return divergentSingleGet && item ? { ...item, pad: ['ELLIPSE', 999, 999], holeOffsetX: 999 } : item;
    },
    create: async (layer, padNumber, x, y, rotation, pad, net, hole, holeOffsetX, holeOffsetY, holeRotation, metallization, padType, specialPad, masks, heat, primitiveLock) => {
      createCount++;
      if (createCount === failCreateAt) return undefined;
      const bareNpth = layer === 12 && metallization === false && (net == null || net === '') && Array.isArray(hole);
      const standalonePth = layer === 12 && metallization === true && typeof net === 'string' && net.length > 0 && Array.isArray(hole);
      const standaloneSmd = (layer === 1 || layer === 2) && metallization === true && hole === null && Array.isArray(pad);
      const storedPad = ((normalizeBareNpthPad && bareNpth) || (normalizeStandalonePthPad && standalonePth) || (normalizeStandaloneSmdPad && standaloneSmd))
        ? pad.map((value, index) => index === 0 ? value : Math.round(value * 10) / 10)
        : [...pad];
      const storedPadNumber = normalizeBareNpthPadNumber && bareNpth
        ? String(padNumber).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
        : padNumber;
      const storedX = ((normalizeBareNpthPosition && bareNpth) || (normalizeStandalonePthPosition && standalonePth) || (normalizeStandaloneSmdPosition && standaloneSmd))
        ? Math.round(x * 10) / 10
        : x;
      const storedY = ((normalizeBareNpthPosition && bareNpth) || (normalizeStandalonePthPosition && standalonePth) || (normalizeStandaloneSmdPosition && standaloneSmd))
        ? Math.round(y * 10) / 10
        : y;
      const storedHole = expandRoundHoleReadback && Array.isArray(hole) && hole[0] === 'ROUND' && hole.length === 2
        ? ['ROUND', hole[1], hole[1]]
        : Array.isArray(hole) ? [...hole] : hole;
      let item = { primitiveId: `pad-${++sequence}`, layer, padNumber: storedPadNumber, x: storedX, y: storedY, rotation, pad: storedPad, net: net ?? null, hole: storedHole, holeOffsetX, holeOffsetY, holeRotation, metallization, padType, primitiveLock };
      if (omitStandaloneSmdDefaults && standaloneSmd) {
        delete item.hole;
        delete item.holeOffsetX;
        delete item.holeOffsetY;
        delete item.holeRotation;
        delete item.padType;
      }
      if (nanStandaloneSmdHoleRotation && standaloneSmd) item.holeRotation = Number.NaN;
      if (mutateCreated) item = mutateCreated(item, createCount);
      items.push(item);
      return item;
    },
    modify: async (primitiveId, set) => {
      const index = items.findIndex(item => item.primitiveId === primitiveId);
      if (index < 0) return undefined;
      items[index] = { ...items[index], ...set };
      return items[index];
    },
    delete: async primitiveId => {
      const before = items.length;
      items = items.filter(item => item.primitiveId !== primitiveId);
      return items.length !== before;
    },
  };
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: target.documentUuid, documentType: 3 }) },
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: target.projectUuid }) },
    sys_Environment: { getEditorCurrentVersion: async () => clientVersion },
    pcb_PrimitivePad: api,
  };
  return { eda, items: () => items, createCount: () => createCount };
}

test('P01 hole.create compiles round and slot NPTH objects as standalone MULTI pads', () => {
  const plan = validatePlan(basePlan([
    { id: 'mh-round', type: 'hole.create', position: [5, 5], hole: { type: 'ROUND', diameter: 2.8 }, locked: true },
    { id: 'harness-slot', type: 'hole.create', position: [20, 40], rotation: 90, hole: { type: 'SLOT', diameter: 2, length: 5 }, locked: true },
  ]));
  assert.equal(plan.operations.length, 2);
  assert.deepEqual(plan.operations[0].state.pad, ['ELLIPSE', 2.8 / 0.0254, 2.8 / 0.0254]);
  assert.deepEqual(plan.operations[0].state.hole, ['ROUND', 2.8 / 0.0254]);
  assert.equal(plan.operations[0].state.layer, 12);
  assert.equal(plan.operations[0].state.metallization, false);
  assert.equal(plan.operations[0].state.net, '');
  assert.deepEqual(plan.operations[1].state.pad, ['OVAL', 2 / 0.0254, 5 / 0.0254]);
  assert.deepEqual(plan.operations[1].state.hole, ['SLOT', 2 / 0.0254, 5 / 0.0254]);
  assert.equal(plan.operations[1].state.rotation, 90);
});

test('P02 pad.create compiles a networked plated motor terminal with verified annular copper', () => {
  const plan = validatePlan(basePlan([{ id: 'motor-u', type: 'pad.create', layer: 'MULTI', padNumber: 'U', position: [10, 10], shape: { type: 'OVAL', width: 3, height: 6 }, net: 'MOTOR_U', hole: { type: 'SLOT', diameter: 1.5, length: 4 }, metallization: true, locked: true }]));
  const state = plan.operations[0].state;
  assert.equal(plan.operations[0].kind, 'pad');
  assert.equal(state.net, 'MOTOR_U');
  assert.equal(state.metallization, true);
  assert.equal(state.padType, 0);
  assert.deepEqual(state.hole, ['SLOT', 1.5 / 0.0254, 4 / 0.0254]);
});

test('P03 invalid standalone pad definitions fail before any client write', () => {
  assert.throws(() => validatePlan(basePlan([{ id: 'bad-npth', type: 'pad.create', layer: 'MULTI', padNumber: 'X', position: [10, 10], shape: { type: 'ELLIPSE', width: 3, height: 3 }, net: 'VBAT', hole: { type: 'ROUND', diameter: 3 }, metallization: false }])), /cannot carry a network/);
  assert.throws(() => validatePlan(basePlan([{ id: 'bad-ring', type: 'pad.create', layer: 'MULTI', padNumber: 'U', position: [10, 10], shape: { type: 'ELLIPSE', width: 2.1, height: 2.1 }, net: 'MOTOR_U', hole: { type: 'ROUND', diameter: 2 }, metallization: true }])), /annular ring/);
  assert.throws(() => validatePlan(basePlan([{ id: 'bad-layer', type: 'pad.create', layer: 'TOP', padNumber: 'U', position: [10, 10], shape: { type: 'ELLIPSE', width: 4, height: 4 }, net: 'MOTOR_U', hole: { type: 'ROUND', diameter: 2 }, metallization: true }])), /must be on MULTI/);
});

test('P04 runtime creates standalone pads, deeply verifies geometry and exposes physical drills', async () => {
  const plan = validatePlan(basePlan([
    { id: 'mh-round', type: 'hole.create', position: [5, 5], hole: { type: 'ROUND', diameter: 2.8 }, locked: false },
    { id: 'motor-u', type: 'pad.create', layer: 'MULTI', padNumber: 'U', position: [10, 10], shape: { type: 'OVAL', width: 3, height: 6 }, net: 'MOTOR_U', hole: { type: 'SLOT', diameter: 1.5, length: 4 }, metallization: true, locked: false },
  ]));
  const fixture = padFixture();
  const result = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(result.ok, true);
  assert.equal(result.completedCount, 2);
  assert.deepEqual(result.results.map(item => item.status), ['created', 'created']);
  const read = await readRuntime(fixture.eda, { target, kind: 'pads', limit: 20 });
  assert.equal(read.total, 2);
  const mechanical = read.items.find(item => item.padNumber === 'mh-round');
  const terminal = read.items.find(item => item.padNumber === 'U');
  assert.equal(mechanical.metallization, false);
  assert.equal(mechanical.physicalDrill.present, true);
  assert.deepEqual(mechanical.physicalDrill.hole, plan.operations[0].state.hole);
  assert.equal(terminal.net, 'MOTOR_U');
  assert.deepEqual(terminal.pad, plan.operations[1].state.pad);
});

test('P04A client 4.1.60 accepts normalized bare NPTH outer shapes while preserving exact round and slot drills', async () => {
  const plan = validatePlan(basePlan([
    { id: 'mh-round', type: 'hole.create', position: [5, 5], hole: { type: 'ROUND', diameter: 2.8 }, locked: true },
    { id: 'harness-slot', type: 'hole.create', position: [20, 40], rotation: 90, hole: { type: 'SLOT', diameter: 2, length: 5 }, locked: true },
  ]));
  const fixture = padFixture({ clientVersion: '4.1.60', normalizeBareNpthPad: true, normalizeBareNpthPadNumber: true });
  const result = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map(item => item.status), ['created', 'created']);
  const [round, slot] = fixture.items();
  assert.deepEqual(round.pad, ['ELLIPSE', 110.2, 110.2]);
  assert.equal(round.padNumber, 'MHROUND');
  assert.deepEqual(round.hole, plan.operations[0].state.hole);
  assert.deepEqual(slot.pad, ['OVAL', 78.7, 196.9]);
  assert.equal(slot.padNumber, 'HARNESSSLOT');
  assert.deepEqual(slot.hole, plan.operations[1].state.hole);
  assert.equal(slot.rotation, 90);
});

test('P04D client 4.1.60 accepts native three-field ROUND drill readback and keeps the canonical drill diameter', async () => {
  const plan = validatePlan(basePlan([
    { id: 'mount-ne', type: 'hole.create', position: [5, 5], hole: { type: 'ROUND', diameter: 2.8 }, locked: true },
    { id: 'mount-nw', type: 'hole.create', position: [15, 5], hole: { type: 'ROUND', diameter: 2.8 }, locked: true },
  ]));
  const fixture = padFixture({
    clientVersion: '4.1.60',
    normalizeBareNpthPad: true,
    normalizeBareNpthPadNumber: true,
    expandRoundHoleReadback: true,
  });
  const result = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map(item => item.status), ['created', 'created']);
  assert.deepEqual(fixture.items()[0].hole, ['ROUND', 2.8 / 0.0254, 2.8 / 0.0254]);
  const read = await readRuntime(fixture.eda, { target, kind: 'pads', limit: 20 });
  assert.deepEqual(read.items.map(item => item.hole), plan.operations.map(operation => operation.state.hole));
  assert.deepEqual(read.items.map(item => item.nativeHoleRaw), fixture.items().map(item => item.hole));

  const unknownClient = padFixture({ clientVersion: '4.2.0', expandRoundHoleReadback: true });
  const unknownResult = await batchRuntime(unknownClient.eda, { target, operations: plan.operations.slice(0, 1), toleranceMil: plan.options.toleranceMil });
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.error.message, /not verified/);

  const distorted = padFixture({
    clientVersion: '4.1.60',
    expandRoundHoleReadback: true,
    mutateCreated: item => ({ ...item, hole: ['ROUND', item.hole[1], item.hole[2] + 0.1] }),
  });
  const distortedResult = await batchRuntime(distorted.eda, { target, operations: plan.operations.slice(0, 1), toleranceMil: plan.options.toleranceMil });
  assert.equal(distortedResult.ok, false);
  assert.match(distortedResult.error.message, /not verified/);
});

test('P04E client 4.1.60 accepts 0.1 mil bare NPTH position readback without relaxing adjacent grid points', async () => {
  const plan = validatePlan({
    schema: 'easyeda-pcb-plan/v2',
    intent: 'live 4310 mounting-hole coordinate normalization',
    target,
    units: 'mm',
    phase: 'layout',
    constraints: {
      minTrackWidth: 0.15,
      minViaHole: 0.3,
      minAnnularRing: 0.15,
      allowedLayers: ['TOP', 'BOTTOM', 'INNER_1', 'INNER_2'],
      boardBounds: { minX: 179.2, minY: -87.5, maxX: 227.2, maxY: -39.5 },
    },
    operations: [{
      id: 'mount-sw',
      type: 'hole.create',
      position: [189.057864, -77.642136],
      hole: { type: 'ROUND', diameter: 2.8 },
      locked: true,
    }],
  });
  const fixture = padFixture({
    clientVersion: '4.1.60',
    normalizeBareNpthPad: true,
    normalizeBareNpthPadNumber: true,
    normalizeBareNpthPosition: true,
    expandRoundHoleReadback: true,
  });
  const result = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, 'created');
  assert.equal(fixture.items()[0].x, 7443.2);
  assert.equal(fixture.items()[0].y, -3056.8);

  const unknownClient = padFixture({
    clientVersion: '4.2.0',
    normalizeBareNpthPosition: true,
  });
  const unknownResult = await batchRuntime(unknownClient.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.error.message, /not verified/);

  const adjacentGridPoint = padFixture({
    clientVersion: '4.1.60',
    normalizeBareNpthPad: true,
    normalizeBareNpthPadNumber: true,
    normalizeBareNpthPosition: true,
    expandRoundHoleReadback: true,
    mutateCreated: item => ({ ...item, x: item.x + 0.1 }),
  });
  const adjacentResult = await batchRuntime(adjacentGridPoint.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(adjacentResult.ok, false);
  assert.match(adjacentResult.error.message, /not verified/);
});

test('P04F client 4.1.60 accepts exact standalone plated PTH grid and ROUND readback without relaxing identity', async () => {
  const plan = validatePlan({
    schema: 'easyeda-pcb-plan/v2',
    intent: 'live 4310 U phase plated wire terminal normalization',
    target,
    units: 'mm',
    phase: 'layout',
    constraints: {
      minTrackWidth: 0.15,
      minViaHole: 0.3,
      minAnnularRing: 0.15,
      allowedLayers: ['TOP', 'BOTTOM', 'INNER_1', 'INNER_2'],
      boardBounds: { minX: 179.2, minY: -87.5, maxX: 227.2, maxY: -39.5 },
    },
    operations: [{
      id: 'phase-u-terminal',
      type: 'pad.create',
      layer: 'MULTI',
      padNumber: 'U',
      position: [197.2, -84],
      shape: { type: 'ELLIPSE', width: 4.5, height: 4.5 },
      net: 'MOTOR_U',
      hole: { type: 'ROUND', diameter: 2.4 },
      metallization: true,
      locked: true,
    }],
  });
  const normalizedOptions = {
    clientVersion: '4.1.60',
    normalizeStandalonePthPad: true,
    normalizeStandalonePthPosition: true,
    expandRoundHoleReadback: true,
  };
  const fixture = padFixture(normalizedOptions);
  const result = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, 'created');
  assert.equal(fixture.items()[0].x, 7763.8);
  assert.equal(fixture.items()[0].y, -3307.1);
  assert.deepEqual(fixture.items()[0].pad, ['ELLIPSE', 177.2, 177.2]);
  assert.deepEqual(fixture.items()[0].hole, ['ROUND', 2.4 / 0.0254, 2.4 / 0.0254]);
  const read = await readRuntime(fixture.eda, { target, kind: 'pads', limit: 20 });
  assert.deepEqual(read.items[0].hole, plan.operations[0].state.hole);
  assert.deepEqual(read.items[0].nativeHoleRaw, fixture.items()[0].hole);

  const unknownClient = padFixture({ ...normalizedOptions, clientVersion: '4.2.0' });
  const unknownResult = await batchRuntime(unknownClient.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.error.message, /not verified/);

  const mutations = [
    item => ({ ...item, x: item.x + 0.1 }),
    item => ({ ...item, pad: [item.pad[0], item.pad[1] + 0.1, item.pad[2]] }),
    item => ({ ...item, hole: ['ROUND', item.hole[1], item.hole[2] + 0.1] }),
    item => ({ ...item, net: 'MOTOR_V' }),
    item => ({ ...item, metallization: false }),
    item => ({ ...item, primitiveLock: false }),
    item => ({ ...item, padNumber: 'V' }),
  ];
  for (const mutateCreated of mutations) {
    const invalid = padFixture({ ...normalizedOptions, mutateCreated });
    const invalidResult = await batchRuntime(invalid.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
    assert.equal(invalidResult.ok, false);
    assert.match(invalidResult.error.message, /not verified/);
  }
});

test('P04G client 4.1.60 accepts exact standalone SMD grid readback without relaxing electrical identity', async () => {
  const definition = basePlan([{
    id: 'phase-w-smd-terminal',
    type: 'pad.create',
    layer: 'TOP',
    padNumber: 'W',
    position: [69, 58],
    shape: { type: 'ELLIPSE', width: 4.5, height: 4 },
    net: 'MOTOR_W',
    metallization: true,
    locked: false,
  }]);
  definition.constraints.boardBounds = { minX: 0, minY: 0, maxX: 75, maxY: 75 };
  const plan = validatePlan(definition);
  const normalizedOptions = {
    clientVersion: '4.1.60',
    normalizeStandaloneSmdPad: true,
    normalizeStandaloneSmdPosition: true,
    omitStandaloneSmdDefaults: true,
    nanStandaloneSmdHoleRotation: true,
  };
  const fixture = padFixture(normalizedOptions);
  const created = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(created.ok, true);
  assert.equal(created.results[0].status, 'created');
  assert.equal(fixture.items()[0].x, 2716.5);
  assert.equal(fixture.items()[0].y, 2283.5);
  assert.deepEqual(fixture.items()[0].pad, ['ELLIPSE', 177.2, 157.5]);
  assert.equal('hole' in fixture.items()[0], false);
  assert.equal('holeOffsetX' in fixture.items()[0], false);
  assert.equal('holeOffsetY' in fixture.items()[0], false);
  assert.equal(Number.isNaN(fixture.items()[0].holeRotation), true);
  assert.equal('padType' in fixture.items()[0], false);

  const repeated = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.results[0].status, 'already_exists');
  assert.equal(fixture.createCount(), 1);

  const unknownClient = padFixture({ ...normalizedOptions, clientVersion: '4.2.0' });
  const unknownResult = await batchRuntime(unknownClient.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.error.message, /not verified/);

  const mutations = [
    item => ({ ...item, x: item.x + 0.1 }),
    item => ({ ...item, pad: [item.pad[0], item.pad[1] + 0.1, item.pad[2]] }),
    item => ({ ...item, layer: 2 }),
    item => ({ ...item, net: 'MOTOR_V' }),
    item => ({ ...item, metallization: false }),
    item => ({ ...item, primitiveLock: true }),
    item => ({ ...item, padNumber: 'V' }),
    item => ({ ...item, hole: ['ROUND', 10, 10] }),
    item => ({ ...item, holeOffsetX: 0.1 }),
    item => ({ ...item, holeOffsetY: -0.1 }),
    item => ({ ...item, holeRotation: 1 }),
    item => ({ ...item, padType: 1 }),
  ];
  for (const mutateCreated of mutations) {
    const invalid = padFixture({ ...normalizedOptions, mutateCreated });
    const invalidResult = await batchRuntime(invalid.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
    assert.equal(invalidResult.ok, false);
    assert.match(invalidResult.error.message, /not verified/);
  }
});

test('P04H standalone SMD create is idempotent and delete accepts omitted defaults plus NaN native hole rotation', async () => {
  const definition = basePlan([{
    id: 'verify-smd-terminal',
    type: 'pad.create',
    layer: 'TOP',
    padNumber: 'VERIFY',
    position: [50, 71.5],
    shape: { type: 'ELLIPSE', width: 1.3, height: 1.1 },
    net: 'GND',
    metallization: true,
    locked: false,
  }]);
  definition.constraints.boardBounds = { minX: 0, minY: 0, maxX: 75, maxY: 75 };
  const plan = validatePlan(definition);
  const fixture = padFixture({
    clientVersion: '4.1.60',
    normalizeStandaloneSmdPad: true,
    normalizeStandaloneSmdPosition: true,
    omitStandaloneSmdDefaults: true,
    nanStandaloneSmdHoleRotation: true,
    divergentSingleGet: true,
  });
  const created = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(created.ok, true);
  assert.equal(created.results[0].status, 'created');
  const primitiveId = created.results[0].primitiveIds[0];
  assert.equal(fixture.createCount(), 1);

  const repeated = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.results[0].status, 'already_exists');
  assert.equal(fixture.createCount(), 1);

  const deleted = await batchRuntime(fixture.eda, {
    target,
    operations: [{ id: 'delete-verify', type: 'pad.delete', kind: 'pad', primitiveId, expected: plan.operations[0].state, set: null }],
    toleranceMil: plan.options.toleranceMil,
  });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.results[0].status, 'deleted');
  assert.equal(fixture.items().length, 0);
});

test('P04C client 4.1.60 matches exact half-grid bare NPTH slot dimensions from mil plans', async () => {
  const plan = validatePlan({
    schema: 'easyeda-pcb-plan/v2',
    intent: 'exact mil harness slot readback',
    target,
    units: 'mil',
    phase: 'layout',
    constraints: {
      minTrackWidth: 6,
      minViaHole: 12,
      minAnnularRing: 6,
      allowedLayers: ['TOP', 'BOTTOM', 'INNER_1', 'INNER_2'],
      boardBounds: { minX: 7000, minY: -3500, maxX: 9000, maxY: -1500 },
    },
    operations: [{
      id: 'phase-harness-tie-slot',
      type: 'hole.create',
      position: [7185, -2500],
      rotation: 90,
      hole: { type: 'SLOT', diameter: 78.74, length: 196.85 },
      locked: true,
    }],
  });
  const fixture = padFixture({ clientVersion: '4.1.60', normalizeBareNpthPad: true, normalizeBareNpthPadNumber: true });
  const result = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, 'created');
  assert.deepEqual(fixture.items()[0].pad, ['OVAL', 78.7, 196.9]);
  assert.deepEqual(fixture.items()[0].hole, ['SLOT', 78.74, 196.85]);
  assert.equal(fixture.items()[0].rotation, 90);
});

test('P04B bare NPTH normalization remains client-specific and does not relax mechanical identity', async () => {
  const plan = validatePlan(basePlan([
    { id: 'mh-round', type: 'hole.create', position: [5, 5], hole: { type: 'ROUND', diameter: 2.8 }, locked: true },
  ]));
  const unknownClient = padFixture({ clientVersion: '4.2.0', normalizeBareNpthPad: true, normalizeBareNpthPadNumber: true });
  const unknownResult = await batchRuntime(unknownClient.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.error.message, /not verified/);

  const mutations = [
    item => ({ ...item, pad: [item.pad[0], item.pad[1] - 0.1, item.pad[2] - 0.1] }),
    item => ({ ...item, hole: [item.hole[0], item.hole[1] + 0.1] }),
    item => ({ ...item, x: item.x + 0.1 }),
    item => ({ ...item, layer: 1 }),
    item => ({ ...item, net: 'GND' }),
    item => ({ ...item, metallization: true }),
    item => ({ ...item, primitiveLock: false }),
    item => ({ ...item, padNumber: 'WRONGHOLE' }),
  ];
  for (const mutateCreated of mutations) {
    const fixture = padFixture({ clientVersion: '4.1.60', normalizeBareNpthPad: true, normalizeBareNpthPadNumber: true, mutateCreated });
    const result = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /not verified/);
  }
});

test('P05 runtime returns a verified prefix and the continuation helper excludes it', async () => {
  const plan = validatePlan(basePlan([
    { id: 'first-hole', type: 'hole.create', position: [5, 5], hole: { type: 'ROUND', diameter: 2.8 } },
    { id: 'second-hole', type: 'hole.create', position: [15, 5], hole: { type: 'ROUND', diameter: 2.8 } },
    { id: 'third-hole', type: 'hole.create', position: [25, 5], hole: { type: 'ROUND', diameter: 2.8 } },
  ]));
  const fixture = padFixture({ failCreateAt: 2 });
  const result = await batchRuntime(fixture.eda, { target, operations: plan.operations, toleranceMil: plan.options.toleranceMil });
  assert.equal(result.ok, false);
  assert.equal(result.completedCount, 1);
  assert.equal(result.results[0].id, 'first-hole');
  assert.equal(result.error.operationId, 'second-hole');
  const continuation = continuationDetails(plan, result.results, result.error.operationId);
  assert.deepEqual(continuation.remainingOperationIds, ['second-hole', 'third-hole']);
  assert.equal(continuation.boardDelta.visibleBoardChange, true);
  assert.equal(continuation.boardDelta.changedOperationCount, 1);
  assert.deepEqual(continuation.boardDelta.changedByKind, { pad: 1 });
  assert.match(continuation.nextAction, /Do not replay the full plan/);
});

test('P06 pad.delete requires full old state and removes only the exact standalone pad', async () => {
  const createPlan = validatePlan(basePlan([{ id: 'mh', type: 'hole.create', position: [5, 5], hole: { type: 'ROUND', diameter: 2.8 } }]));
  const fixture = padFixture();
  const created = await batchRuntime(fixture.eda, { target, operations: createPlan.operations, toleranceMil: createPlan.options.toleranceMil });
  const primitiveId = created.results[0].primitiveIds[0];
  const state = createPlan.operations[0].state;
  const deleteResult = await batchRuntime(fixture.eda, { target, operations: [{ id: 'delete-mh', type: 'pad.delete', kind: 'pad', primitiveId, expected: state, set: null }], toleranceMil: createPlan.options.toleranceMil });
  assert.equal(deleteResult.ok, true);
  assert.equal(deleteResult.results[0].status, 'deleted');
  assert.equal(fixture.items().length, 0);
});

test('P07 boardDelta rejects verified no-ops as visible PCB progress', () => {
  const plan = validatePlan(basePlan([
    { id: 'existing-hole', type: 'hole.create', position: [5, 5], hole: { type: 'ROUND', diameter: 2.8 } },
    { id: 'next-hole', type: 'hole.create', position: [15, 5], hole: { type: 'ROUND', diameter: 2.8 } },
  ]));
  const delta = summarizeBoardDelta(plan, [{ id: 'existing-hole', status: 'already_exists', primitiveIds: ['pad-1'], verified: true }], ['next-hole']);
  assert.equal(delta.visibleBoardChange, false);
  assert.equal(delta.progressClass, 'NO_BOARD_CHANGE');
  assert.equal(delta.changedOperationCount, 0);
  assert.equal(delta.unchangedOperationCount, 1);
  assert.deepEqual(delta.remainingOperationIds, ['next-hole']);
  assert.match(delta.nextAction, /Do not report PCB progress/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConstraintCode, constraintRuntime } from '../src/constraint-runtime.mjs';
import { buildPcbToolsCode, pcbToolsRuntime } from '../src/pcb-tools-runtime.mjs';

const target = { documentUuid: 'pcb-api-test', projectUuid: 'project-api-test' };

function pcbFixture() {
  let filled = false;
  let imported = false;
  let realtime = false;
  const components = [];
  const applyImport = () => {
    imported = true;
    if (!components.some(item => item.primitiveId === 'component-imported')) components.push({ primitiveId: 'component-imported', designator: 'U1' });
  };
  const pour = {
    primitiveId: 'pour-1', net: 'GND', layer: 1,
    rebuildCopperRegion: async () => { filled = true; return { primitiveId: 'poured-1' }; },
  };
  const project = {
    uuid: target.projectUuid,
    name: 'project',
    data: [{ name: 'board', pcb: { uuid: target.documentUuid, name: 'PCB1' }, schematic: { uuid: 'sch-1', name: 'SCH', page: [{ uuid: 'page-1', name: 'P1', parentSchematicUuid: 'sch-1' }] } }],
  };
  const emptyApi = { getAll: async () => [] };
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: target.documentUuid, documentType: 3 }) },
    dmt_Project: { getCurrentProjectInfo: async () => project },
    sys_Environment: { getEditorCurrentVersion: async () => '3.2.test' },
    pcb_PrimitiveComponent: {
      getAll: async () => components,
      getAllPinsByPrimitiveId: async () => [],
    },
    pcb_PrimitivePad: { ...emptyApi },
    pcb_PrimitiveLine: { ...emptyApi },
    pcb_PrimitiveVia: { ...emptyApi },
    pcb_PrimitivePour: { getAll: async () => [pour] },
    pcb_PrimitivePoured: { getAll: async () => filled ? [{ primitiveId: 'poured-1', pourPrimitiveId: 'pour-1', pourFills: [{ layer: 1, polygons: [[1, 2, 3]] }] }] : [] },
    pcb_PrimitiveString: { ...emptyApi, create: async () => {}, modify: async () => {} },
    pcb_PrimitiveAttribute: { ...emptyApi, modify: async () => {} },
    pcb_Net: { getNetlist: async () => ({ nets: imported ? ['NEW'] : [] }) },
    pcb_Document: {
      getPrimitiveAtPoint: async (x, y) => [{ primitiveId: 'hit', primitiveType: 'Pad', x, y }],
      getPrimitivesInRegion: async () => [{ primitiveId: 'r1', primitiveType: 'Line' }, { primitiveId: 'r2', primitiveType: 'Via' }],
      importChanges: async () => { applyImport(); return true; },
      autoRouting: async () => true,
      autoLayout: async () => true,
    },
    pcb_Drc: {
      getAllNetClasses: async () => [],
      getAllDifferentialPairs: async () => [],
      getRealTimeDrcStatus: async () => realtime,
      startRealTimeDrc: async () => { realtime = true; return true; },
      stopRealTimeDrc: async () => { realtime = false; return true; },
    },
    pcb_ManufactureData: { getGerberFile: async () => ({}) },
  };
  return { eda, isFilled: () => filled, isImported: () => imported, applyImport };
}

test('capabilities report APIs but keep automatic placement/routing unexposed', async () => {
  const fixture = pcbFixture();
  const result = await pcbToolsRuntime(fixture.eda, { kind: 'capabilities', target });
  assert.equal(result.clientVersion, '3.2.test');
  assert.equal(result.methods.rebuildCopperRegionsStatic, false);
  assert.equal(result.methods.rebuildCopperRegionInstance, true);
  assert.equal(result.methods.autoRouting, true);
  assert.equal(result.policy.automaticPlacementAndRoutingExposed, false);
  assert.equal(fixture.isFilled(), false);
});

test('native point and region queries do not mutate editor state', async () => {
  const fixture = pcbFixture();
  const point = await pcbToolsRuntime(fixture.eda, { kind: 'pick', target, mode: 'point', units: 'mm', point: { x: 2.54, y: 5.08 } });
  assert.equal(point.executionPath, 'native');
  assert.equal(point.total, 1);
  assert.equal(point.items[0].x, 100);
  assert.equal(point.items[0].y, 200);
  const region = await pcbToolsRuntime(fixture.eda, { kind: 'pick', target, mode: 'region', units: 'mil', region: { left: 0, right: 100, top: 100, bottom: 0 }, offset: 1, limit: 1 });
  assert.equal(region.total, 2);
  assert.equal(region.items[0].primitiveId, 'r2');
});

test('native region serialization failure falls back to typed primitives and bounds', async () => {
  const fixture = pcbFixture();
  fixture.eda.pcb_Document.getPrimitivesInRegion = async () => { throw new Error('single polygon validation failed'); };
  fixture.eda.pcb_PrimitiveLine.getAll = async () => [{ primitiveId: 'line-fallback', primitiveType: 'Line', net: 'N', layer: 1, startX: 10, startY: 10, endX: 90, endY: 10, lineWidth: 8 }];
  const region = await pcbToolsRuntime(fixture.eda, { kind: 'pick', target, mode: 'region', units: 'mil', region: { left: 0, right: 100, top: 100, bottom: 0, fullyContained: false }, offset: 0, limit: 10 });
  assert.equal(region.executionPath, 'typed-fallback');
  assert.match(region.nativeError, /polygon/);
  assert.equal(region.total, 1);
  assert.equal(region.items[0].primitiveId, 'line-fallback');
  assert.equal(region.items[0].sourceKind, 'line');
});

test('repour uses public per-pour fallback and reads Poured data', async () => {
  const fixture = pcbFixture();
  const result = await pcbToolsRuntime(fixture.eda, { kind: 'rebuildPours', target, pourIds: ['pour-1'] });
  assert.equal(result.executionPath, 'instance-fallback');
  assert.equal(result.after[0].nonEmpty, true);
  assert.deepEqual(result.missingFillIds, []);
  assert.equal(fixture.isFilled(), true);
});

test('repour refuses unknown boundary IDs before any write', async () => {
  const fixture = pcbFixture();
  await assert.rejects(pcbToolsRuntime(fixture.eda, { kind: 'rebuildPours', target, pourIds: ['missing'] }), /Unknown pour/);
  assert.equal(fixture.isFilled(), false);
});

test('real-time DRC supports status, start and stop', async () => {
  const fixture = pcbFixture();
  assert.equal((await pcbToolsRuntime(fixture.eda, { kind: 'realTimeDrc', target, action: 'status' })).after, false);
  assert.equal((await pcbToolsRuntime(fixture.eda, { kind: 'realTimeDrc', target, action: 'start' })).after, true);
  assert.equal((await pcbToolsRuntime(fixture.eda, { kind: 'realTimeDrc', target, action: 'stop' })).after, false);
});

test('schematic import is guarded by the runtime snapshot hash', async () => {
  const fixture = pcbFixture();
  const prepared = await pcbToolsRuntime(fixture.eda, { kind: 'syncSnapshot', target });
  await assert.rejects(pcbToolsRuntime(fixture.eda, { kind: 'importChanges', target, schematicUuid: 'sch-1', expectedRuntimeHash: 'bad' }), /changed after synchronization preflight/);
  assert.equal(fixture.isImported(), false);
  const imported = await pcbToolsRuntime(fixture.eda, { kind: 'importChanges', target, schematicUuid: 'sch-1', expectedRuntimeHash: prepared.runtimeHash });
  assert.equal(imported.imported, true);
  assert.notEqual(imported.before.runtimeHash, imported.after.runtimeHash);
  assert.equal(fixture.isImported(), true);
});

test('schematic import applies the native EasyEDA confirmation before reporting imported', async () => {
  const fixture = pcbFixture();
  let dialogVisible = false;
  fixture.eda.pcb_Document.importChanges = async () => { dialogVisible = true; return true; };
  const button = {
    disabled: false,
    getAttribute: name => name === 'data-test' ? 'Apply Changes' : null,
    click: () => { fixture.applyImport(); dialogVisible = false; },
  };
  const previousDocument = globalThis.document;
  globalThis.document = {
    getElementById: id => id === 'dlgShowImportChanges' && dialogVisible
      ? { querySelectorAll: selector => selector === 'button' ? [button] : [] }
      : null,
  };
  try {
    const prepared = await pcbToolsRuntime(fixture.eda, { kind: 'syncSnapshot', target });
    const imported = await pcbToolsRuntime(fixture.eda, { kind: 'importChanges', target, schematicUuid: 'sch-1', expectedRuntimeHash: prepared.runtimeHash });
    assert.equal(imported.nativeAccepted, true);
    assert.equal(imported.confirmationUiAvailable, true);
    assert.equal(imported.confirmationRequired, true);
    assert.equal(imported.confirmationApplied, true);
    assert.equal(imported.imported, true);
    assert.notEqual(imported.before.runtimeHash, imported.after.runtimeHash);
    assert.equal(fixture.isImported(), true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('native import acceptance without PCB mutation is not reported as imported', async () => {
  const fixture = pcbFixture();
  fixture.eda.pcb_Document.importChanges = async () => true;
  const previousDocument = globalThis.document;
  delete globalThis.document;
  try {
    const prepared = await pcbToolsRuntime(fixture.eda, { kind: 'syncSnapshot', target });
    const result = await pcbToolsRuntime(fixture.eda, { kind: 'importChanges', target, schematicUuid: 'sch-1', expectedRuntimeHash: prepared.runtimeHash });
    assert.equal(result.nativeAccepted, true);
    assert.equal(result.confirmationUiAvailable, false);
    assert.equal(result.confirmationRequired, false);
    assert.equal(result.confirmationApplied, false);
    assert.equal(result.imported, false);
    assert.equal(result.changed, false);
    assert.equal(result.before.runtimeHash, result.after.runtimeHash);
  } finally {
    if (previousDocument !== undefined) globalThis.document = previousDocument;
  }
});

function constraintFixture() {
  let netClasses = [];
  let pairs = {};
  let equalGroups = [];
  let padGroups = [];
  const find = (items, name) => items.find(item => item.name === name);
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: target.documentUuid, documentType: 3 }) },
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: target.projectUuid }) },
    pcb_Drc: {
      getCurrentRuleConfiguration: async () => ({ name: 'Default' }),
      getAllRuleConfigurations: async () => [{ name: 'Default' }],
      getNetRules: async () => ({}),
      getNetByNetRules: async () => ({}),
      getRegionRules: async () => [],
      getRealTimeDrcStatus: async () => false,
      getAllNetClasses: async () => netClasses,
      createNetClass: async (name, nets, color) => { netClasses.push({ name, nets: [...nets], color }); return true; },
      deleteNetClass: async name => { netClasses = netClasses.filter(item => item.name !== name); return true; },
      modifyNetClassName: async (name, newName) => { find(netClasses, name).name = newName; return true; },
      addNetToNetClass: async (name, nets) => { const item = find(netClasses, name); item.nets = [...new Set([...item.nets, ...(Array.isArray(nets) ? nets : [nets])])]; return true; },
      removeNetFromNetClass: async (name, nets) => { const remove = new Set(Array.isArray(nets) ? nets : [nets]); const item = find(netClasses, name); item.nets = item.nets.filter(net => !remove.has(net)); return true; },
      getAllDifferentialPairs: async () => pairs,
      createDifferentialPair: async (name, positiveNet, negativeNet) => { pairs[name] = { name, positiveNet, negativeNet }; return true; },
      deleteDifferentialPair: async name => { delete pairs[name]; return true; },
      modifyDifferentialPairName: async (name, newName) => { pairs[newName] = { ...pairs[name], name: newName }; delete pairs[name]; return true; },
      modifyDifferentialPairPositiveNet: async (name, net) => { pairs[name].positiveNet = net; return true; },
      modifyDifferentialPairNegativeNet: async (name, net) => { pairs[name].negativeNet = net; return true; },
      getAllEqualLengthNetGroups: async () => equalGroups,
      createEqualLengthNetGroup: async (name, nets, color) => { equalGroups.push({ name, nets: [...nets], color }); return true; },
      deleteEqualLengthNetGroup: async name => { equalGroups = equalGroups.filter(item => item.name !== name); return true; },
      modifyEqualLengthNetGroupName: async (name, newName) => { find(equalGroups, name).name = newName; return true; },
      addNetToEqualLengthNetGroup: async () => true,
      removeNetFromEqualLengthNetGroup: async () => true,
      getAllPadPairGroups: async () => padGroups,
      createPadPairGroup: async (name, padPairs) => { padGroups.push({ name, padPairs: [...padPairs] }); return true; },
      deletePadPairGroup: async name => { padGroups = padGroups.filter(item => item.name !== name); return true; },
      modifyPadPairGroupName: async (name, newName) => { find(padGroups, name).name = newName; return true; },
      addPadPairToPadPairGroup: async () => true,
      removePadPairFromPadPairGroup: async () => true,
    },
  };
  return { eda, setPairs: value => { pairs = value; } };
}

test('constraint reader normalizes array/object API version differences', async () => {
  const fixture = constraintFixture();
  fixture.setPairs({ DP: { name: 'DP', positiveNet: 'USB_DP', negativeNet: 'USB_DM' } });
  const result = await constraintRuntime(fixture.eda, { kind: 'read', target });
  assert.deepEqual(result.differentialPairs, [{ name: 'DP', positiveNet: 'USB_DP', negativeNet: 'USB_DM' }]);
  assert.equal(result.currentRuleConfiguration.available, true);
});

test('constraint group create is idempotent and add-members uses exact old state', async () => {
  const fixture = constraintFixture();
  const definition = { nets: ['N2', 'N1'], color: { r: 1, g: 2, b: 3, alpha: 1 } };
  const created = await constraintRuntime(fixture.eda, { kind: 'manage', target, operation: { action: 'create', groupType: 'netClass', name: 'FAST', expected: null, definition } });
  assert.equal(created.status, 'created');
  const again = await constraintRuntime(fixture.eda, { kind: 'manage', target, operation: { action: 'create', groupType: 'netClass', name: 'FAST', expected: null, definition } });
  assert.equal(again.status, 'already_exists');
  await assert.rejects(
    constraintRuntime(fixture.eda, { kind: 'manage', target, operation: { action: 'addMembers', groupType: 'netClass', name: 'FAST', expected: { ...created.after, nets: [] }, members: ['N3'] } }),
    /Old-value assertion/,
  );
});

test('constraint group member edit reads back canonical state', async () => {
  const fixture = constraintFixture();
  const definition = { nets: ['N1'], color: { r: 1, g: 2, b: 3, alpha: 1 } };
  const created = await constraintRuntime(fixture.eda, { kind: 'manage', target, operation: { action: 'create', groupType: 'netClass', name: 'FAST', expected: null, definition } });
  const result = await constraintRuntime(fixture.eda, { kind: 'manage', target, operation: { action: 'addMembers', groupType: 'netClass', name: 'FAST', expected: created.after, members: ['N2'] } });
  assert.equal(result.status, 'members_added');
  assert.deepEqual(result.after.nets, ['N1', 'N2']);
});

test('serialized advanced runtimes are self-contained', () => {
  const pcbCode = buildPcbToolsCode({ kind: 'capabilities', target });
  const constraintCode = buildConstraintCode({ kind: 'read', target });
  assert.doesNotMatch(pcbCode + constraintCode, /node:/);
  assert.match(pcbCode, /automaticPlacementAndRoutingExposed/);
  assert.match(constraintCode, /Old-value assertion/);
});

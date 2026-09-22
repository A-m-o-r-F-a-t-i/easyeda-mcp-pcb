import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { compareAssociatedNetlistsRuntime } from '../src/netlist-compare.mjs';
import { decodeManufacturingFile, exportManufacturingFile, manufacturingFileRuntime } from '../src/manufacturing.mjs';
import { inspectionViewRuntime } from '../src/inspection-view.mjs';
import { parseComplexPolygon, renderInspectionSvg, renderSnapshotSvg } from '../src/vector-inspection.mjs';
import { decodeBackup } from '../src/backup.mjs';

const target = { documentUuid: 'pcb-1', projectUuid: 'project-1', windowId: 'window-1' };
const document = { uuid: target.documentUuid, documentType: 3, tabId: 'pcb-tab-1' };
const project = {
  uuid: target.projectUuid,
  name: 'Test Project',
  data: [{ name: 'Board1', pcb: { uuid: target.documentUuid, name: 'PCB1' }, schematic: { uuid: 'sch-1', name: 'SCH1' } }],
};
const baseEda = () => ({
  dmt_SelectControl: { getCurrentDocumentInfo: async () => document },
  dmt_Project: { getCurrentProjectInfo: async () => project },
});

function netlistFixture(responses) {
  let calls = 0;
  return {
    eda: {
      ...baseEda(),
      sys_Tool: { netlistComparison: async () => responses[Math.min(calls++, responses.length - 1)] },
    },
    calls: () => calls,
  };
}

const compareRequest = { target, expectedSchematicUuid: 'sch-1', offset: 0, limit: 10 };

test('V1701 associated netlist comparison normalizes runtime field aliases and requires two stable reads', async () => {
  const diff = [{ type: 'NET', object: 'U1.1', net1: ['SCL'], net2: ['SDA'] }, { type: 'COMPONENT', object: 'U1', netlist1Name: ['MCU'], netlist2Name: [] }];
  const fixture = netlistFixture([diff, structuredClone(diff)]);
  const result = await compareAssociatedNetlistsRuntime(fixture.eda, compareRequest);
  assert.equal(fixture.calls(), 2);
  assert.equal(result.stableReads, 2);
  assert.equal(result.total, 2);
  assert.deepEqual(result.counts, { net: 1, component: 1 });
  assert.equal(result.inSync, false);
  assert.deepEqual(result.items.find(item => item.type === 'Net'), { type: 'Net', object: 'U1.1', schematicEntries: ['SCL'], pcbEntries: ['SDA'] });
});

test('V1701A limit zero paginates only items and preserves full comparison summary', async () => {
  const diff = [
    { type: 'NET', object: 'SCL', net1: ['U1.1'], net2: ['U1.2'] },
    { type: 'COMPONENT', object: 'U1', netlist1Name: ['MCU'], netlist2Name: [] },
  ];
  const fixture = netlistFixture([diff, structuredClone(diff)]);
  const result = await compareAssociatedNetlistsRuntime(fixture.eda, { ...compareRequest, limit: 0 });
  assert.equal(result.total, 2);
  assert.deepEqual(result.counts, { net: 1, component: 1 });
  assert.equal(result.inSync, false);
  assert.deepEqual(result.items, []);
  assert.equal(result.hasMore, true);
});

test('V1702 netlist comparison rejects drift between the two reads', async () => {
  const fixture = netlistFixture([[], [{ type: 'Net', object: 'R1.1', net1: ['A'], net2: ['B'] }]]);
  await assert.rejects(compareAssociatedNetlistsRuntime(fixture.eda, compareRequest), /changed during two reads/);
});

test('V1703 netlist comparison rejects association mismatch before accepting results', async () => {
  const fixture = netlistFixture([[], []]);
  await assert.rejects(compareAssociatedNetlistsRuntime(fixture.eda, { ...compareRequest, expectedSchematicUuid: 'other' }), /does not match/);
  assert.equal(fixture.calls(), 0);
});

test('V1703A native empty PCB net entries are reconciled against actual component pin nets', async () => {
  const native = [{ type: 'NET', object: "'SCL'", net1: ['U1.1', 'R1.2'], net2: [] }];
  const fixture = netlistFixture([native, structuredClone(native)]);
  const components = [
    { primitiveId: 'c1', designator: 'U1' },
    { primitiveId: 'c2', designator: 'R1' },
  ];
  const pins = {
    c1: [{ primitiveId: 'p1', padNumber: '1', net: 'SCL' }],
    c2: [{ primitiveId: 'p2', padNumber: '2', net: 'SCL' }],
  };
  fixture.eda.pcb_PrimitiveComponent = {
    getAll: async () => components,
    getAllPinsByPrimitiveId: async id => pins[id],
  };
  const result = await compareAssociatedNetlistsRuntime(fixture.eda, compareRequest);
  assert.equal(result.nativeDifferenceCount, 1);
  assert.equal(result.pcbNetMembershipVerified, true);
  assert.equal(result.total, 0);
  assert.equal(result.inSync, true);
});

test('V1703B pin-derived PCB membership preserves real net mismatches', async () => {
  const native = [{ type: 'NET', object: 'SCL', net1: ['U1.1', 'R1.2'], net2: [] }];
  const fixture = netlistFixture([native, structuredClone(native)]);
  fixture.eda.pcb_PrimitiveComponent = {
    getAll: async () => [{ primitiveId: 'c1', designator: 'U1' }, { primitiveId: 'c2', designator: 'R1' }],
    getAllPinsByPrimitiveId: async id => id === 'c1'
      ? [{ primitiveId: 'p1', padNumber: '1', net: 'SCL' }]
      : [{ primitiveId: 'p2', padNumber: '2', net: 'OTHER' }],
  };
  const result = await compareAssociatedNetlistsRuntime(fixture.eda, compareRequest);
  assert.equal(result.total, 1);
  assert.deepEqual(result.items[0].pcbEntries, ['U1.1']);
});

test('V1704 serialized netlist comparison runtime is extension-safe', () => {
  const fn = new Function('eda', 'request', `return (${compareAssociatedNetlistsRuntime.toString()})(eda,request)`);
  assert.equal(typeof fn, 'function');
  assert.doesNotMatch(compareAssociatedNetlistsRuntime.toString(), /node:|Buffer\.|process\./);
});

const zipBytes = Uint8Array.from([80, 75, 3, 4, 1, 2, 3, 4, 5]);
const textBytes = Uint8Array.from([42, 80, 67, 66, 42, 10]);
function fileOf(bytes, name = 'output.zip', type = 'application/octet-stream') {
  return { name, type, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}
function manufacturingFixture() {
  const calls = [];
  const eda = {
    ...baseEda(),
    pcb_ManufactureData: {
      getGerberFile: async (...args) => { calls.push(['gerber', ...args]); return fileOf(zipBytes, 'gerber.zip', 'application/zip'); },
      getPickAndPlaceFile: async (...args) => { calls.push(['pickAndPlace', ...args]); return fileOf(zipBytes, 'pnp.xlsx'); },
      getBomFile: async (...args) => { calls.push(['bom', ...args]); return fileOf(zipBytes, 'bom.xlsx'); },
      getTestPointFile: async (...args) => { calls.push(['testPoints', ...args]); return fileOf(zipBytes, 'test.xlsx'); },
      getNetlistFile: async (...args) => { calls.push(['netlist', ...args]); return fileOf(textBytes, 'board.net', 'text/plain'); },
      getIpcD356AFile: async (...args) => { calls.push(['ipcD356A', ...args]); return fileOf(textBytes, 'board.ipc', 'text/plain'); },
    },
  };
  return { eda, calls };
}

test('V1705 Gerber export uses the public File API and preserves bounded bytes', async () => {
  const fixture = manufacturingFixture();
  const payload = await manufacturingFileRuntime(fixture.eda, { target, kind: 'gerber', fileName: 'board', format: null, unit: null, netlistType: null, expectArchive: true, maxBytes: 100 });
  assert.deepEqual(fixture.calls, [['gerber', 'board']]);
  assert.deepEqual(decodeManufacturingFile(payload, 100, true), Buffer.from(zipBytes));
});

test('V1706 typed manufacturing variants pass explicit format, unit and netlist type', async () => {
  const fixture = manufacturingFixture();
  await manufacturingFileRuntime(fixture.eda, { target, kind: 'pickAndPlace', fileName: 'pnp', format: 'xlsx', unit: 'mm', netlistType: null, expectArchive: true, maxBytes: 100 });
  await manufacturingFileRuntime(fixture.eda, { target, kind: 'netlist', fileName: 'net', format: null, unit: null, netlistType: 'JLCEDA', expectArchive: false, maxBytes: 100 });
  assert.deepEqual(fixture.calls, [['pickAndPlace', 'pnp', 'xlsx', 'mm'], ['netlist', 'net', 'JLCEDA']]);
});

test('V1707 oversized manufacturing File is rejected before arrayBuffer transfer', async () => {
  const fixture = manufacturingFixture();
  let reads = 0;
  fixture.eda.pcb_ManufactureData.getGerberFile = async () => ({ name: 'large.zip', size: 101, arrayBuffer: async () => { reads += 1; return zipBytes.buffer; } });
  await assert.rejects(manufacturingFileRuntime(fixture.eda, { target, kind: 'gerber', fileName: 'large', format: null, unit: null, netlistType: null, expectArchive: true, maxBytes: 100 }), /exceeds/);
  assert.equal(reads, 0);
});

test('V1708 manufacturing decoder rejects corrupted archive and noncanonical payloads', () => {
  assert.throws(() => decodeManufacturingFile({ encoding: 'base64', size: 4, data: 'AAAAAA==' }, 100, true), /signature/);
  assert.throws(() => decodeManufacturingFile({ encoding: 'base64', size: 2, data: '!!!!' }, 100, false), /base64/);
});

test('V1709 manufacturing wrapper rejects wrong extension before Bridge access', async () => {
  await assert.rejects(exportManufacturingFile({ target, kind: 'gerber', outputPath: path.resolve('wrong.xlsx') }), /absolute \.zip/);
  await assert.rejects(exportManufacturingFile({ target, kind: 'netlist', outputPath: path.resolve('wrong.txt') }), /absolute \.net/);
});

test('V1710 serialized manufacturing runtime is extension-safe', () => {
  const fn = new Function('eda', 'request', `return (${manufacturingFileRuntime.toString()})(eda,request)`);
  assert.equal(typeof fn, 'function');
  assert.doesNotMatch(manufacturingFileRuntime.toString(), /node:|Buffer\.|process\./);
});

function viewFixture({ invalidPng = false, failRestore = false } = {}) {
  const layers = [
    { id: 1, name: 'Top', layerStatus: 1, locked: false },
    { id: 2, name: 'Bottom', layerStatus: 2, locked: false },
    { id: 3, name: 'TopSilk', layerStatus: 1, locked: false },
    { id: 99, name: 'Disabled', layerStatus: 0, locked: false },
  ];
  let currentLayerId = 1;
  let imageReads = 0;
  const png = invalidPng ? Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]) : Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const eda = {
    ...baseEda(),
    dmt_EditorControl: {
      getCurrentRenderedAreaImage: async () => { imageReads += 1; return fileOf(png, 'view.png', 'image/png'); },
    },
    pcb_Layer: {
      getAllLayers: async () => layers.map(row => ({ ...row })),
      setLayerVisible: async (ids, hideOthers = false) => {
        if (failRestore && !hideOthers) return false;
        if (hideOthers) for (const row of layers) if (row.layerStatus === 1 || row.layerStatus === 2) row.layerStatus = 2;
        for (const id of ids) layers.find(row => row.id === id).layerStatus = 1;
        return true;
      },
      setLayerInvisible: async ids => { for (const id of ids) layers.find(row => row.id === id).layerStatus = 2; return true; },
      getCurrentLayer: async () => ({ id: currentLayerId }),
      selectLayer: async id => { currentLayerId = id; return true; },
    },
  };
  return { eda, imageReads: () => imageReads, layers: () => layers.map(row => ({ ...row })) };
}

const inspectionRequest = { target, visibleLayerIds: [1], settleMs: 0, maxBytes: 100 };

test('V1711 inspection capture isolates enabled layers without viewport APIs and restores exact state', async () => {
  const fixture = viewFixture();
  const result = await inspectionViewRuntime(fixture.eda, inspectionRequest);
  assert.equal(result.restorationVerified, true);
  assert.equal(result.temporaryLayerMutation, true);
  assert.equal(result.viewportUnchanged, true);
  assert.equal(fixture.imageReads(), 1);
  assert.deepEqual(result.capturedLayers.map(row => [row.id, row.layerStatus]), [[1, 1], [2, 2], [3, 2], [99, 0]]);
  assert.deepEqual(fixture.layers().map(row => [row.id, row.layerStatus]), [[1, 1], [2, 2], [3, 1], [99, 0]]);
  assert.deepEqual(decodeBackup(result, 100, 'png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
});

test('V1712 capture failure still restores enabled, hidden and disabled layer states', async () => {
  const fixture = viewFixture({ invalidPng: true });
  await assert.rejects(inspectionViewRuntime(fixture.eda, inspectionRequest), /PNG signature/);
  assert.deepEqual(fixture.layers().map(row => [row.id, row.layerStatus]), [[1, 1], [2, 2], [3, 1], [99, 0]]);
});

test('V1713 failed layer restoration is surfaced and no successful payload is returned', async () => {
  const fixture = viewFixture({ failRestore: true });
  await assert.rejects(inspectionViewRuntime(fixture.eda, inspectionRequest), /layer restoration failed/);
});

test('V1714 serialized inspection runtime is extension-safe and contains no zoom operation', () => {
  const fn = new Function('eda', 'request', `return (${inspectionViewRuntime.toString()})(eda,request)`);
  assert.equal(typeof fn, 'function');
  assert.doesNotMatch(inspectionViewRuntime.toString(), /node:|Buffer\.|process\.|zoomTo/);
});

const vectorSnapshot = {
  units: 'mil',
  document,
  layers: [
    { id: 1, name: 'Top', type: 'SIGNAL', color: '#ff0000', layerStatus: 1 },
    { id: 2, name: 'Bottom', type: 'SIGNAL', color: '#0000ff', layerStatus: 0 },
    { id: 3, name: 'Top Silk', type: 'SILKSCREEN', color: '#ffcc00', layerStatus: 1 },
    { id: 12, name: 'Multi', type: 'OTHER', color: '#c0c0c0', layerStatus: 1 },
  ],
  components: [{ primitiveId: 'c1', designator: 'U<1>', layer: 1, x: 50, y: 50, rotation: 0 }],
  pads: [{ primitiveId: 'p1', padNumber: '1', net: 'A&B', layer: 1, x: 20, y: 20, rotation: 0, pad: ['RECT', 20, 10, 0], hole: null }],
  lines: [{ primitiveId: 'l1', net: 'A&B', layer: 1, startX: 0, startY: 0, endX: 100, endY: 0, lineWidth: 10 }],
  vias: [{ primitiveId: 'v1', net: 'A&B', x: 50, y: 0, diameter: 24, holeDiameter: 12 }],
  pours: [{ primitiveId: 'pour1', net: 'GND', layer: 1, complexPolygon: [0, 0, 'L', 100, 0, 100, 100, 0, 100] }],
  poured: [{ primitiveId: 'pour1', pourPrimitiveId: 'pour1', pourFills: [{ path: { complexPolygon: [[0, 0, 'L', 10, 0, 10, 10, 0, 10]] } }], pourFillsMil: [{ fill: true, lineWidth: 0, path: { complexPolygon: [[0, 0, 'L', 100, 0, 100, 100, 0, 100]] } }], fillGeometry: { verified: true, units: 'mil', coordinateScaleToMil: 10, rawUnits: '0.254 mm', evidence: 'test-fixture-matches-runtime-contract' } }],
  fills: [],
  arcs: [],
  regions: [],
  strings: [],
  attributes: [{ primitiveId: 'a1', parentPrimitiveId: 'c1', layer: 3, x: 50, y: 50, rotation: 0, fontSize: 20, key: 'Designator', value: '<U&1>', valueVisible: true, keyVisible: false }],
};

test('V1715 vector renderer is deterministic, XML-safe and reconstructs typed geometry', () => {
  const first = renderSnapshotSvg(structuredClone(vectorSnapshot), { layerMode: 'visible', designators: 'visible', marginMil: 5 });
  const second = renderSnapshotSvg(structuredClone(vectorSnapshot), { layerMode: 'visible', designators: 'visible', marginMil: 5 });
  assert.equal(first.svg, second.svg);
  assert.match(first.svg, /&lt;U&amp;1&gt;/);
  assert.match(first.svg, /A&amp;B/);
  assert.equal(first.counts.lines, 1);
  assert.equal(first.counts.pads, 1);
  assert.equal(first.counts.vias, 1);
  assert.equal(first.counts.poured, 1);
  assert.equal(first.counts.text, 1);
  assert.deepEqual(first.renderedLayers.map(layer => layer.id), [1, 3, 12]);
});

test('V1716 explicit layer selection and region cropping are enforced', () => {
  const result = renderSnapshotSvg(vectorSnapshot, {
    layerMode: 'explicit',
    layerIds: [1],
    designators: 'none',
    region: { minX: 0, minY: -10, maxX: 60, maxY: 30 },
    marginMil: 0,
  });
  assert.deepEqual(result.renderedLayers.map(layer => layer.id), [1]);
  assert.deepEqual(result.viewBox, { minX: 0, minY: -10, maxX: 60, maxY: 30 });
  assert.throws(() => renderSnapshotSvg(vectorSnapshot, { layerMode: 'explicit', layerIds: [999] }), /existing layerIds/);
});

test('V1716A vector renderer refuses raw poured coordinates without verified canonical mil geometry', () => {
  const unverified = structuredClone(vectorSnapshot);
  delete unverified.poured[0].pourFillsMil;
  delete unverified.poured[0].fillGeometry;
  assert.throws(() => renderSnapshotSvg(unverified, { layerMode: 'visible' }), /verified canonical mil geometry/);
});

test('V1717 complex polygon parser supports line, arc and rectangle encodings', () => {
  const polygon = parseComplexPolygon([0, 0, 'L', 10, 0, 'ARC', 90, 10, 10, 0, 10]);
  const rectangle = parseComplexPolygon(['R', 50, 50, 20, 10, 0, 0]);
  assert.equal(polygon.length, 1);
  assert.match(polygon[0].d, / A /);
  assert.deepEqual(rectangle[0].bounds, { minX: 40, minY: 45, maxX: 60, maxY: 55 });
});

test('V1718 vector wrapper rejects wrong extension before Bridge access', async () => {
  await assert.rejects(renderInspectionSvg({ target, outputPath: path.resolve('wrong.png') }), /absolute \.svg/);
});

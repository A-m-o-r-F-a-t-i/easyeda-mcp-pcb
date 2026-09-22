import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { analyzeConnectivity } from '../src/connectivity.mjs';
import { createAtomicExport } from '../src/export.mjs';
import { getToolRegistry, invokeRegisteredTool } from '../src/server.mjs';
import { assertGuardMatchesPlan } from '../src/guarded-plan.mjs';
import { hashObject } from '../src/gateway-client.mjs';

const pad = (id, x, layer = 1) => ({ primitiveId: id, net: 'N1', layer, x, y: 0, rotation: 0, pad: ['ELLIPSE', 1, 1], hole: null, metallization: true, padNumber: id });
const line = (id, x1, x2, layer = 1) => ({ primitiveId: id, net: 'N1', layer, startX: x1, startY: 0, endX: x2, endY: 0, lineWidth: 0.2 });
const snapshot = overrides => ({ units: 'mm', pads: [pad('P1', 0), pad('P2', 10)], lines: [], vias: [], arcs: [], fills: [], poured: [], regions: [], ...overrides });

test('Fixture A: an explicitly missing trace produces disconnected pad groups', () => {
  const result = analyzeConnectivity(snapshot(), { nativeUnroutedCount: 1 });
  assert.equal(result.connectivityVerdict, 'DISCONNECTED');
  assert.equal(result.modeledSplitPadNetCount, 1);
  assert.equal(result.nets[0].padGroupCount, 2);
});
test('Fixture B: same-net separated copper islands remain separate', () => {
  const value = snapshot({ lines: [line('L1', 0, 4), line('L2', 6, 10)] });
  const result = analyzeConnectivity(value, { nativeUnroutedCount: 0 });
  assert.equal(result.connectivityVerdict, 'DISCONNECTED');
  assert.equal(result.nets[0].modeledComponentCount, 2);
  assert.equal(result.nativeCrossCheck.agreement, 'DISAGREEMENT_REQUIRES_REVIEW');
});
test('Fixture C: pour-only connectivity is PARTIAL until actual fill geometry is modeled', () => {
  const result = analyzeConnectivity(snapshot({ poured: [{ primitiveId: 'copper-fill', net: 'N1' }] }), { nativeUnroutedCount: 0 });
  assert.equal(result.connectivityVerdict, 'PARTIAL');
  assert.equal(result.nativeCrossCheck.agreement, 'NOT_COMPARABLE_WITH_PARTIAL_COVERAGE');
});
test('straight copper contact connects pads without relying only on endpoint coincidence', () => {
  const value = snapshot({ lines: [line('L1', 0.4, 9.6)] });
  assert.equal(analyzeConnectivity(value).connectivityVerdict, 'CONNECTED_WITHIN_COVERAGE');
});
test('through-via joins layers; an unplated hole cannot substitute for a via', () => {
  const value = snapshot({ pads: [pad('P1', 0), pad('P2', 10, 2)], lines: [line('L1', 0, 5), line('L2', 5, 10, 2)], vias: [{ primitiveId: 'V1', net: 'N1', x: 5, y: 0, viaType: 0, diameter: 0.8, holeDiameter: 0.4 }] });
  assert.equal(analyzeConnectivity(value).connectivityVerdict, 'CONNECTED_WITHIN_COVERAGE');
  value.vias = []; value.pads.push({ ...pad('H1', 5, 12), metallization: false });
  assert.equal(analyzeConnectivity(value).connectivityVerdict, 'DISCONNECTED');
});
test('SMD pads do not connect copper on a different layer', () => {
  const value = snapshot({ lines: [line('L1', 0, 10, 2)] });
  assert.equal(analyzeConnectivity(value).connectivityVerdict, 'DISCONNECTED');
});
test('track width and rotated rectangular pads are included in contact geometry', () => {
  const value = snapshot({ pads: [{ ...pad('P1', 0), rotation: 45, pad: ['RECT', 1, 3, 0] }, pad('P2', 10)], lines: [line('L1', 0.6, 10)] });
  assert.equal(analyzeConnectivity(value).connectivityVerdict, 'CONNECTED_WITHIN_COVERAGE');
});
test('a copper fragment entirely inside a via drill is not falsely joined', () => {
  const value = snapshot({ pads: [pad('P1', 0), pad('P2', 10)], lines: [line('L1', -0.01, 0.01), line('L2', 0.5, 10)], vias: [{ primitiveId: 'V1', net: 'N1', x: 0, y: 0, viaType: 0, diameter: 2, holeDiameter: 1.5 }] });
  value.pads[0].pad = ['ELLIPSE', 0.1, 0.1];
  assert.equal(analyzeConnectivity(value).connectivityVerdict, 'DISCONNECTED');
});
test('unknown pad shapes and incomplete category inventory never become full connectivity approval', () => {
  const value = snapshot(); value.pads[0].pad = ['POLYGON', []];
  assert.equal(analyzeConnectivity(value).connectivityVerdict, 'PARTIAL');
  delete value.poured;
  assert.ok(analyzeConnectivity(value).coverage.unmodeledCategories.some(x => x.kind === 'poured' && x.count === null));
});
test('graph construction rejects duplicate identities and does not mutate inputs', () => {
  const value = snapshot({ lines: [line('L1', 0, 10)] });
  const before = JSON.stringify(value); analyzeConnectivity(value);
  assert.equal(JSON.stringify(value), before);
  value.lines.push(line('L1', 0, 10));
  assert.throws(() => analyzeConnectivity(value), /duplicate/i);
});

test('atomic export publishes a complete file and refuses existing destinations', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcb-export-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'board.dsn');
  const result = await createAtomicExport(destination, async temporary => { await fs.writeFile(temporary, '(PCB fixture)', { flag: 'wx' }); return { ok: true }; });
  assert.equal(result.atomicFinalization, true);
  assert.equal(await fs.readFile(destination, 'utf8'), '(PCB fixture)');
  let called = false;
  await assert.rejects(createAtomicExport(destination, async () => { called = true; }), error => error.code === 'OUTPUT_EXISTS');
  assert.equal(called, false);
  assert.deepEqual(await fs.readdir(directory), ['board.dsn']);
});
test('interrupted export cleans its temporary output without creating a final file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcb-export-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'board.epro');
  await assert.rejects(createAtomicExport(destination, async temporary => { await fs.writeFile(temporary, 'partial'); throw new Error('interrupted'); }), /interrupted/);
  assert.deepEqual(await fs.readdir(directory), []);
});
test('an output created by another actor is preserved during atomic finalization', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcb-export-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'board.dsn');
  await assert.rejects(createAtomicExport(destination, async temporary => { await fs.writeFile(temporary, 'ours'); await fs.writeFile(destination, 'other'); }), error => error.code === 'OUTPUT_EXISTS');
  assert.equal(await fs.readFile(destination, 'utf8'), 'other');
});

test('tool profiles expose exactly 21 production tools, 3 diagnostics and 30 legacy entries', () => {
  assert.equal(getToolRegistry().size, 21);
  assert.equal(getToolRegistry('diagnostics').size, 3);
  assert.equal(getToolRegistry('legacy').size, 30);
  for (const name of ['pcb_capabilities', 'pcb_validate_plan', 'pcb_validate_text_plan', 'pcb_capture_view', 'pcb_prepare_schematic_sync', 'pcb_capture_snapshot', 'pcb_compare_snapshots', 'pcb_realtime_drc']) assert.equal(getToolRegistry().has(name), false);
  assert.equal(getToolRegistry().has('pcb_export'), true);
});
test('both plan tools keep offline validation available without exposing a separate validator', async () => {
  const value = { schema: 'easyeda-pcb-plan/v2', intent: 'offline validation fixture', target: { windowId: 'w1', projectUuid: 'p1', documentUuid: 'd1' }, units: 'mil', phase: 'route', constraints: { minTrackWidth: 4, minViaHole: 8, minAnnularRing: 3, allowedLayers: ['TOP', 'BOTTOM'] }, operations: [{ id: 'line1', type: 'line.create', net: 'N', layer: 'TOP', start: [0, 0], end: [50, 0], width: 8 }] };
  const result = await invokeRegisteredTool('pcb_execute_plan', { plan: value, mode: 'validate' });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.wrotePCB, false);
  const changed = structuredClone(value); changed.intent = 'changed';
  assert.throws(() => assertGuardMatchesPlan({ schema: 'easyeda-pcb-guard/v1', planSha256: hashObject(value), target: value.target }, changed, value), /changed after preparation/);
});
test('production target fields and mutation guards are enforced at schema boundaries', async () => {
  await assert.rejects(invokeRegisteredTool('pcb_status', { target: { documentUuid: 'd1' } }));
  await assert.rejects(invokeRegisteredTool('pcb_rebuild_pours', { target: { documentUuid: 'd1', projectUuid: 'p1', windowId: 'w1' } }));
  await assert.rejects(invokeRegisteredTool('pcb_execute_plan', { plan: {}, mode: 'validate', hiddenBypass: true }));
});
test('stdio discovery returns the actual 21-tool schema and honors validation mode', async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], env: { ...process.env, EASYEDA_PCB_PROFILE: 'default' }, stderr: 'pipe' });
  const client = new Client({ name: 'merged-v2-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 21);
  assert.equal(new Set(tools.map(item => item.name)).size, 21);
  assert.ok(tools.every(item => item.description.length < 260));
  const result = await client.callTool({ name: 'pcb_execute_plan', arguments: { plan: {}, mode: 'validate' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
});

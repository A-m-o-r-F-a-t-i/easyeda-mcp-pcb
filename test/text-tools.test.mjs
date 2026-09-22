import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTextPlan } from '../src/text-plan.mjs';
import { buildTextBatchCode, textBatchRuntime } from '../src/text-runtime.mjs';

const target = { documentUuid: 'pcb-text-test', projectUuid: 'project-text-test' };
const textState = (overrides = {}) => ({
  layer: 'TOP_SILKSCREEN',
  x: 10,
  y: 20,
  text: 'UART1',
  fontFamily: 'default',
  fontSize: 45,
  lineWidth: 6,
  alignMode: 'CENTER',
  rotation: 0,
  reverse: false,
  expansion: 0,
  mirror: false,
  primitiveLock: false,
  ...overrides,
});
const plan = operations => ({ schema: 'easyeda-pcb-text-plan/v1', intent: 'text test', target, units: 'mil', operations });

function mockEda() {
  const strings = new Map();
  const attributes = new Map();
  let nextId = 1;
  const stringApi = {
    getAll: async () => [...strings.values()],
    get: async id => strings.get(id),
    create: async (layer, x, y, text, fontFamily, fontSize, lineWidth, alignMode, rotation, reverse, expansion, mirror, primitiveLock) => {
      const value = { primitiveId: `s${nextId++}`, layer, x, y, text, fontFamily, fontSize, lineWidth, alignMode, rotation, reverse, expansion, mirror, primitiveLock };
      strings.set(value.primitiveId, value);
      return value;
    },
    modify: async (id, set) => { const value = { ...strings.get(id), ...set }; strings.set(id, value); return value; },
    delete: async id => strings.delete(id),
  };
  const attributeApi = {
    getAll: async () => [...attributes.values()],
    get: async id => attributes.get(id),
    modify: async (id, set) => { const value = { ...attributes.get(id), ...set }; attributes.set(id, value); return value; },
  };
  return {
    strings,
    attributes,
    eda: {
      dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: target.documentUuid, documentType: 3 }) },
      dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: target.projectUuid }) },
      pcb_PrimitiveString: stringApi,
      pcb_PrimitiveAttribute: attributeApi,
    },
  };
}

test('text plan validates explicit silkscreen create and converts mm', () => {
  const raw = plan([{ id: 'create', type: 'string.create', state: textState() }]);
  raw.units = 'mm';
  raw.operations[0].state = textState({ x: 2.54, y: 5.08, fontSize: 1.27, lineWidth: 0.1524 });
  const normalized = validateTextPlan(raw);
  assert.equal(normalized.operations[0].state.layer, 3);
  assert.equal(normalized.operations[0].state.alignMode, 5);
  assert.ok(Math.abs(normalized.operations[0].state.x - 100) < 1e-9);
  assert.ok(Math.abs(normalized.operations[0].state.lineWidth - 6) < 1e-9);
});

test('text plan rejects non-silkscreen layer, incomplete old state and unknown fields', () => {
  assert.throws(() => validateTextPlan(plan([{ id: 'bad-layer', type: 'string.create', state: textState({ layer: 1 }) }])), /Text layer/);
  const expected = textState(); delete expected.text;
  assert.throws(() => validateTextPlan(plan([{ id: 'missing', type: 'string.modify', primitiveId: 's1', expected, set: { text: 'NEW' } }])), /expected.text required/);
  assert.throws(() => validateTextPlan(plan([{ id: 'unknown', type: 'string.create', state: { ...textState(), net: 'GND' } }])), /unknown field net/);
});

test('attribute modify requires parent identity and cannot rewrite parent', () => {
  const expected = {
    parentPrimitiveId: 'U1', layer: 3, x: 1, y: 2, key: 'Designator', value: 'U1', keyVisible: false, valueVisible: true,
    fontFamily: 'default', fontSize: 32, lineWidth: 6, alignMode: 5, rotation: 0, reverse: false, expansion: 0, mirror: false, primitiveLock: false,
  };
  assert.doesNotThrow(() => validateTextPlan(plan([{ id: 'attr', type: 'attribute.modify', primitiveId: 'a1', expected, set: { fontSize: 48 } }])));
  assert.throws(() => validateTextPlan(plan([{ id: 'attr', type: 'attribute.modify', primitiveId: 'a1', expected, set: { parentPrimitiveId: 'U2' } }])), /unknown field parentPrimitiveId/);
});

test('text runtime creates idempotently and independently verifies readback', async () => {
  const fixture = mockEda();
  const normalized = validateTextPlan(plan([{ id: 'create', type: 'string.create', state: textState() }]));
  const first = await textBatchRuntime(fixture.eda, { target, toleranceMil: 0.02, operations: normalized.operations });
  const second = await textBatchRuntime(fixture.eda, { target, toleranceMil: 0.02, operations: normalized.operations });
  assert.equal(first.ok, true);
  assert.equal(first.results[0].status, 'created');
  assert.equal(second.results[0].status, 'already_exists');
  assert.equal(fixture.strings.size, 1);
});

test('text runtime protects old values, locks and stale IDs', async () => {
  const fixture = mockEda();
  const state = { ...validateTextPlan(plan([{ id: 'c', type: 'string.create', state: textState() }])).operations[0].state, primitiveId: 's1' };
  fixture.strings.set('s1', state);
  const expected = { ...state }; delete expected.primitiveId;
  const bad = await textBatchRuntime(fixture.eda, { target, operations: [{ id: 'm', type: 'string.modify', kind: 'string', primitiveId: 's1', expected: { ...expected, text: 'WRONG' }, set: { text: 'NEW' } }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /Old-value assertion/);
  fixture.strings.set('s1', { ...state, primitiveLock: true });
  const locked = await textBatchRuntime(fixture.eda, { target, operations: [{ id: 'd', type: 'string.delete', kind: 'string', primitiveId: 's1', expected: { ...expected, primitiveLock: true }, set: null }] });
  assert.equal(locked.ok, false);
  assert.match(locked.error.message, /Locked string/);
});

test('text runtime modifies component attribute with full parent guard', async () => {
  const fixture = mockEda();
  const expected = {
    parentPrimitiveId: 'U1', layer: 3, x: 1, y: 2, key: 'Designator', value: 'U1', keyVisible: false, valueVisible: true,
    fontFamily: 'default', fontSize: 32, lineWidth: 6, alignMode: 5, rotation: 0, reverse: false, expansion: 0, mirror: false, primitiveLock: false,
  };
  fixture.attributes.set('a1', { primitiveId: 'a1', ...expected });
  const result = await textBatchRuntime(fixture.eda, { target, operations: [{ id: 'a', type: 'attribute.modify', kind: 'attribute', primitiveId: 'a1', expected, set: { fontSize: 48 } }] });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].after.fontSize, 48);
  assert.equal(result.results[0].after.value, 'U1');
  assert.equal(result.results[0].after.parentPrimitiveId, 'U1');
});

test('serialized text runtime remains self-contained', () => {
  const code = buildTextBatchCode({ target, operations: [] });
  assert.match(code, /textBatchRuntime/);
  assert.doesNotMatch(code, /node:/);
  assert.match(code, /independent readback/);
});

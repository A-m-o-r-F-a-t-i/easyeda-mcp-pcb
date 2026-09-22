import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComponentCleanupCode, componentCleanupRuntime } from '../src/component-cleanup-runtime.mjs';

const target = { documentUuid: 'pcb-cleanup', projectUuid: 'project-cleanup', windowId: 'window-cleanup' };
const component = (primitiveId, designator, primitiveLock) => ({
  primitiveId,
  uniqueId: `uid-${primitiveId}`,
  designator,
  x: primitiveId === 'c1' ? 10 : 20,
  y: 30,
  rotation: 0,
  layer: 1,
  primitiveLock,
});
const attribute = (primitiveId, parentPrimitiveId, key, value, primitiveLock = false) => ({
  primitiveId,
  parentPrimitiveId,
  layer: 3,
  x: 10,
  y: 30,
  key,
  value,
  keyVisible: false,
  valueVisible: true,
  fontFamily: 'default',
  fontSize: 32,
  lineWidth: 6,
  alignMode: 5,
  rotation: 0,
  reverse: false,
  expansion: 0,
  mirror: false,
  primitiveLock,
});
const string = (primitiveId, text) => ({
  primitiveId,
  layer: 3,
  x: 5,
  y: 6,
  text,
  fontFamily: 'default',
  fontSize: 45,
  lineWidth: 6,
  alignMode: 5,
  rotation: 0,
  reverse: false,
  expansion: 0,
  mirror: false,
  primitiveLock: false,
});

function fixture() {
  const components = new Map([
    ['c1', component('c1', 'U1', true)],
    ['c2', component('c2', 'R1', false)],
  ]);
  const attributes = new Map([
    ['a1', attribute('a1', 'c1', 'Designator', 'U1', true)],
    ['a2', attribute('a2', 'c1', 'Value', 'MCU')],
    ['a3', attribute('a3', 'missing-parent', 'Designator', 'ORPHAN')],
    ['a4', attribute('a4', 'c2', 'Designator', 'R1')],
  ]);
  const strings = new Map([['s1', string('s1', 'UART1 5V / TX / RX / GND')]]);
  let writes = 0;
  const api = values => ({
    getAll: async () => structuredClone([...values.values()]),
    get: async id => values.has(id) ? structuredClone(values.get(id)) : undefined,
    modify: async (id, set) => {
      writes++;
      const next = { ...values.get(id), ...set };
      values.set(id, next);
      return structuredClone(next);
    },
    delete: async id => {
      writes++;
      return values.delete(id);
    },
  });
  return {
    components,
    attributes,
    strings,
    writes: () => writes,
    eda: {
      dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: target.documentUuid, documentType: 3 }) },
      dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: target.projectUuid }) },
      pcb_PrimitiveComponent: api(components),
      pcb_PrimitiveAttribute: api(attributes),
      pcb_PrimitiveString: api(strings),
    },
  };
}

test('bulk cleanup unlocks components and deletes only attached Designator attributes', async () => {
  const value = fixture();
  const preview = await componentCleanupRuntime(value.eda, { target, mode: 'preview' });
  assert.equal(preview.preview.counts.lockedComponents, 1);
  assert.equal(preview.preview.counts.designatorAttributes, 2);
  assert.deepEqual(preview.preview.designatorAttributeIds, ['a1', 'a4']);
  const preservedString = structuredClone(value.strings.get('s1'));
  const preservedValue = structuredClone(value.attributes.get('a2'));
  const preservedOrphan = structuredClone(value.attributes.get('a3'));

  const result = await componentCleanupRuntime(value.eda, {
    target,
    mode: 'execute',
    expectedPreview: preview.preview,
    unlockComponents: true,
    deleteReferenceDesignators: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.completedCount, 3);
  assert.equal(value.components.get('c1').primitiveLock, false);
  assert.equal(value.components.get('c2').primitiveLock, false);
  assert.equal(value.attributes.has('a1'), false);
  assert.equal(value.attributes.has('a4'), false);
  assert.deepEqual(value.attributes.get('a2'), preservedValue);
  assert.deepEqual(value.attributes.get('a3'), preservedOrphan);
  assert.deepEqual(value.strings.get('s1'), preservedString);
  assert.equal(result.verification.componentIdentityAndGeometryUnchanged, true);
  assert.equal(result.verification.independentStringsUnchanged, true);
});

test('cleanup refuses a changed preview before writing', async () => {
  const value = fixture();
  const preview = await componentCleanupRuntime(value.eda, { target, mode: 'preview' });
  value.strings.set('s1', string('s1', 'HUMAN EDIT'));
  const result = await componentCleanupRuntime(value.eda, {
    target,
    mode: 'execute',
    expectedPreview: preview.preview,
    unlockComponents: true,
    deleteReferenceDesignators: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /preview changed/i);
  assert.equal(value.writes(), 0);
  assert.equal(value.components.get('c1').primitiveLock, true);
  assert.equal(value.attributes.has('a1'), true);
});

test('cleanup actions can be independently selected', async () => {
  const value = fixture();
  const preview = await componentCleanupRuntime(value.eda, { target, mode: 'preview' });
  const result = await componentCleanupRuntime(value.eda, {
    target,
    mode: 'execute',
    expectedPreview: preview.preview,
    unlockComponents: true,
    deleteReferenceDesignators: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.completedCount, 1);
  assert.equal(value.components.get('c1').primitiveLock, false);
  assert.equal(value.attributes.has('a1'), true);
  assert.equal(value.attributes.has('a4'), true);
});

test('serialized cleanup runtime is self-contained', async () => {
  const value = fixture();
  const code = buildComponentCleanupCode({ target, mode: 'preview' });
  assert.match(code, /componentCleanupRuntime/);
  assert.doesNotMatch(code, /node:/);
  const result = await new Function('eda', `return (async()=>{${code}})();`)(value.eda);
  assert.equal(result.ok, true);
  assert.equal(result.preview.counts.components, 2);
});

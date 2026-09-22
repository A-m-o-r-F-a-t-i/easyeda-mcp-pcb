import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(root, '..', '..');

function resolveReferencesRoot() {
  const configuredSkillRoot = process.env.EASYEDA_API_SKILL_ROOT
    ? path.resolve(process.env.EASYEDA_API_SKILL_ROOT)
    : null;
  const configuredReferencesRoot = process.env.EASYEDA_API_REFERENCES_ROOT
    ? path.resolve(process.env.EASYEDA_API_REFERENCES_ROOT)
    : null;
  const candidates = [
    configuredReferencesRoot,
    configuredSkillRoot ? path.join(configuredSkillRoot, 'references') : null,
    path.join(projectRoot, 'skills', 'easyeda-api', 'references'),
    path.resolve(root, '..', 'easyeda-skill-api', 'references'),
    path.join(projectRoot, 'easyeda-api-skill-dev', 'references'),
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(path.join(candidate, 'classes', 'EDA.md')));
  assert.ok(found, `EasyEDA API references not found. Set EASYEDA_API_SKILL_ROOT or EASYEDA_API_REFERENCES_ROOT. Checked: ${candidates.join(', ')}`);
  return found;
}

const referencesRoot = resolveReferencesRoot();
const classesRoot = path.join(referencesRoot, 'classes');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'sdk-capability-registry.json'), 'utf8'));

function currentSdkKeys() {
  const eda = fs.readFileSync(path.join(classesRoot, 'EDA.md'), 'utf8');
  const modules = [...eda.matchAll(/^([A-Za-z][A-Za-z0-9_]+):\s*([A-Za-z][A-Za-z0-9_]+);$/gm)].map(match => [match[1], match[2]]);
  const keys = [];
  for (const [property, className] of modules) {
    const file = path.join(classesRoot, `${className}.md`);
    assert.ok(fs.existsSync(file), `missing SDK class reference ${className}`);
    const text = fs.readFileSync(file, 'utf8'), methods = new Set();
    for (const match of text.matchAll(/\[([A-Za-z][A-Za-z0-9_]*)\([^\]]*\)\]\(\.\/[A-Za-z0-9_]+\.md\)/g)) methods.add(match[1]);
    for (const match of text.matchAll(/^([A-Za-z][A-Za-z0-9_]*)\([^\n]*\):\s*(?:Promise|[A-Za-z])/gm)) methods.add(match[1]);
    for (const method of methods) keys.push(`${property}.${method}`);
  }
  return { modules, keys: keys.sort() };
}
const quotedEnum = relative => [...fs.readFileSync(path.join(referencesRoot, relative), 'utf8').matchAll(/`"([^"]+)"`/g)].map(match => match[1]).sort();
const numericEnum = relative => [...fs.readFileSync(path.join(referencesRoot, relative), 'utf8').matchAll(/`([0-9]+)`/g)].map(match => Number(match[1])).sort((a, b) => a - b);

function polygonCommands() {
  const text = fs.readFileSync(path.join(referencesRoot, 'types', 'TPCB_PolygonSourceArray.md'), 'utf8');
  const signature = text.match(/type TPCB_PolygonSourceArray = Array<([^>]+)>;/)?.[1];
  assert.ok(signature, 'polygon source signature missing');
  return [...signature.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
}

test('SDK001 every public EasyEDA method is present exactly once in the reviewed registry', () => {
  const current = currentSdkKeys(), registered = registry.entries.map(entry => entry.key).sort();
  assert.equal(current.modules.length, 91);
  assert.equal(current.keys.length, 585);
  assert.deepEqual(registered, current.keys);
  assert.equal(new Set(registered).size, registered.length);
  assert.equal(registry.generatedFrom.moduleCount, current.modules.length);
  assert.equal(registry.generatedFrom.methodCount, current.keys.length);
});

test('SDK002 every method has a valid owner, disposition and explicit rationale', () => {
  const allowed = new Set(registry.policy.dispositions);
  assert.deepEqual([...allowed].sort(), ['implemented', 'implemented_limited', 'intentional_exclusion', 'known_other_plugin_scope', 'known_supporting_api', 'needs_live_verification']);
  for (const entry of registry.entries) {
    assert.ok(allowed.has(entry.disposition), entry.key);
    assert.equal(typeof entry.owner, 'string', entry.key);
    assert.ok(entry.owner.length > 0, entry.key);
    assert.equal(typeof entry.rationale, 'string', entry.key);
    assert.ok(entry.rationale.length > 20, entry.key);
    assert.ok(Array.isArray(entry.evidence), entry.key);
  }
  assert.equal(registry.entries.some(entry => entry.disposition === 'unclassified'), false);
});

test('SDK003 closed EasyEDA geometry enums cannot gain an unnoticed value', () => {
  assert.deepEqual(quotedEnum('enums/EPCB_PrimitivePadShapeType.md'), registry.enums.padShapeTypes.values);
  assert.deepEqual(numericEnum('enums/EPCB_PrimitiveFillMode.md'), registry.enums.fillModes.values);
  assert.deepEqual(numericEnum('enums/EPCB_PrimitiveArcInteractiveMode.md'), registry.enums.arcInteractiveModes.values);
  assert.deepEqual(polygonCommands(), registry.enums.polygonCommands.values);
  for (const values of [registry.enums.fillModes.exposed, registry.enums.polygonCommands.exposedByPlan, registry.enums.polygonCommands.parsedForInspection]) assert.ok(Array.isArray(values));
});

test('SDK004 previously missed high-value PCB capabilities remain explicitly covered', () => {
  const byKey = new Map(registry.entries.map(entry => [entry.key, entry]));
  const expected = [
    'pcb_PrimitiveArc.create', 'pcb_PrimitiveArc.modify', 'pcb_PrimitiveArc.delete',
    'pcb_PrimitiveFill.create', 'pcb_PrimitiveFill.modify', 'pcb_PrimitiveFill.delete',
    'pcb_PrimitivePolyline.modify', 'pcb_PrimitivePolyline.delete',
    'pcb_PrimitivePad.create', 'pcb_Layer.setTheNumberOfCopperLayers',
    'pcb_Net.getNetLength', 'pcb_Net.getAllPrimitivesByNet',
    'pcb_PrimitiveDimension.getAll', 'pcb_PrimitiveImage.getAll', 'pcb_PrimitiveObject.getAll',
  ];
  for (const key of expected) assert.ok(['implemented', 'implemented_limited'].includes(byKey.get(key)?.disposition), key);
});

test('SDK005 automatic routing, order actions and raw netlist overwrite stay excluded', () => {
  const byKey = new Map(registry.entries.map(entry => [entry.key, entry]));
  for (const entry of registry.entries.filter(item => item.property === 'sys_Order')) assert.equal(entry.disposition, 'intentional_exclusion', entry.key);
  for (const key of ['pcb_Net.setNetlist']) if (byKey.has(key)) assert.equal(byKey.get(key).disposition, 'intentional_exclusion', key);
});

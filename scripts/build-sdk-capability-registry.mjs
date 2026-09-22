import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(mcpRoot, '..', '..');
const referencesRoot = path.join(projectRoot, 'easyeda-api-skill-dev', 'references');
const classesRoot = path.join(referencesRoot, 'classes');
const sourceRoot = path.join(mcpRoot, 'src');
const registryPath = path.join(mcpRoot, 'sdk-capability-registry.json');

const read = file => fs.readFileSync(file, 'utf8');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const target = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(target) : [target];
});

function readSdkMethods() {
  const eda = read(path.join(classesRoot, 'EDA.md'));
  const modules = [...eda.matchAll(/^([A-Za-z][A-Za-z0-9_]+):\s*([A-Za-z][A-Za-z0-9_]+);$/gm)]
    .map(match => ({ property: match[1], className: match[2] }))
    .sort((a, b) => a.property.localeCompare(b.property));
  const methods = [];
  for (const module of modules) {
    const file = path.join(classesRoot, `${module.className}.md`);
    if (!fs.existsSync(file)) throw new Error(`Missing SDK class reference: ${module.className}`);
    const text = read(file), names = new Set();
    for (const match of text.matchAll(/\[([A-Za-z][A-Za-z0-9_]*)\([^\]]*\)\]\(\.\/[A-Za-z0-9_]+\.md\)/g)) names.add(match[1]);
    for (const match of text.matchAll(/^([A-Za-z][A-Za-z0-9_]*)\([^\n]*\):\s*(?:Promise|[A-Za-z])/gm)) names.add(match[1]);
    for (const method of [...names].sort()) methods.push({ key: `${module.property}.${method}`, ...module, method });
  }
  return { modules, methods };
}

function readDirectReferences() {
  const references = new Map();
  const add = (property, method, file) => {
    const key = `${property}.${method}`;
    if (!references.has(key)) references.set(key, new Set());
    references.get(key).add(file);
  };
  for (const file of walk(sourceRoot).filter(item => item.endsWith('.mjs'))) {
    const text = read(file), relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
    for (const match of text.matchAll(/eda\.([A-Za-z][A-Za-z0-9_]+)(?:\?\.)?\.([A-Za-z][A-Za-z0-9_]+)/g)) add(match[1], match[2], relative);
    for (const match of text.matchAll(/has\(['"]([A-Za-z][A-Za-z0-9_]+)['"],\s*['"]([A-Za-z][A-Za-z0-9_]+)['"]\)/g)) add(match[1], match[2], relative);
  }
  return references;
}

const implementedCrud = new Map([
  ['pcb_PrimitiveLine', ['create', 'delete', 'get', 'getAll', 'modify']],
  ['pcb_PrimitiveArc', ['create', 'delete', 'get', 'getAll', 'modify']],
  ['pcb_PrimitivePolyline', ['create', 'delete', 'get', 'getAll', 'modify']],
  ['pcb_PrimitivePad', ['create', 'delete', 'get', 'getAll', 'modify']],
  ['pcb_PrimitiveVia', ['create', 'delete', 'get', 'getAll', 'modify']],
  ['pcb_PrimitivePour', ['create', 'delete', 'get', 'getAll', 'modify', 'rebuildCopperRegions']],
  ['pcb_PrimitivePoured', ['get', 'getAll']],
  ['pcb_PrimitiveFill', ['create', 'delete', 'get', 'getAll', 'modify']],
  ['pcb_PrimitiveString', ['create', 'delete', 'get', 'getAll', 'modify']],
  ['pcb_PrimitiveAttribute', ['get', 'getAll', 'modify']],
  ['pcb_PrimitiveRegion', ['get', 'getAll']],
  ['pcb_PrimitiveDimension', ['get', 'getAll']],
  ['pcb_PrimitiveImage', ['get', 'getAll']],
  ['pcb_PrimitiveObject', ['get', 'getAll']],
  ['pcb_PrimitiveComponent', ['get', 'getAll', 'getAllPinsByPrimitiveId', 'modify']],
]);
const limited = new Map([
  ['pcb_PrimitiveArc.create', 'Explicit two-point/center circular arcs with exact readback; no interactive mouse placement.'],
  ['pcb_PrimitiveFill.create', 'Solid local copper only; mesh and reserved inner-electrical modes remain classified but unexposed.'],
  ['pcb_PrimitiveFill.modify', 'Solid simple polygon geometry with complete expected-state and polygon readback.'],
  ['pcb_PrimitivePad.create', 'ELLIPSE, OVAL, RECT, NGON and simple POLYGON; drilled custom POLYGON pads stay blocked until annular-ring geometry is verified.'],
  ['pcb_Layer.setTheNumberOfCopperLayers', 'Even 2..32 layers, increase-only, exact native readback, and isolated guarded plan.'],
  ['pcb_PrimitivePolyline.modify', 'Board-outline geometry only, including polygon-to-native-circle conversion with complete old geometry.'],
  ['pcb_PrimitivePolyline.delete', 'Board-outline deletion requires exact native polygon/circle old-state readback.'],
  ['pcb_Net.getNetLength', 'Exact read-only native length for one named network.'],
  ['pcb_Net.getAllPrimitivesByNet', 'Exact read-only primitive inventory for one named network.'],
  ['pcb_PrimitiveObject.get', 'Metadata only; binary payload bytes are deliberately omitted.'],
  ['pcb_PrimitiveObject.getAll', 'Metadata only; binary payload bytes are deliberately omitted.'],
]);
const implementedExplicit = new Set([
  'pcb_Layer.getAllLayers', 'pcb_Layer.setTheNumberOfCopperLayers',
  'pcb_Net.getAllNets', 'pcb_Net.getNetLength', 'pcb_Net.getAllPrimitivesByNet', 'pcb_Net.getNetlist',
  'pcb_Primitive.getPrimitivesBBox',
]);
const otherScopePrefix = new Map([
  ['sch_', 'easyeda-schematic-net-fanout'],
  ['lib_', 'easyeda-eprj3/easyeda-pro-format-skill'],
  ['pnl_', 'panelization capability registry'],
]);
const intentionalProperties = new Set(['sys_Order']);
const intentionalMethod = /(?:auto(?:Layout|Route|Routing|Placement)|clearAll(?:Copper|Route|Routes)|placeInteractive|mouse|highlight|unhighlight|selectNet|unselectNet|setNetlist|order|purchase|checkout)/i;
const mutatingPrefix = /^(?:create|delete|modify|set|add|remove|start|stop|open|close|clear|import|apply|convert|rebuild|highlight|unhighlight|select|unselect)/;

function classify(item, directReferences) {
  const direct = directReferences.get(item.key);
  if (limited.has(item.key)) return { disposition: 'implemented_limited', owner: 'easyeda-pcb', rationale: limited.get(item.key), evidence: direct ? [...direct].sort() : [] };
  if (implementedExplicit.has(item.key) || implementedCrud.get(item.property)?.includes(item.method) || direct) {
    return { disposition: 'implemented', owner: item.property.startsWith('pcb_') ? 'easyeda-pcb' : 'easyeda-api', rationale: 'Implemented by a typed tool/runtime path with target guards and readback where the method mutates state.', evidence: direct ? [...direct].sort() : [] };
  }
  for (const [prefix, owner] of otherScopePrefix) if (item.property.startsWith(prefix)) return { disposition: 'known_other_plugin_scope', owner, rationale: 'Known SDK capability owned outside the live PCB MCP; retained in the complete registry so it cannot be forgotten.', evidence: [] };
  if (intentionalProperties.has(item.property) || intentionalMethod.test(item.method)) return { disposition: 'intentional_exclusion', owner: item.property.startsWith('pcb_') ? 'easyeda-pcb' : 'easyeda-api', rationale: 'Intentionally not exposed because it is automatic, interactive, broad-destructive, ordering/account, or raw-netlist behavior outside the explicit guarded workflow.', evidence: [] };
  if (item.property.startsWith('pcb_')) return { disposition: 'needs_live_verification', owner: 'easyeda-pcb', rationale: mutatingPrefix.test(item.method) ? 'Known PCB mutation not yet assigned a typed schema, independent readback contract and live compatibility evidence.' : 'Known PCB read/helper capability not yet proven necessary or stable in the production profile.', evidence: [] };
  if (item.property.startsWith('dmt_') || item.property.startsWith('sys_')) return { disposition: 'known_supporting_api', owner: 'easyeda-api', rationale: mutatingPrefix.test(item.method) ? 'Known host/editor infrastructure method; use only through a bounded workflow with explicit state restoration or target guards.' : 'Known host/editor infrastructure read/helper retained for discovery and future capability routing.', evidence: [] };
  return { disposition: 'needs_live_verification', owner: 'easyeda-api', rationale: 'Known SDK capability awaiting an explicit owner and compatibility decision.', evidence: [] };
}

function enumContract() {
  return {
    padShapeTypes: { source: 'enums/EPCB_PrimitivePadShapeType.md', values: ['ELLIPSE', 'NGON', 'OVAL', 'POLYGON', 'RECT'] },
    fillModes: { source: 'enums/EPCB_PrimitiveFillMode.md', values: [0, 1, 2], exposed: [0] },
    arcInteractiveModes: { source: 'enums/EPCB_PrimitiveArcInteractiveMode.md', values: [1, 2] },
    polygonCommands: { source: 'types/TPCB_PolygonSourceArray.md', values: ['ARC', 'C', 'CARC', 'CIRCLE', 'L', 'R'], exposedByPlan: ['CIRCLE', 'L'], parsedForInspection: ['ARC', 'CIRCLE', 'L', 'R'] },
  };
}

const sdk = readSdkMethods(), directReferences = readDirectReferences();
const entries = sdk.methods.map(item => ({ ...item, ...classify(item, directReferences) }));
const dispositionCounts = Object.fromEntries([...new Set(entries.map(item => item.disposition))].sort().map(disposition => [disposition, entries.filter(item => item.disposition === disposition).length]));
const registry = {
  schema: 'easyeda-sdk-capability-registry/v1',
  generatedFrom: {
    package: '@jlceda/pro-api-types',
    packageVersion: '0.4.25',
    classIndex: path.relative(projectRoot, path.join(classesRoot, 'EDA.md')).replaceAll('\\', '/'),
    moduleCount: sdk.modules.length,
    methodCount: entries.length,
  },
  policy: {
    dispositions: ['implemented', 'implemented_limited', 'known_other_plugin_scope', 'known_supporting_api', 'needs_live_verification', 'intentional_exclusion'],
    invariant: 'Every public SDK method and selected closed enum must be present and classified. SDK drift fails tests until the registry is reviewed.',
  },
  summary: { dispositionCounts, directReferenceCount: entries.filter(item => item.evidence.length).length },
  enums: enumContract(),
  entries,
};
fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(JSON.stringify({ registryPath, modules: sdk.modules.length, methods: entries.length, dispositionCounts }, null, 2));

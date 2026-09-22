#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { pathToFileURL } from 'node:url';
import { runPlan } from './guarded-plan.mjs';
import { cleanupComponents } from './component-cleanup.mjs';
import { readNativeRegions } from './region-read.mjs';
import { runGuardedNative } from './execution-context.mjs';
import { exportPcb } from './export.mjs';
import { readRouteScene } from './route-scene.mjs';
import { auditPcb, statusPcb, synchronizePcb } from './production-tools.mjs';
export const VERSION = '2.5.0';
import { captureSnapshot, inspectPinmap } from './verification.mjs';
import { inspectAllSilkscreen } from './silkscreen-all.mjs';
import { exportNativeBackup, captureView } from './backup.mjs';
import { captureInspectionView } from './inspection-view.mjs';
import { renderInspectionSvg } from './vector-inspection.mjs';
import { exportManufacturingFile } from './manufacturing.mjs';
import { compareAssociatedNetlists } from './netlist-compare.mjs';
import { verifyApiGates } from './release-check.mjs';
import { auditGeometry } from './audit.mjs';
import {
  controlRealTimeDrc,
  executeTextPlanSource,
  getPcbCapabilities,
  importSchematicChanges,
  manageConstraintGroup,
  pickPcbPrimitives,
  prepareSchematicSync,
  readConstraints,
  rebuildPours,
  validateTextPlanSource,
} from './advanced.mjs';
import { executePlanSource, readPcb, saveAndCheck, validatePlanSource } from './bridge.mjs';

import { listTargets, openTarget, inspectSilkscreen, compareSnapshotSources } from './inspection.mjs';

const legacyRegistry = new Map();
const server = { registerTool(name, definition, handler) {
  if (legacyRegistry.has(name)) throw new Error(`Duplicate tool: ${name}`);
  legacyRegistry.set(name, { name, definition, handler });
} };

const targetSchema = z.object({
  documentUuid: z.string().min(1).describe('Exact EasyEDA PCB document UUID'),
  projectUuid: z.string().min(1).optional().describe('Optional exact project UUID guard'),
  windowId: z.string().min(1).optional().describe('Connected EasyEDA window ID when more than one window exists'),
}).strict();

const regionSchema = z.object({
  minX: z.number().finite(), maxX: z.number().finite(), minY: z.number().finite(), maxY: z.number().finite(),
}).strict();

const bridgeUrlSchema = z.string().url().optional().describe('Optional local EasyEDA Bridge URL on 127.0.0.1/localhost ports 49620-49629');
const planInputSchema = {
  planPath: z.string().min(1).optional().describe('Absolute JSON file: easyeda-pcb-plan/v2 geometry or easyeda-pcb-keepout-plan/v1 mechanical keepouts'),
  plan: z.unknown().optional().describe('Inline geometry or keepout plan for small changes; prefer planPath for repetitive work'),
};
const textPlanInputSchema = {
  planPath: z.string().min(1).optional().describe('Preferred absolute path to an inspectable easyeda-pcb-text-plan/v1 JSON file'),
  plan: z.unknown().optional().describe('Inline easyeda-pcb-text-plan/v1 object for small text plans'),
};
const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const pickRegionSchema = z.object({
  left: z.number().finite(),
  right: z.number().finite(),
  top: z.number().finite(),
  bottom: z.number().finite(),
  fullyContained: z.boolean().optional().default(false),
}).strict();
const colorSchema = z.object({
  r: z.number().int().min(0).max(255),
  g: z.number().int().min(0).max(255),
  b: z.number().int().min(0).max(255),
  alpha: z.number().min(0).max(1),
}).strict();
const groupTypeSchema = z.enum(['netClass', 'differentialPair', 'equalLengthGroup', 'padPairGroup']);
const constraintOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), groupType: groupTypeSchema, name: z.string().min(1), expected: z.null(), definition: z.union([
    z.object({ nets: z.array(z.string().min(1)).max(5000), color: colorSchema.nullable() }).strict(),
    z.object({ positiveNet: z.string().min(1), negativeNet: z.string().min(1) }).strict(),
    z.object({ padPairs: z.array(z.tuple([z.string().min(1), z.string().min(1)])).max(5000) }).strict(),
  ]) }).strict(),
  z.object({ action: z.literal('delete'), groupType: groupTypeSchema, name: z.string().min(1), expected: z.unknown() }).strict(),
  z.object({ action: z.literal('rename'), groupType: groupTypeSchema, name: z.string().min(1), newName: z.string().min(1), expected: z.unknown() }).strict(),
  z.object({ action: z.literal('addMembers'), groupType: z.enum(['netClass', 'equalLengthGroup', 'padPairGroup']), name: z.string().min(1), members: z.unknown(), expected: z.unknown(), allowColorReset: z.boolean().optional().describe('Explicitly accept client 3.2.186 member-edit reset to opaque black; false preserves colors by refusing unsupported edits') }).strict(),
  z.object({ action: z.literal('removeMembers'), groupType: z.enum(['netClass', 'equalLengthGroup', 'padPairGroup']), name: z.string().min(1), members: z.unknown(), expected: z.unknown(), allowColorReset: z.boolean().optional().describe('Explicitly accept client 3.2.186 member-edit reset to opaque black; false preserves colors by refusing unsupported edits') }).strict(),
  z.object({ action: z.literal('setPositiveNet'), groupType: z.literal('differentialPair'), name: z.string().min(1), net: z.string().min(1), expected: z.unknown() }).strict(),
  z.object({ action: z.literal('setNegativeNet'), groupType: z.literal('differentialPair'), name: z.string().min(1), net: z.string().min(1), expected: z.unknown() }).strict(),
]);

function output(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function errorOutput(error) {
  const payload = {
    ok: false,
    code: error?.code ?? 'METHOD_FAILED',
    error: String(error?.message ?? error),
    details: error?.details ?? null,
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
}

async function handled(fn) {
  try { return output(await fn()); }
  catch (error) { return errorOutput(error); }
}

server.registerTool('pcb_status', {
  title: 'Read active PCB status',
  description: 'Read the connected EasyEDA PCB document, project, canvas origin and API units. This tool is read-only and validates an optional exact target UUID.',
  annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema: {
    target: targetSchema.optional(),
    bridgeUrl: bridgeUrlSchema,
  },
}, async ({ target, bridgeUrl }) => handled(async () => {
  const response = await readPcb({ kind: 'status', target }, { bridgeUrl });
  return { ok: true, ...response };
}));

server.registerTool('pcb_read', {
  title: 'Read PCB objects and rules',
  description: 'Read typed PCB state without arbitrary code execution. Supports snapshots, components, pads, traces, board-outline polylines, vias, pour outlines, actual poured data, fills, arcs, independent strings, component attributes, primitive bounds, regions, component pins, layers, rules, nets and netlist. Results can be filtered and paged.',
  annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema: {
    target: targetSchema,
    kind: z.enum(['snapshot', 'components', 'pads', 'lines', 'polylines', 'vias', 'pours', 'poured', 'fills', 'arcs', 'strings', 'attributes', 'regions', 'dimensions', 'images', 'objects', 'bounds', 'pins', 'layers', 'rules', 'nets', 'netMetrics', 'netlist']),
    ids: z.array(z.string().min(1)).max(2000).optional(),
    include: z.array(z.enum(['components', 'pads', 'lines', 'polylines', 'vias', 'pours', 'poured', 'fills', 'arcs', 'strings', 'attributes', 'regions', 'dimensions', 'images', 'objects'])).max(15).optional(),
    net: z.string().optional(),
    layer: z.number().int().optional(),
    parentPrimitiveId: z.string().min(1).optional().describe('Filter attributes or child primitives by exact parent primitive ID'),
    region: regionSchema.optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
    bridgeUrl: bridgeUrlSchema,
  },
}, async ({ bridgeUrl, ...request }) => handled(async () => {
  const response = await readPcb(request, { bridgeUrl });
  return { ok: true, ...response };
}));

server.registerTool('pcb_capabilities', {
  title: 'Detect PCB API capabilities',
  description: 'Read the exact active PCB client version and detect public API support for repour, text, attributes, native picking, constraints, DRC, schematic import, source-netlist comparison, bounded manufacturing output, current-view/layer-isolated capture and stable snapshot SVG inspection. Reports runtime quirks and policy exclusions; performs no write.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { target: targetSchema, bridgeUrl: bridgeUrlSchema },
}, async ({ target, bridgeUrl }) => handled(() => getPcbCapabilities({ target, bridgeUrl })));

server.registerTool('pcb_compare_associated_netlists', {
  title: 'Compare associated schematic and PCB netlists without opening ECO UI',
  description: 'Use EasyEDA public netlistComparison twice on the exact associated schematic and target PCB. Returns stable logical component/net differences with paging. Read-only; it does not import changes, route copper, prove connectivity or open a browser/dialog.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    target: targetSchema,
    expectedSchematicUuid: z.string().min(1).optional(),
    offset: z.number().int().min(0).optional().default(0),
    limit: z.number().int().min(0).max(1000).optional().default(100),
    bridgeUrl: bridgeUrlSchema,
  },
}, async args => handled(() => compareAssociatedNetlists(args)));

server.registerTool('pcb_pick', {
  title: 'Query native PCB primitives by point or region',
  description: 'Use EasyEDA native point-hit or rectangular-region APIs to query primitives without browser clicking and without changing the editor selection. Provide exactly one of point or region. Coordinates use explicit mil/mm units.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    target: targetSchema,
    units: z.enum(['mil', 'mm']),
    point: pointSchema.optional(),
    region: pickRegionSchema.optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    bridgeUrl: bridgeUrlSchema,
  },
}, async ({ target, units, point, region, offset, limit, bridgeUrl }) => handled(() => pickPcbPrimitives({ target, units, point, region, offset, limit, bridgeUrl })));

server.registerTool('pcb_rebuild_pours', {
  title: 'Rebuild PCB copper pours',
  description: 'Rebuild all pour boundaries or explicit pour IDs through the public EasyEDA API, falling back to per-pour instance rebuilding when the client lacks the static batch method. Independently reads actual Poured objects and optionally saves. Reports non-target fill changes. Client 3.2.186 partial requests require explicit allowCollateralRebuild or an all-boundary request. Does not prove connectivity or ampacity.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    target: targetSchema,
    pourIds: z.array(z.string().min(1)).min(1).max(5000).optional(),
    allowCollateralRebuild:z.boolean().optional().default(false),
    save: z.boolean().optional().default(true),
    bridgeUrl: bridgeUrlSchema,
  },
}, async ({ target, pourIds, allowCollateralRebuild, save, bridgeUrl }) => handled(() => rebuildPours({ target, pourIds, allowCollateralRebuild, save, bridgeUrl })));

server.registerTool('pcb_audit_geometry', {
  title: 'Read-only PCB geometry audit',
  description: 'Audit a supplied mil/mm snapshot OR read the exact live PCB twice. Reports non-45-degree straight segments, bad ordinary endpoint joints, separate pad/via/branch orthogonal pairs, and per-net segment length/width/via statistics. No edits, no routing, no repour, no current/SI/connectivity approval. Missing or excluded geometry is disclosed.',
  annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema: {
    target: targetSchema.optional(),
    snapshot: z.object({units:z.enum(['mil','mm']),lines:z.array(z.unknown()).max(100000),pads:z.array(z.unknown()).max(100000).optional(),vias:z.array(z.unknown()).max(100000).optional(),coverage:z.unknown().optional()}).strict().optional(),
    toleranceMil:z.number().positive().max(0.1).optional(),
    detailLimit:z.number().int().min(0).max(5000).optional(),
    bridgeUrl:bridgeUrlSchema,
  },
}, async ({target,snapshot,toleranceMil,detailLimit,bridgeUrl})=>handled(async()=>{
  if((target===undefined)===(snapshot===undefined))throw Error('Provide exactly one of target or snapshot');
  if(snapshot!==undefined&&bridgeUrl!==undefined)throw Error('bridgeUrl only applies to live target audits');
  let data=snapshot,source='provided snapshot';
  if(target){const response=await readPcb({kind:'auditSnapshot',target},{bridgeUrl});data=response.result;source={target,bridge:response.bridge};}
  return {...auditGeometry(data,{toleranceMil,detailLimit}),source};
}));

server.registerTool('pcb_validate_plan' , {
  title: 'Validate explicit PCB plan',
  description: 'Validate an easyeda-pcb-plan/v2 file or object offline. Checks exact units/target, legal phases, new board outlines centered at coordinate origin, native circle or closed polygon geometry, 45-degree copper, PTH/NPTH and terminal pads, widths, drills, annular rings, layers, bounds, component move policy and expected-state guards. Live cross-object pad collision is enforced during execution. It performs no EasyEDA write.',
  annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema: planInputSchema,
}, async ({ planPath, plan }) => handled(async () => {
  const { loaded, summary } = await validatePlanSource({ planPath, plan });
  return { ok: true, source: loaded.source, summary };
}));

server.registerTool('pcb_validate_text_plan', {
  title: 'Validate explicit PCB text plan',
  description: 'Validate an easyeda-pcb-text-plan/v1 file or object offline. Supports independent silkscreen string create/modify/delete and component-attribute text modify with explicit units and complete old-state guards. Performs no EasyEDA write.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: textPlanInputSchema,
}, async ({ planPath, plan }) => handled(async () => {
  const { loaded, summary } = await validateTextPlanSource({ planPath, plan });
  return { ok: true, source: loaded.source, summary };
}));

server.registerTool('pcb_execute_text_plan', {
  title: 'Execute explicit PCB text and attribute plan',
  description: 'Execute an already-decided easyeda-pcb-text-plan/v1 against the exact active PCB. Uses public text/attribute APIs, full expected-state guards, independent readback, bounded batches and save checkpoints. It does not auto-generate labels or certify readability/manufacturability.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...textPlanInputSchema, bridgeUrl: bridgeUrlSchema },
}, async ({ planPath, plan, bridgeUrl }) => handled(() => executeTextPlanSource({ planPath, plan }, { bridgeUrl })));

server.registerTool('pcb_execute_plan', {
  title: 'Execute explicit PCB layout/routing plan',
  description: 'Execute explicit easyeda-pcb-plan/v2 geometry with no auto-placement or path search. New outlines must be centered at [0,0]. Layout/relayout plans can execute one coherent placement round of up to 100 expanded operations. Before and after placement writes, live pad geometry blocks different-component pad overlap and standalone pad/via intrusion into component pads; unsafe native layer transforms are rolled back. Writes are independently read back and partial outcomes return exact recovery instructions.',
  annotations: {readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
  inputSchema: {
    ...planInputSchema,
    bridgeUrl: bridgeUrlSchema,
  },
}, async ({ planPath, plan, bridgeUrl }) => handled(() => executePlanSource({ planPath, plan }, { bridgeUrl })));

server.registerTool('pcb_read_constraints', {
  title: 'Read PCB rule and constraint groups',
  description: 'Read rule configurations, net rules, net-to-net rules, region rules, network classes, differential pairs, equal-length groups, pad-pair groups and real-time DRC status from the exact PCB. Performs no write and does not evaluate SI.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { target: targetSchema, bridgeUrl: bridgeUrlSchema },
}, async ({ target, bridgeUrl }) => handled(() => readConstraints({ target, bridgeUrl })));

server.registerTool('pcb_manage_constraint_group', {
  title: 'Manage one guarded PCB constraint group',
  description: 'Create, delete, rename or edit membership of a single network class, differential pair, equal-length group or pad-pair group. Requires exact old-state assertions for edits/deletes, independently reads back the result and optionally saves. Does not expose full rule-table overwrite APIs.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    target: targetSchema,
    operation: constraintOperationSchema,
    save: z.boolean().optional().default(true),
    bridgeUrl: bridgeUrlSchema,
  },
}, async ({ target, operation, save, bridgeUrl }) => handled(() => manageConstraintGroup({ target, operation, save, bridgeUrl })));

server.registerTool('pcb_realtime_drc', {
  title: 'Read or control EasyEDA real-time DRC',
  description: 'Read, start or stop EasyEDA native real-time DRC on the exact PCB. This toggles the editor DRC state only; it does not alter rule definitions or certify the design.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { target: targetSchema, action: z.enum(['status', 'start', 'stop']), bridgeUrl: bridgeUrlSchema },
}, async ({ target, action, bridgeUrl }) => handled(() => controlRealTimeDrc({ target, action, bridgeUrl })));

server.registerTool('pcb_prepare_schematic_sync', {
  title: 'Prepare guarded schematic-to-PCB synchronization',
  description: 'Read the associated schematic identity and a stable PCB snapshot, returning SHA-256 and runtime guards plus object counts. This is read-only and does not claim to provide EasyEDA change-preview details.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { target: targetSchema, bridgeUrl: bridgeUrlSchema },
}, async ({ target, bridgeUrl }) => handled(() => prepareSchematicSync({ target, bridgeUrl })));

server.registerTool('pcb_import_schematic_changes', {
  title: 'Import guarded schematic changes into PCB',
  description: 'Apply associated schematic changes only when the exact target, schematic and preflight digest still match. On EasyEDA clients where public importChanges opens the native confirmation dialog, the runtime applies that exact dialog through its stable Apply Changes control, then requires independent before/after PCB readback. A native true without PCB changes is an error. Optional expectedAfter component identities and pad nets are checked before save.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    target: targetSchema,
    schematicUuid: z.string().min(1),
    expectedBeforeDigest: z.string().regex(/^[0-9a-fA-F]{64}$/),
    expectedAfter:z.object({components:z.array(z.object({uniqueId:z.string().min(1),present:z.boolean().optional(),designator:z.string().min(1).optional(),name:z.string().optional()}).strict()).max(1000).optional(),pads:z.array(z.union([z.object({primitiveId:z.string().min(1),net:z.string()}).strict(),z.object({componentUniqueId:z.string().min(1),padNumber:z.string().min(1),net:z.string()}).strict()])).max(5000).optional()}).strict().refine(x=>(x.components?.length??0)+(x.pads?.length??0)>0,'Provide at least one ECO goal').optional(),
    save: z.boolean().optional().default(true),
    bridgeUrl: bridgeUrlSchema,
  },
}, async ({ target, schematicUuid, expectedBeforeDigest, expectedAfter, save, bridgeUrl }) => handled(() => importSchematicChanges({ target, schematicUuid, expectedBeforeDigest, expectedAfter, save, bridgeUrl })));

server.registerTool('pcb_save_and_drc', {
  title: 'Save PCB and run native DRC',
  description: 'Validate the exact PCB target, optionally save it, and run EasyEDA verbose native DRC as a resumable job. A completed response returns the full violation count and rule/category/layer summaries plus a bounded detail page; it never duplicates the full native tree. RUNNING returns drcJobId for save=false continuation. Operational completion is separate from whether violations exist.',
  annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema: {
    target: targetSchema,
    bridgeUrl: bridgeUrlSchema,
    save: z.boolean().optional().describe('Defaults to true for a new check and false when drcJobId continues an existing check'),
    runDrc: z.boolean().optional().default(true),
    drcJobId: z.string().min(1).max(160).optional().describe('Continue one RUNNING or COMPLETED DRC job; continuation must use save=false'),
    drcWaitMs: z.number().int().min(0).max(45000).optional().default(15000).describe('Maximum time to wait in this call before returning RUNNING'),
    drcPollIntervalMs: z.number().int().min(100).max(2000).optional().default(300),
    drcDetailOffset: z.number().int().min(0).optional().default(0),
    drcDetailLimit: z.number().int().min(0).max(250).optional().default(100),
    releaseDrcJob: z.boolean().optional().default(false).describe('Delete retained native results after this completed page is produced'),
  },
}, async args => handled(() => saveAndCheck(args)));

server.registerTool('pcb_verify_api_gates', {
  title: 'Run a stable read-only PCB API verification gate',
  description: 'Run two-pass PCB state snapshots before and after native verbose DRC plus a two-pass associated schematic/PCB netlist comparison. Reports whether the check completed and whether all API gates passed. It never saves or modifies the PCB and still requires visual, topology, current, SI, mechanical and manufacturing review.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    target: targetSchema,
    expectedSchematicUuid: z.string().min(1).optional(),
    drcDetailLimit: z.number().int().min(0).max(250).optional().default(100),
    netlistDetailLimit: z.number().int().min(0).max(1000).optional().default(100),
    bridgeUrl: bridgeUrlSchema,
  },
}, async args => handled(() => verifyApiGates(args)));

server.registerTool('pcb_list_targets', {
  title: 'Discover connected PCB targets without selecting windows',
  description: 'Read minimal project, board and document identities from explicitly addressed Bridge windows. Optional exact project filtering. Never changes shared activeWindowId, opens documents, clicks browsers or reads PCB primitives in excluded projects.',
  annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema: {bridgeUrl:bridgeUrlSchema, projectUuid:z.string().min(1).optional()},
}, async args=>handled(()=>listTargets(args)));
server.registerTool('pcb_open_target', {
  title: 'Open a verified PCB inside one exact EDA window',
  description: 'Open an already existing PCB belonging to the exact current project inside target.windowId. Requires current-document expectation (null means no document), checks immediately before opening and independently after. Does not switch projects or global/browser window selection.',
  annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  inputSchema: {target:targetSchema,expectedCurrentDocumentUuid:z.string().min(1).nullable(),bridgeUrl:bridgeUrlSchema},
}, async args=>handled(()=>openTarget(args)));
server.registerTool('pcb_inspect_silkscreen', {
  title: 'Inspect text attributes, dimensions and native bounds',
  description: 'Read actual independent silkscreen strings and component attributes together. Reports hidden attributes, nominal API font/stroke dimensions in mm, missing bounds and same-layer BBox intersection candidates. scope=all evaluates all selected objects including cross-page pairs with two matching full reads; default page mode covers only returned items. Does not certify glyph clearance, solder-mask openings, assembly visibility or manufacture.',
  annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema: {target:targetSchema,scope:z.enum(['page','all']).optional().default('page'),maximumObjects:z.number().int().min(1).max(5000).optional(),detailLimit:z.number().int().min(0).max(5000).optional(),ids:z.array(z.string().min(1)).min(1).max(200).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional(),minimumFontSizeMm:z.number().positive().max(10).optional(),minimumStrokeWidthMm:z.number().positive().max(2).optional(),bridgeUrl:bridgeUrlSchema},
}, async args=>handled(()=>args.scope==='all'?inspectAllSilkscreen(args):inspectSilkscreen(args)));
server.registerTool('pcb_compare_snapshots', {
  title: 'Compare explicit PCB snapshots field by field offline',
  description: 'Compare matching document/unit snapshot JSON objects or local .json files. Reports added, removed and changed fields by primitive ID, missing category coverage and non-text changes. Rejects duplicate IDs and incomplete pages. No PCB writes, source validity inference, topology reconstruction or manufacturing approval.',
  annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema: {before:z.unknown().optional(),after:z.unknown().optional(),beforePath:z.string().min(1).optional(),afterPath:z.string().min(1).optional(),detailLimit:z.number().int().min(0).max(1000).optional()},
}, async args=>handled(()=>compareSnapshotSources(args)));

server.registerTool('pcb_export_manufacturing', {
  title: 'Export bounded PCB manufacturing data without opening a dialog',
  description: 'Generate Gerber ZIP, pick-and-place, BOM, test-point, netlist or IPC-D-356A files through public EasyEDA File APIs. Creates a new local file only, validates type-specific extension/signature, bounded transfer and disk readback. Does not save/modify the PCB, upload, place an order or open browser/UI dialogs.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    target: targetSchema,
    kind: z.enum(['gerber', 'pickAndPlace', 'bom', 'testPoints', 'netlist', 'ipcD356A']),
    outputPath: z.string().min(1),
    format: z.enum(['xlsx', 'csv']).optional(),
    unit: z.enum(['mm', 'mil']).optional(),
    netlistType: z.enum(['JLCEDA_PRO', 'EASYEDA_PRO', 'PADS', 'ALTIUM_DESIGNER', 'ALLEGRO']).optional(),
    maxBytes: z.number().int().min(1).max(16777216).optional().default(8388608),
    bridgeUrl: bridgeUrlSchema,
  },
}, async request => handled(() => exportManufacturingFile(request)));

server.registerTool('pcb_export_backup', {
  title: 'Export a native project or PCB backup to a new local file',
  description: 'Export native EPRO via public file APIs, transfer bounded bytes over Bridge, create a new local .epro without overwrite and verify disk readback. Exact project/document/window required. No PCB modification, UI dialogs, external upload or restoration. Permission errors remain errors.',
  annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  inputSchema: {target:targetSchema,outputPath:z.string().min(1),scope:z.enum(['project','document']).optional().default('project'),maxBytes:z.number().int().min(4).max(16777216).optional().default(8388608),bridgeUrl:bridgeUrlSchema},
}, async request=>handled(()=>exportNativeBackup(request)));

server.registerTool('pcb_capture_view', {
  title: 'Capture exact PCB tab through the public rendered-image API',
  description: 'BETA: export the current rendered viewport of the exact verified PCB tab to a new local PNG. Uses getCurrentRenderedAreaImage with explicit tabId; no browser focus, selection, layer or zoom changes. Does not capture hidden layers, manufacture output or 3D. Bounded transfer with disk readback; no overwrite or upload.',
  annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  inputSchema: {target:targetSchema,outputPath:z.string().min(1),maxBytes:z.number().int().min(8).max(16777216).optional().default(8388608),bridgeUrl:bridgeUrlSchema},
}, async request=>handled(()=>captureView(request)));

server.registerTool('pcb_capture_inspection_view', {
  title: 'Capture the current PCB viewport with optional reversible layer isolation',
  description: 'Capture the exact PCB tab without panning, zooming, activating a tab or changing selection. Optional isolation is limited to currently enabled layers and success requires exact API-visible layer-state restoration. Writes a new local PNG only; no PCB document write or browser clicking.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    target: targetSchema,
    outputPath: z.string().min(1),
    visibleLayerIds: z.array(z.number().int()).min(1).max(64).optional(),
    settleMs: z.number().int().min(0).max(2000).optional().default(150),
    maxBytes: z.number().int().min(8).max(16777216).optional().default(8388608),
    bridgeUrl: bridgeUrlSchema,
  },
}, async request => handled(() => captureInspectionView(request)));

server.registerTool('pcb_render_inspection_svg', {
  title: 'Render a full-board or regional PCB inspection SVG without changing editor state',
  description: 'Read the complete typed PCB state twice, refuse drift and render selected visible/all/explicit layers to a new local SVG. Supports an explicit crop region and visible/all component labels. It never pans, zooms, switches focus, changes selection/layers or writes the PCB. The SVG is an inspection aid, not a connectivity, 3D, mask, assembly or manufacturing approval.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    target: targetSchema,
    outputPath: z.string().min(1),
    layerMode: z.enum(['visible', 'all', 'explicit']).optional().default('visible'),
    layerIds: z.array(z.number().int()).min(1).max(262).optional(),
    designators: z.enum(['visible', 'all', 'none']).optional().default('visible'),
    units: z.enum(['mil', 'mm']).optional().default('mil'),
    region: z.object({ left: z.number().finite(), right: z.number().finite(), top: z.number().finite(), bottom: z.number().finite() }).strict().optional(),
    margin: z.number().finite().min(0).optional(),
    maxBytes: z.number().int().min(1024).max(33554432).optional().default(16777216),
    bridgeUrl: bridgeUrlSchema,
  },
}, async request => handled(() => renderInspectionSvg(request)));

server.registerTool('pcb_capture_snapshot', {
  title:'Capture a complete typed PCB comparison snapshot',
  description:'Read twelve supported primitive categories, component plus standalone pads, netlist, layers and constraints twice. Refuse drifting data, save a NEW local JSON and verify disk readback. Coverage is field-limited, not a native backup, transaction lock or engineering approval. No PCB writes, upload or overwrite.',
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  inputSchema:{target:targetSchema,outputPath:z.string().min(1),maxBytes:z.number().int().min(1024).max(33554432).optional(),bridgeUrl:bridgeUrlSchema},
},async request=>handled(()=>captureSnapshot(request)));
server.registerTool('pcb_inspect_pinmap', {
  title:'Inspect actual component pin-to-net mappings',
  description:'Read explicitly selected components by IDs OR unique designators, real pad numbers/nets/positions and pose twice. Reject unavailable pins, ambiguous identity and drift. Optional expected rows expose pin swaps. No net edits, automatic labels or inferred mating/bottom-view order.',
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  inputSchema:{target:targetSchema,componentIds:z.array(z.string().min(1)).min(1).max(500).optional(),designators:z.array(z.string().min(1)).min(1).max(500).optional(),expected:z.array(z.object({componentId:z.string().min(1),padNumber:z.string().min(1),net:z.string()}).strict()).max(5000).optional(),bridgeUrl:bridgeUrlSchema},
},async request=>handled(()=>inspectPinmap(request)));

const exactTargetSchema = targetSchema.extend({
  projectUuid: z.string().min(1), windowId: z.string().min(1), tabId: z.string().min(1).optional(),
}).strict();
const expectedSchema = z.object({
  generationId: z.string().min(1), bridgeGenerationId: z.string().min(1), changeEpoch: z.number().int().min(0),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/), eventCoverage: z.enum(['partial', 'unavailable']).optional(),
}).strict();
const guardSchema = z.object({ schema: z.literal('easyeda-pcb-guard/v1'), planSha256: z.string().regex(/^[0-9a-f]{64}$/), target: exactTargetSchema, expected: expectedSchema }).strict();
const componentCleanupGuardSchema = z.object({
  schema: z.literal('easyeda-pcb-component-cleanup-guard/v2'),
  target: exactTargetSchema,
  expected: expectedSchema,
  previewSha256: z.string().regex(/^[0-9a-f]{64}$/),
  options: z.object({ unlockComponents: z.boolean(), deleteReferenceDesignators: z.boolean() }).strict(),
}).strict();
const executionFields = { expected: expectedSchema, executionId: z.string().min(1).max(160).optional() };
server.registerTool('pcb_cleanup_components', {
  title: 'Unlock components and remove reference-designator silkscreen',
  description: 'Preflight or execute one guarded bulk cleanup: leave all components movable and remove the visible silkscreen presentation of component Designator attributes. The mandatory Designator identity, component geometry, ordinary strings and non-Designator attributes are independently verified unchanged.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    target: exactTargetSchema,
    mode: z.enum(['preflight', 'execute']).optional().default('preflight'),
    unlockComponents: z.boolean().optional().default(true),
    deleteReferenceDesignators: z.boolean().optional().default(true),
    guard: componentCleanupGuardSchema.optional(),
    executionId: executionFields.executionId,
    bridgeUrl: bridgeUrlSchema,
  },
}, request => handled(() => cleanupComponents(request)));
const defaultNames = [
  'pcb_list_targets', 'pcb_open_target', 'pcb_status', 'pcb_read', 'pcb_pick',
  'pcb_execute_plan', 'pcb_execute_text_plan', 'pcb_cleanup_components', 'pcb_rebuild_pours', 'pcb_read_constraints', 'pcb_manage_constraint_group',
  'pcb_compare_associated_netlists', 'pcb_import_schematic_changes', 'pcb_audit_geometry', 'pcb_inspect_pinmap', 'pcb_inspect_silkscreen',
  'pcb_save_and_drc', 'pcb_verify_api_gates', 'pcb_render_inspection_svg', 'pcb_capture_inspection_view', 'pcb_export',
];
const diagnosticNames = ['pcb_capture_snapshot', 'pcb_compare_snapshots', 'pcb_realtime_drc'];
const descriptions = {
  pcb_list_targets: 'Discover connected windows and PCB documents without changing the active editor.',
  pcb_open_target: 'Open one existing PCB after checking the expected current document. If EasyEDA rebuilds the connection, rediscover exactly one matching project UUID and PCB UUID, verify it, and never replay openDocument.',
  pcb_status: 'Read exact PCB identity and units. Optionally include runtime capabilities, native board statistics or a prepared change-state guard.',
  pcb_read: 'Read paged native PCB objects or a parsed DSN route scene. DSN coordinates retain a separate frame until a transform is verified.',
  pcb_pick: 'Find native PCB objects by a point or rectangle without changing selection; coordinates require explicit units.',
  pcb_execute_plan: 'Execute PCB geometry with readback. Center new outlines on [0,0]. Layout/relayout defaults to one batch up to 100 operations. Reject cross-component pad overlap and standalone pad/via intrusion; roll back unsafe layer changes and return a placement gate.',
  pcb_execute_text_plan: 'Validate, prepare or execute a text/attribute plan. Execution requires its prepared guard and independently verifies written text.',
  pcb_cleanup_components: 'Preflight or execute guarded bulk cleanup: unlock all components and remove component reference-designator silkscreen while preserving mandatory Designator identity, geometry, ordinary strings and all other attributes.',
  pcb_rebuild_pours: 'Rebuild selected or all copper pours, read actual fill results and optionally save. Partial rebuilding may affect other fills on client 3.2.186.',
  pcb_read_constraints: 'Read native rule tables and network, differential-pair, equal-length and pad-pair groups.',
  pcb_manage_constraint_group: 'Change one constraint group with expected old values and independent readback; optionally save the PCB.',
  pcb_compare_associated_netlists: 'Read stable semantic differences between the associated schematic and PCB without importing changes.',
  pcb_import_schematic_changes: 'Preflight or apply associated schematic changes with PCB and netlist guards. Execute handles native confirmation and rejects no-op success. After a window reconnect, it accepts only exact-target final-state verification and never replays the write.',
  pcb_audit_geometry: 'Inspect supplied or live copper geometry and optional connectivity. Unmodeled copper and pad geometry keep connectivity explicitly partial.',
  pcb_inspect_pinmap: 'Read stable component pin numbers/nets and canonical pad hole dimensions. Raw footprint hole fields stay traceable; physicalDrill distinguishes real multi-layer drills from inactive SMD hole state.',
  pcb_inspect_silkscreen: 'Inspect visible text and component attributes for size, overlap and clipping; unavailable bounds remain unknown.',
  pcb_save_and_drc: 'Save the guarded PCB and/or run resumable verbose native DRC. Completed calls return full counts and summaries with paged violation details; RUNNING calls return drcJobId for continuation.',
  pcb_verify_api_gates: 'Run a stable read-only combination of snapshots, associated netlist comparison and native DRC.',
  pcb_render_inspection_svg: 'Create a deterministic board or region SVG from native geometry; disclose missing drawing categories.',
  pcb_capture_inspection_view: 'Capture the exact current PCB viewport to a new PNG; temporary enabled-layer isolation is restored and verified.',
  pcb_export: 'Create a new native backup, DSN or manufacturing file with byte/hash checks and atomic no-overwrite finalization.',
};

function buildDefaultRegistry() {
  const registry = new Map();
  for (const name of defaultNames.filter(name => name !== 'pcb_export')) {
    const entry = legacyRegistry.get(name);
    if (!entry) throw new Error(`Missing production capability ${name}`);
    const inputSchema = { ...entry.definition.inputSchema };
    if (inputSchema.target) inputSchema.target = name === 'pcb_audit_geometry' ? exactTargetSchema.optional() : exactTargetSchema;
    registry.set(name, { ...entry, definition: { ...entry.definition, description: descriptions[name], inputSchema } });
  }
  const change = (name, inputSchema, handler) => {
    const existing = registry.get(name);
    registry.set(name, { ...existing, definition: { ...existing.definition, inputSchema }, handler });
  };
  change('pcb_status', { target: exactTargetSchema, include: z.array(z.enum(['capabilities', 'nativeInfo', 'changeState'])).max(3).optional(), bridgeUrl: bridgeUrlSchema }, args => handled(() => statusPcb(args)));
  const read = registry.get('pcb_read');
  change('pcb_read', { ...read.definition.inputSchema,
    kind: z.enum(['snapshot', 'components', 'pads', 'lines', 'polylines', 'vias', 'pours', 'poured', 'fills', 'arcs', 'strings', 'attributes', 'regions', 'dimensions', 'images', 'objects', 'bounds', 'pins', 'layers', 'rules', 'nets', 'netMetrics', 'netlist', 'routeScene']),
    sceneSection: z.enum(['summary', 'boardOutline', 'layers', 'rules', 'components', 'images', 'padstacks', 'pads', 'nets', 'tracks', 'vias']).optional(), layerName: z.string().min(1).optional(),
  }, args => handled(async () => {
    if (args.kind === 'routeScene') {
      for (const key of ['ids', 'include', 'layer', 'parentPrimitiveId', 'region']) if (args[key] !== undefined) throw new Error(`${key} does not apply to a DSN scene`);
      return readRouteScene(args);
    }
    if (args.sceneSection !== undefined || args.layerName !== undefined) throw new Error('Scene-only parameters require kind=routeScene');
    if (args.kind === 'regions') return readNativeRegions(args);
    const { bridgeUrl, ...request } = args;
    return { ok: true, ...await readPcb(request, { bridgeUrl }) };
  }));
  for (const [name, kind] of [['pcb_execute_plan', 'geometry'], ['pcb_execute_text_plan', 'text']]) {
    change(name, { ...(kind === 'geometry' ? planInputSchema : textPlanInputSchema), mode: z.enum(['validate', 'prepare', 'execute']).optional().default('execute'), guard: guardSchema.optional(), executionId: executionFields.executionId, bridgeUrl: bridgeUrlSchema }, args => handled(() => runPlan({ planPath: args.planPath, plan: args.plan }, { kind, mode: args.mode, guard: args.guard, executionId: args.executionId, bridgeUrl: args.bridgeUrl })));
  }
  for (const [name, fn] of [['pcb_rebuild_pours', rebuildPours], ['pcb_manage_constraint_group', manageConstraintGroup]]) {
    change(name, { ...registry.get(name).definition.inputSchema, ...executionFields }, args => handled(() => runGuardedNative(args, () => fn(args))));
  }
  const sync = registry.get('pcb_import_schematic_changes');
  change('pcb_import_schematic_changes', {
    ...sync.definition.inputSchema, mode: z.enum(['preflight', 'execute']).optional().default('preflight'), schematicUuid: z.string().min(1).optional(), expectedBeforeDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(), expectedComparisonDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(), expected: expectedSchema.optional(), executionId: executionFields.executionId,
  }, args => handled(() => synchronizePcb(args)));
  const audit = registry.get('pcb_audit_geometry');
  change('pcb_audit_geometry', {
    ...audit.definition.inputSchema,
    snapshot: z.object({ units: z.enum(['mil', 'mm']), lines: z.array(z.unknown()).max(30000), pads: z.array(z.unknown()).max(30000).optional(), vias: z.array(z.unknown()).max(30000).optional(), arcs: z.array(z.unknown()).optional(), fills: z.array(z.unknown()).optional(), poured: z.array(z.unknown()).optional(), regions: z.array(z.unknown()).optional(), coverage: z.unknown().optional() }).strict().optional(),
    checks: z.array(z.enum(['geometry', 'connectivity'])).min(1).max(2).optional(), net: z.string().optional(), nativeUnroutedCount: z.number().int().min(0).optional(),
  }, args => handled(() => auditPcb(args)));
  change('pcb_save_and_drc', { ...registry.get('pcb_save_and_drc').definition.inputSchema, expected: expectedSchema.optional(), executionId: executionFields.executionId }, args => handled(() => {
    const effectiveSave = args.save ?? !args.drcJobId;
    const request = { ...args, save: effectiveSave };
    if (args.drcJobId && effectiveSave) return saveAndCheck(request);
    return effectiveSave ? runGuardedNative(request, () => saveAndCheck(request)) : saveAndCheck(request);
  }));
  registry.set('pcb_export', { name: 'pcb_export', definition: {
    title: 'Export native backup, routing scene or manufacturing data', description: descriptions.pcb_export,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { target: exactTargetSchema, kind: z.enum(['backup', 'dsn', 'gerber', 'bom', 'pick_place', 'test_point', 'netlist', 'ipc_d_356a']), outputPath: z.string().min(1), scope: z.enum(['project', 'document']).optional(), parseScene: z.boolean().optional(), format: z.enum(['xlsx', 'csv']).optional(), unit: z.enum(['mm', 'mil']).optional(), netlistType: z.enum(['JLCEDA_PRO', 'EASYEDA_PRO', 'PADS', 'ALTIUM_DESIGNER', 'ALLEGRO']).optional(), maxBytes: z.number().int().min(4).max(16777216).optional(), bridgeUrl: bridgeUrlSchema },
  }, handler: args => handled(() => exportPcb(args)) });
  return registry;
}
const productionRegistry = buildDefaultRegistry();
export function getToolRegistry(profile = 'default') {
  if (profile === 'default') return productionRegistry;
  if (profile === 'legacy') return legacyRegistry;
  if (profile === 'diagnostics') return new Map(diagnosticNames.map(name => {
    const entry = legacyRegistry.get(name);
    if (name !== 'pcb_realtime_drc') return [name, { ...entry, definition: { ...entry.definition, inputSchema: { ...entry.definition.inputSchema, ...(entry.definition.inputSchema.target ? { target: exactTargetSchema } : {}) } } }];
    return [name, { ...entry, definition: { ...entry.definition, inputSchema: { ...entry.definition.inputSchema, target: exactTargetSchema, expected: expectedSchema.optional(), executionId: executionFields.executionId } }, handler: args => handled(() => args.action === 'status' ? controlRealTimeDrc(args) : runGuardedNative(args, () => controlRealTimeDrc(args))) }];
  }));
  throw new Error('EASYEDA_PCB_PROFILE must be default, diagnostics or legacy');
}
export async function invokeRegisteredTool(name, arguments_, profile = 'default') {
  const entry = getToolRegistry(profile).get(name);
  if (!entry) throw new Error(`Tool ${name} is not registered in ${profile}`);
  return entry.handler(z.object(entry.definition.inputSchema).strict().parse(arguments_));
}
export function createPcbServer(profile = 'default') {
  const mcp = new McpServer({ name: 'easyeda-pcb', version: VERSION }, { instructions: 'Use exact window/project/document identities and explicit coordinate units. Geometry decisions are supplied by the caller; no automatic placement or routing. Keep reads dependency-scoped: after target/status and the exact prerequisites for the next operation are known, execute the plan instead of running broad audits. Writes require prepared generation/epoch/source guards, old object assertions and independent readback. Treat workflowReceipt as the continuation contract: report PCB progress only when boardProgressCredited and boardDelta.visibleBoardChange are true; validate, prepare, tests and deployment are not board changes. For recoveryDirective or RECONCILE_EXACT_OPERATION, read only minimumReadScope, obey replayPolicy, rebuild only unfinished work and immediately resume the saved parent PCB action. Do not expand a healthy local Bridge timeout into broad diagnostics or stop at connection recovery. Diagnostics and compatibility profiles are not production services.' });
  for (const entry of getToolRegistry(profile).values()) mcp.registerTool(entry.name, entry.definition, entry.handler);
  return mcp;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profile = process.env.EASYEDA_PCB_PROFILE ?? 'default';
  await createPcbServer(profile).connect(new StdioServerTransport());
  console.error(`easyeda-pcb ${VERSION} profile=${profile} tools=${getToolRegistry(profile).size}`);
}


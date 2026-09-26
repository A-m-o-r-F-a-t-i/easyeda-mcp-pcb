import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import {target,exactTarget,point,layer,region,editSchema,catalog} from './simple-contract.mjs';
import {resolvePcbTarget,applyEdits,readOverview,readRetained,compactResult,collectScene,renderView,codeFor,artifactDirectory,readReceipt,listReceipts} from './simple-service.mjs';
import {simpleReadRuntime,pickRuntime,constraintRuntime} from './simple-utilities.mjs';
import {listTargets,openTarget} from './target-tools.mjs';
import {executeBridgeCode,saveAndCheck,saveDocument} from './bridge.mjs';
import {rebuildPours,syncSchematic} from './native-actions.mjs';
import {compareAssociatedNetlists} from './netlist-compare.mjs';
import {auditPcb} from './audit-service.mjs';
import {inspectSilkscreen} from './silkscreen.mjs';
import {captureInspectionView} from './inspection-view.mjs';
import {exportPcb} from './export.mjs';

const common={target};
const pickRegion=z.object({...region.shape,fullyContained:z.boolean().optional()}).strict();
const color=z.object({r:z.number().int().min(0).max(255),g:z.number().int().min(0).max(255),b:z.number().int().min(0).max(255),alpha:z.number().min(0).max(1)}).strict();
const pair=z.tuple([z.string().min(1),z.string().min(1)]);
const groupOperation=z.object({groupType:z.enum(['netClass','differentialPair','equalLengthGroup','padPairGroup']),action:z.enum(['create','delete','rename','addMembers','removeMembers','setPositiveNet','setNegativeNet']),name:z.string().min(1),newName:z.string().min(1).optional(),nets:z.array(z.string().min(1)).optional(),padPairs:z.array(pair).optional(),positiveNet:z.string().min(1).optional(),negativeNet:z.string().min(1).optional(),net:z.string().min(1).optional(),color:color.nullable().optional()}).strict();
const groupPair=z.object({name:z.string().optional(),fromPadId:z.string().min(1),toPadId:z.string().min(1),maxDistanceMil:z.number().positive().optional()}).strict();
const group=z.object({name:z.string().min(1),role:z.string().optional(),nets:z.array(z.string().min(1)).min(1),region:z.object({minX:z.number(),maxX:z.number(),minY:z.number(),maxY:z.number()}).strict().optional(),pairs:z.array(groupPair).optional(),maxViaCount:z.number().int().nonnegative().optional()}).strict();
const referenceLayer=z.object({layer:z.number().int(),net:z.string().min(1)}).strict();
const topologyOptions={nets:z.array(z.string().min(1)).optional(),paths:z.array(z.object({net:z.string().min(1),from:z.string().min(1),to:z.string().min(1)}).strict()).max(128).optional(),sections:z.array(z.object({net:z.string().min(1),layer:z.number().int(),from:point,to:point}).strict()).max(256).optional(),excludeIds:z.array(z.string().min(1)).optional(),curveToleranceMil:z.number().positive().max(2).default(0.02)};
const exportKind=z.enum(['backup','dsn','gerber','bom','pick_place','test_point','netlist','ipc_d_356a']);

const stripSvg=value=>{const copy={...value},resources=[];if(copy.svg){resources.push({uri:copy.uri,text:copy.svg});delete copy.svg;}if(copy.view?.svg){copy.view={...copy.view};resources.push({uri:copy.view.uri,text:copy.view.svg});delete copy.view.svg;}return {copy,resources};};
async function response(fn){
 try{const value=await fn(),{copy,resources}=stripSvg(value),data=await compactResult(copy);return {isError:data.ok===false,content:[{type:'text',text:JSON.stringify(data)},...resources.map(item=>({type:'resource',resource:{uri:item.uri,mimeType:'image/svg+xml',text:item.text}}))],structuredContent:data};}
 catch(error){const data={ok:false,error:{code:error.code??'REQUEST_FAILED',message:String(error.message??error),details:error.details??null}};return {isError:true,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}
}
async function exact(args){const context=await resolvePcbTarget(args);return {args:{...args,target:context.target},context};}
function add(registry,name,description,inputSchema,handler,{readOnly=true}={}){registry.set(name,{name,definition:{title:name,description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,idempotentHint:readOnly,openWorldHint:false}},handler:args=>response(()=>handler(args))});}

export function createToolRegistry(){
 const registry=new Map();
 add(registry,'pcb_list_targets','List connected PCB documents. Does not switch or edit the application.',{projectUuid:z.string().optional()},listTargets);
 add(registry,'pcb_open_target','Open one exact PCB document in its already connected project window.',{target:exactTarget},args=>openTarget(args.target),{readOnly:false});
 add(registry,'pcb_status','Read exact PCB identity, client version and the fixed MIL coordinate contract.',common,async args=>{const {context}=await exact(args);return {...await executeBridgeCode(context.bridge,codeFor(simpleReadRuntime,{target:context.target,kind:'status'})),mcpVersion:'4.1.0',editingContract:'easyeda-pcb-edit/v4'};});
 add(registry,'pcb_read','Read MIL component overview, complete scene, retained results, operation schema or selected native objects.',{...common,kind:z.enum(['overview','scene','result','operations','receipt','receipts','topology','components','pads','lines','arcs','vias','polylines','fills','pours','poured','regions','strings','attributes','layers','nets','netlist']).default('overview'),refs:z.array(z.string()).optional(),ids:z.array(z.string()).optional(),net:z.string().optional(),layer:layer.optional(),region:region.optional(),angles:z.array(z.number().finite()).optional(),orientationCoordinates:z.boolean().optional(),...topologyOptions,receiptId:z.string().optional(),refresh:z.boolean().default(false),offset:z.number().int().nonnegative().optional(),limit:z.number().int().positive().max(5000).optional(),resultId:z.string().optional(),section:z.string().optional()},async args=>{
  if(args.kind==='operations')return {ok:true,...catalog(),regionRules:{NO_COMPONENTS:2,NO_WIRES:5,NO_FILLS:6,NO_POURS:7,NO_INNER_ELECTRICAL_LAYERS:8,FOLLOW_REGION_RULE:9}};
  if(args.kind==='result')return readRetained(args);
  if(args.kind==='receipt')return readReceipt(args);
  if(args.kind==='receipts')return listReceipts(args);
  if(args.kind==='topology')return auditPcb({...args,checks:['topology'],detailLimit:args.limit??100});
  if(args.kind==='overview')return readOverview(args);
  if(args.kind==='scene'){const {scene,target:resolved}=await collectScene(args);return {ok:true,target:resolved,...scene};}
  const {args:resolved,context}=await exact(args);return executeBridgeCode(context.bridge,codeFor(simpleReadRuntime,resolved));
 });
 add(registry,'pcb_pick','Find native PCB objects at a MIL point or inside a MIL rectangle.',{...common,point:point.optional(),region:pickRegion.optional(),offset:z.number().int().nonnegative().optional(),limit:z.number().int().positive().max(5000).optional()},async args=>{const {args:resolved,context}=await exact(args);return executeBridgeCode(context.bridge,codeFor(pickRuntime,resolved));});
 add(registry,'pcb_edit','Execute explicit MIL placement/orientation, routes/copper paths, via arrays and native edits. Durable optional requestId suppresses duplicate dispatch; receipts retain partial/unknown outcomes without automatic replay.',editSchema,applyEdits,{readOnly:false});
 add(registry,'pcb_read_constraints','Read native PCB rules and constraint groups as data.',common,async args=>{const {args:resolved,context}=await exact(args);return executeBridgeCode(context.bridge,codeFor(constraintRuntime,{...resolved,action:'read'}));});
 add(registry,'pcb_manage_constraint_group','Create, delete, rename or change one native constraint group.',{...common,operation:groupOperation,save:z.boolean().default(true)},async args=>{const {args:resolved,context}=await exact(args),result=await executeBridgeCode(context.bridge,codeFor(constraintRuntime,{...resolved,action:'manage'}));if(args.save&&result.ok)result.saved=await saveDocument(context.bridge,context.target);return result;},{readOnly:false});
 add(registry,'pcb_compare_associated_netlists','Compare the associated schematic and PCB logical component/pin net membership.',{...common,offset:z.number().int().nonnegative().default(0),limit:z.number().int().nonnegative().max(1000).default(100)},async args=>{const {args:resolved}=await exact(args);return compareAssociatedNetlists(resolved);});
 add(registry,'pcb_sync_schematic','Import changes from the one associated schematic, read the actual before/after state and optionally save.',{...common,save:z.boolean().default(true)},async args=>{const {args:resolved}=await exact(args);return syncSchematic(resolved);},{readOnly:false});
 add(registry,'pcb_rebuild_pours','Rebuild selected or all native pour boundaries and report actual fills and collateral changes.',{...common,pourIds:z.array(z.string().min(1)).optional(),save:z.boolean().default(true)},async args=>{const {args:resolved}=await exact(args);return rebuildPours(resolved);},{readOnly:false});
 add(registry,'pcb_save_and_drc','Save and/or run native DRC on demand, with asynchronous job continuation and paged findings.',{...common,save:z.boolean().optional(),runDrc:z.boolean().default(true),drcJobId:z.string().optional(),drcWaitMs:z.number().int().min(0).max(45000).default(15000),drcPollIntervalMs:z.number().int().min(100).max(2000).default(300),drcDetailOffset:z.number().int().nonnegative().default(0),drcDetailLimit:z.number().int().min(0).max(250).default(100),releaseDrcJob:z.boolean().default(false)},async args=>{const {args:resolved}=await exact(args);return saveAndCheck(resolved);},{readOnly:false});
 add(registry,'pcb_audit_geometry','Measure physical copper topology (including verified pours and holes), existing paths/layer changes/mandatory modeled vias, explicit cross-sections and functional groups. Coverage is reported; this never authorizes or blocks editing.',{...common,...topologyOptions,checks:z.array(z.enum(['geometry','connectivity','topology','groupQuality'])).min(1).default(['geometry']),toleranceMil:z.number().positive().max(2).default(0.02),detailLimit:z.number().int().min(0).max(5000).default(100),net:z.string().optional(),nativeUnroutedCount:z.number().int().nonnegative().optional(),groups:z.array(group).min(1).max(32).optional(),referenceLayers:z.array(referenceLayer).optional()},auditPcb);
 add(registry,'pcb_inspect_silkscreen','Return MIL text sizes, bounds and candidate same-layer overlaps for PCB silkscreen objects.',{...common,ids:z.array(z.string()).optional(),offset:z.number().int().nonnegative().default(0),limit:z.number().int().positive().max(5000).default(100),minimumFontSizeMil:z.number().positive().default(47.25),minimumStrokeWidthMil:z.number().positive().default(7.1)},async args=>{const {args:resolved}=await exact(args);return inspectSilkscreen(resolved);});
 add(registry,'pcb_render_svg','Render board or local SVG from current native MIL geometry, with optional pin/net labels.',{...common,outputPath:z.string().optional(),region:region.optional(),side:z.enum(['top','bottom','both']).default('top'),fit:z.enum(['board','all']).default('board'),layers:z.array(z.number().int()).optional(),nets:z.array(z.string()).optional(),pinLabels:z.boolean().default(true)},renderView);
 add(registry,'pcb_capture_view','Capture the exact current PCB viewport as PNG; optional layer isolation is restored before success.',{...common,outputPath:z.string().optional(),visibleLayerIds:z.array(z.number().int()).optional(),settleMs:z.number().int().min(0).max(2000).default(150),maxBytes:z.number().int().min(8).max(16777216).default(8388608)},async args=>{const {args:resolved}=await exact(args);await fs.mkdir(artifactDirectory(),{recursive:true});resolved.outputPath??=path.join(artifactDirectory(),`pcb-${crypto.randomUUID()}.png`);return captureInspectionView(resolved);});
 add(registry,'pcb_export','Export native backup, DSN, Gerber, BOM, MIL pick-and-place, test points, netlist or IPC-D-356A files.',{...common,kind:z.union([exportKind,z.array(exportKind).min(1)]),outputPath:z.string().optional(),outputDirectory:z.string().optional(),scope:z.enum(['project','document']).optional(),format:z.enum(['xlsx','csv']).optional(),netlistType:z.enum(['JLCEDA_PRO','EASYEDA_PRO','PADS','ALTIUM_DESIGNER','ALLEGRO']).optional()},async args=>{
  const {args:resolved}=await exact(args),kinds=Array.isArray(args.kind)?args.kind:[args.kind];if(kinds.length>1&&args.outputPath)throw Error('Use outputDirectory for multiple exports');
  const directory=args.outputDirectory??artifactDirectory();await fs.mkdir(directory,{recursive:true});const stem='pcb-'+crypto.randomUUID(),extensions={backup:'epro',dsn:'dsn',gerber:'zip',bom:args.format??'xlsx',pick_place:args.format??'xlsx',test_point:args.format??'xlsx',netlist:'net',ipc_d_356a:'ipc'},files=[];
  for(const kind of kinds){try{files.push(await exportPcb({...resolved,kind,outputPath:args.outputPath??path.join(directory,`${stem}-${kind}.${extensions[kind]}`)}));}catch(error){files.push({ok:false,kind,error:{code:error.code??'EXPORT_FAILED',message:String(error.message)}});}}
  return {ok:files.every(file=>file.ok),target:resolved.target,files};
 });
 return registry;
}

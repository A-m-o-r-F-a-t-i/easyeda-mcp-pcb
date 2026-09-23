import * as z from 'zod/v4';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {target,point,layer,region,editSchema,catalog} from './simple-contract.mjs';
import {resolvePcbTarget,applyEdits,readOverview,readRetained,compactResult,collectScene,renderView,codeFor,artifactDirectory} from './simple-service.mjs';
import {simpleReadRuntime,simpleConstraintRuntime} from './simple-utilities.mjs';
import {executeBridgeCode,saveAndCheck,saveDocument} from './bridge.mjs';
import {rebuildPours,prepareSchematicSync,importSchematicChanges} from './advanced.mjs';
import {compareAssociatedNetlists} from './netlist-compare.mjs';
import {auditPcb} from './production-tools.mjs';
import {exportPcb} from './export.mjs';

const common={target,bridgeUrl:z.string().url().optional()};
const stripSvg=value=>{const copy={...value},svgs=[];if(copy.svg){svgs.push({uri:copy.uri,text:copy.svg});delete copy.svg;}if(copy.view?.svg){copy.view={...copy.view};svgs.push({uri:copy.view.uri,text:copy.view.svg});delete copy.view.svg;}return {copy,svgs};};
async function reply(fn){
 try{const value=await fn(),{copy,svgs}=stripSvg(value),data=await compactResult(copy);return {isError:data.ok===false,content:[{type:'text',text:JSON.stringify(data)},...svgs.map(s=>({type:'resource',resource:{uri:s.uri,mimeType:'image/svg+xml',text:s.text}}))],structuredContent:data};}
 catch(e){const data={ok:false,error:{code:e.code??'REQUEST_FAILED',message:String(e.message??e),details:e.details??null}};return {isError:true,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}
}
function unwrap(value){if(value.structuredContent)return value.structuredContent;const text=value.content?.find(x=>x.type==='text')?.text;if(text){try{return JSON.parse(text);}catch{}}return value;}
const viewFields={...common,outputPath:z.string().optional(),units:z.enum(['mm','mil']).default('mm'),region:region.optional(),side:z.enum(['top','bottom','both']).default('top'),fit:z.enum(['board','all']).default('board'),layers:z.array(z.number().int()).optional(),nets:z.array(z.string()).optional(),pinLabels:z.boolean().default(true)};
export function createSimpleRegistry(previous){
 const registry=new Map();
 const add=(name,description,inputSchema,fn,readOnly=true)=>registry.set(name,{name,definition:{title:name,description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,idempotentHint:readOnly,openWorldHint:false}},handler:args=>reply(()=>fn(args))});
 const exact=async args=>{const c=await resolvePcbTarget(args);return {args:{...args,target:c.target},context:c};};
 const inherit=(name,description,omit=[])=>{const base=previous.get(name);const inputSchema={...base.definition.inputSchema,...common};for(const k of omit)delete inputSchema[k];add(name,description,inputSchema,async a=>{const {args}=await exact(a);return unwrap(await base.handler(args));},base.definition.annotations?.readOnlyHint??true);};
 add('pcb_list_targets','List connected PCB targets and names. Does not change the active editor.',previous.get('pcb_list_targets').definition.inputSchema,async a=>unwrap(await previous.get('pcb_list_targets').handler(a)));
 const open=previous.get('pcb_open_target');
 add('pcb_open_target','Open one exact PCB target. Current document is resolved internally; no prepare/guard sequence.',{...common,target:z.object({windowId:z.string().min(1),projectUuid:z.string().min(1),documentUuid:z.string().min(1),tabId:z.string().optional()}).strict()},async args=>{
  const {resolveBridge}=await import('./bridge.mjs'),b=await resolveBridge({bridgeUrl:args.bridgeUrl,windowId:args.target.windowId});const d=await executeBridgeCode(b,'return await eda.dmt_SelectControl.getCurrentDocumentInfo();');return unwrap(await open.handler({...args,expectedCurrentDocumentUuid:d?.uuid??null}));},false);
 add('pcb_status','Read current PCB identity, units and client version. A unique active PCB needs no target parameter.',common,async a=>{const {context}=await exact(a);return {...await executeBridgeCode(context.bridge,codeFor(simpleReadRuntime,{...a,target:context.target,kind:'status'})),mcpVersion:'3.0.0',editingContract:'easyeda-pcb-edit/v3'};});
 add('pcb_read','Read complete overview (footprint, size sources, pose, pin/net orientations), local scene or raw objects. kind=operations returns editing schemas; kind=result pages retained complete data. Native-object coordinates are labeled mil.',{
  ...common,kind:z.enum(['overview','scene','result','operations','components','pads','lines','arcs','vias','polylines','fills','pours','poured','regions','strings','attributes','layers','nets','netlist','routeScene','snapshot','bounds','pins','rules','netMetrics','dimensions','images','objects']).default('overview'),units:z.enum(['mm','mil']).default('mm'),refs:z.array(z.string()).optional(),ids:z.array(z.string()).optional(),net:z.string().optional(),layer:layer.optional(),region:region.optional(),angles:z.array(z.number().finite()).optional(),orientationCoordinates:z.boolean().optional(),offset:z.number().int().nonnegative().optional(),limit:z.number().int().positive().optional(),resultId:z.string().optional(),section:z.string().optional(),sceneSection:z.string().optional(),include:z.array(z.string()).optional(),parentPrimitiveId:z.string().optional()
 },async a=>{
  if(a.kind==='operations')return {ok:true,...catalog(),regionRules:{NO_COMPONENTS:2,NO_WIRES:5,NO_FILLS:6,NO_POURS:7,NO_INNER_ELECTRICAL_LAYERS:8,FOLLOW_REGION_RULE:9}};
  if(a.kind==='result')return readRetained(a);
  if(a.kind==='overview')return readOverview(a);
  if(a.kind==='scene'||a.kind==='snapshot'){const {scene,target}=await collectScene(a);return {ok:true,target,...scene};}
  const {context}=await exact(a);
  if(['routeScene','bounds','pins','rules','netMetrics','dimensions','images','objects'].includes(a.kind)){const allowed=previous.get('pcb_read').definition.inputSchema;const request=Object.fromEntries(Object.entries({...a,target:context.target}).filter(([k])=>k in allowed));return unwrap(await previous.get('pcb_read').handler(request));}
  return executeBridgeCode(context.bridge,codeFor(simpleReadRuntime,{...a,target:context.target}));
 });
 const pick=previous.get('pcb_pick');
 add('pcb_pick','Find exact native objects at a point or in a rectangle without changing selection.',{...pick.definition.inputSchema,...common,units:z.enum(['mm','mil']).default('mm')},async a=>{const {args}=await exact(a);return unwrap(await pick.handler(args));});
 add('pcb_execute_plan','Preferred bulk editor for placement, explicit routes, copper, mechanical objects and text. Submit typed operations directly in mm; no guard or design gate. Large batches retain order and return actual partial results plus optional SVG.',editSchema,applyEdits,false);
 add('pcb_execute_text_plan','Shortcut using the same typed bulk operation contract for text, attributes and other explicit edits; no separate text plan language.',editSchema,applyEdits,false);
 add('pcb_cleanup_components','Unlock selected/all components and hide attached Designator text without deleting component identity.',{...common,refs:z.array(z.string()).optional(),unlock:z.boolean().default(true),hideDesignators:z.boolean().default(true),save:z.boolean().default(true),view:z.enum(['auto','local','board','none']).default('none')},a=>applyEdits({...a,operations:[{op:'cleanup',refs:a.refs,unlock:a.unlock,hideDesignators:a.hideDesignators}]}),false);
 add('pcb_rebuild_pours','Rebuild selected or all pours and return actual fill results. Does not run DRC or judge design quality.',{...common,pourIds:z.array(z.string()).optional(),save:z.boolean().default(true)},async a=>{const {args}=await exact(a);return rebuildPours({...args,allowCollateralRebuild:true});},false);
 inherit('pcb_read_constraints','Read native rules and net/differential/equal-length/pad-pair groups as data.');
 add('pcb_manage_constraint_group','Create or change a native constraint group by name. Native arguments and current values are handled internally.',{...common,save:z.boolean().default(true),operation:z.object({groupType:z.enum(['netClass','differentialPair','equalLengthGroup','padPairGroup']),action:z.enum(['create','delete','rename','addMembers','removeMembers','setPositiveNet','setNegativeNet']),name:z.string().min(1),newName:z.string().optional(),nets:z.array(z.string()).optional(),padPairs:z.array(z.tuple([z.string(),z.string()])).optional(),positiveNet:z.string().optional(),negativeNet:z.string().optional(),net:z.string().optional(),color:z.object({r:z.number().int().min(0).max(255),g:z.number().int().min(0).max(255),b:z.number().int().min(0).max(255),alpha:z.number().min(0).max(1)}).nullable().optional()}).strict()},async a=>{const {args,context}=await exact(a);const output=await executeBridgeCode(context.bridge,codeFor(simpleConstraintRuntime,args));if(a.save&&output.ok)output.saved=await saveDocument(context.bridge,context.target);return output;},false);
 inherit('pcb_compare_associated_netlists','Return associated schematic/PCB logical differences. Does not import changes.');
 add('pcb_import_schematic_changes','Import changes from the PCB-associated schematic in one MCP call. No externally supplied digest/guard; return actual changes and native confirmation state.',{...common,save:z.boolean().default(true)},async a=>{
  const {args}=await exact(a),comparison=await compareAssociatedNetlists(args);
  if(comparison.inSync===true)return {ok:true,target:args.target,changed:false,imported:false,alreadyInSync:true};
  const before=await prepareSchematicSync(args);return importSchematicChanges({...args,schematicUuid:before.association.schematicUuid,expectedBeforeDigest:before.digest});
 },false);
 const audit=previous.get('pcb_audit_geometry');const auditSchema={...audit.definition.inputSchema,...common};
 add('pcb_audit_geometry','On-demand geometric/connectivity/group measurements from a supplied or single-read live scene. Reports data and coverage; never authorizes or blocks editing.',auditSchema,async a=>{if(a.snapshot)return auditPcb(a);const {scene,target}=await collectScene(a);return auditPcb({...a,target:undefined,snapshot:scene}).then(value=>({...value,target,coverage:scene.coverage}));});
 add('pcb_inspect_pinmap','Read selected or all components with actual pad numbers/nets, poses, footprint dimensions and same-side orientation maps. Default mm.',{...common,refs:z.array(z.string()).optional(),units:z.enum(['mm','mil']).default('mm'),angles:z.array(z.number().finite()).optional(),orientationCoordinates:z.boolean().optional()},readOverview);
 inherit('pcb_inspect_silkscreen','On-demand native text sizes, bounds and possible overlaps. Returns measurements only.');
 const drcSchema={...previous.get('pcb_save_and_drc').definition.inputSchema,...common};delete drcSchema.expected;delete drcSchema.executionId;
 add('pcb_save_and_drc','Save and/or run native DRC on demand. Return complete counts and paged details, with job continuation when running; no editing permission gate.',drcSchema,async a=>{const {args}=await exact(a);return saveAndCheck(args);},false);
 add('pcb_verify_api_gates','Compatibility name for an optional combined DRC/netlist data report. Returns facts, not editing permission.',{...previous.get('pcb_verify_api_gates').definition.inputSchema,...common},async a=>{const {args}=await exact(a);const drc=await saveAndCheck({...args,save:false}),netlist=await compareAssociatedNetlists({...args,limit:args.netlistLimit??args.netlistDetailLimit});return {ok:true,target:args.target,drc,netlist};});
 add('pcb_render_inspection_svg','Return whole-board or local SVG with readable component and pin/net labels. Bottom observation mirrors geometry once, keeping annotation text readable. outputPath optional.',viewFields,renderView);
 const capture=previous.get('pcb_capture_inspection_view');const captureSchema={...capture.definition.inputSchema,...common,outputPath:z.string().optional()};
 add('pcb_capture_inspection_view','Capture the native PCB viewport when needed. Optional temporary layers are restored. A new output path is generated if omitted.',captureSchema,async a=>{const {args}=await exact(a);await fs.mkdir(artifactDirectory(),{recursive:true});args.outputPath??=path.join(artifactDirectory(),`pcb-${crypto.randomUUID()}.png`);return unwrap(await capture.handler(args));});
 const kinds=z.enum(['backup','dsn','gerber','bom','pick_place','test_point','netlist','ipc_d_356a']);
 add('pcb_export','Export one native file or a manufacturing bundle using kind=[...]. Handles native calls and filenames; refuses accidental file overwrite.',{...common,kind:z.union([kinds,z.array(kinds).min(1)]),outputPath:z.string().optional(),outputDirectory:z.string().optional(),scope:z.enum(['project','document']).optional(),format:z.enum(['xlsx','csv']).optional(),unit:z.enum(['mm','mil']).optional(),netlistType:z.enum(['JLCEDA_PRO','EASYEDA_PRO','PADS','ALTIUM_DESIGNER','ALLEGRO']).optional()},async a=>{
  const {args}=await exact(a),items=Array.isArray(a.kind)?a.kind:[a.kind];if(items.length>1&&a.outputPath)throw Error('Use outputDirectory for multi-file export');
  const directory=a.outputDirectory??artifactDirectory();await fs.mkdir(directory,{recursive:true});const stem='pcb-'+crypto.randomUUID(),extensions={backup:'epro',dsn:'dsn',gerber:'zip',bom:a.format??'xlsx',pick_place:a.format??'csv',test_point:a.format??'csv',netlist:'net',ipc_d_356a:'ipc'};const outputs=[];
  for(const kind of items){try{outputs.push(await exportPcb({...args,kind,outputPath:a.outputPath??path.join(directory,`${stem}-${kind}.${extensions[kind]}`)}));}catch(e){outputs.push({ok:false,kind,error:{code:e.code??'EXPORT_FAILED',message:String(e.message)}});}}
  return {ok:outputs.every(x=>x.ok),target:args.target,files:outputs};
 },false);
 return registry;
}

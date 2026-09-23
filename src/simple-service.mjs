import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assertAllowedTarget,resolveBridge,executeBridgeCode,fetchJson,saveDocument} from './bridge.mjs';
import {createNativeHelpers} from './simple-native.mjs';
import {simpleEditRuntime} from './simple-runtime.mjs';
import {collectSceneRuntime,buildOverview,padBounds} from './component-overview.mjs';
import {renderFeedbackSvg} from './feedback-svg.mjs';
import {expandOperations} from './simple-contract.mjs';

export const artifactDirectory=()=>process.env.EASYEDA_PCB_ARTIFACT_DIR??path.join(os.tmpdir(),'easyeda-pcb-artifacts');
export const codeFor=(fn,request)=>`return await (${fn.toString()})(eda,${JSON.stringify(request)},${createNativeHelpers.toString()});`;
const error=(code,message,details)=>Object.assign(new Error(message),{code,details});

/** No global last-window cache: stdio servers can be shared by independent conversations. */
export async function resolvePcbTarget({target,bridgeUrl}={}){
 const requested=typeof target==='string'?{documentUuid:target}:target;
 if(requested?.windowId){
  const bridge=await resolveBridge({bridgeUrl,windowId:requested.windowId});
  const identity=await executeBridgeCode(bridge,'return {document:await eda.dmt_SelectControl.getCurrentDocumentInfo(),project:await eda.dmt_Project.getCurrentProjectInfo()};');
  if(identity.document?.documentType!==3||identity.document.uuid!==requested.documentUuid||requested.projectUuid&&identity.project?.uuid!==requested.projectUuid)throw error('TARGET_CHANGED','The selected window is not displaying the specified PCB',{requested,identity});
  const exact={windowId:bridge.windowId,projectUuid:identity.project.uuid,documentUuid:identity.document.uuid,...(identity.document.tabId?{tabId:identity.document.tabId}:{})};assertAllowedTarget(exact);return {target:exact,bridge};
 }
 const base=await resolveBridge({bridgeUrl,requireEda:false}),listing=await fetchJson(`${base.baseUrl}/eda-windows`),candidates=[],failures=[];
 for(const w of listing.windows??[]){if(!w.connected)continue;const bridge={...base,windowId:w.windowId};try{const identity=await executeBridgeCode(bridge,'return {document:await eda.dmt_SelectControl.getCurrentDocumentInfo(),project:await eda.dmt_Project.getCurrentProjectInfo()};');if(identity.document?.documentType!==3)continue;if(requested?.documentUuid&&requested.documentUuid!==identity.document.uuid)continue;if(requested?.projectUuid&&requested.projectUuid!==identity.project?.uuid)continue;candidates.push({target:{windowId:w.windowId,projectUuid:identity.project.uuid,documentUuid:identity.document.uuid,...(identity.document.tabId?{tabId:identity.document.tabId}:{})},bridge,name:identity.document.name,project:identity.project.name});}catch(e){failures.push({windowId:w.windowId,message:String(e.message)});}}
 if(candidates.length!==1)throw error('TARGET_SELECTION_REQUIRED','Select one exact PCB document UUID when multiple candidates exist',{candidates:candidates.map(({target,name,project})=>({...target,name,project})),failures});
 assertAllowedTarget(candidates[0].target);return candidates[0];
}
export async function collectScene({target,bridgeUrl,geometry=true},resolved){
 const context=resolved??await resolvePcbTarget({target,bridgeUrl});
 const scene=await executeBridgeCode(context.bridge,codeFor(collectSceneRuntime,{target:context.target,geometry}),180000);
 return {scene,...context};
}
export async function readOverview(request){const {scene,target}=await collectScene(request);return {ok:true,...buildOverview(scene,request),target};}

const heldResults=new Map();
export async function retainResult(value){
 const resultId=crypto.randomUUID(),directory=artifactDirectory();await fs.mkdir(directory,{recursive:true});const file=path.join(directory,`result-${resultId}.json`);await fs.writeFile(file,JSON.stringify(value),{flag:'wx'});heldResults.set(resultId,file);return {resultId,path:file};
}
export async function readRetained({resultId,section,offset=0,limit=200}){
 const file=heldResults.get(resultId);if(!file)throw error('RESULT_NOT_FOUND','Result is not retained by this MCP process');
 const data=JSON.parse(await fs.readFile(file,'utf8'));let selected=data;
 for(const key of (section??'').split('.').filter(Boolean)){if(!selected||!Object.hasOwn(selected,key))throw error('SECTION_NOT_FOUND','Result section is absent: '+section);selected=selected[key];}
 if(!Array.isArray(selected))return {ok:true,resultId,section:section??null,data:selected};
 return {ok:true,resultId,section,total:selected.length,offset,items:selected.slice(offset,offset+limit),nextOffset:offset+limit<selected.length?offset+limit:null};
}
export async function compactResult(value){
 const size=Buffer.byteLength(JSON.stringify(value));if(size<=120000)return value;
 const retained=await retainResult(value),summary={ok:value.ok??true,...retained,bytes:size,completeDataRetained:true,target:value.target??null,units:value.units??null,counts:value.counts??null};
 for(const key of ['totalComponents','returnedComponents','totalPads','coverage','executionId','saved','saveError','feedbackError','transportError','executionError','operationCounts','requestedOperationCount','expandedOperationCount','batchCount','nextIndex','view'])if(value[key]!==undefined)summary[key]=value[key];
 if(value.components)summary.componentIndex=value.components.map(c=>({ref:c.ref,id:c.id,name:c.name,footprint:c.footprint?.name??null,at:c.at,angle:c.angle,side:c.side,dimensions:c.dimensions,padCount:c.pads?.length}));
 summary.sections=Object.entries(value).filter(([,v])=>Array.isArray(v)).map(([name,items])=>({name,total:items.length}));
 summary.readWith={tool:'pcb_read',arguments:{kind:'result',resultId:retained.resultId,section:value.components?'components':value.results?'results':summary.sections[0]?.name,offset:0,limit:200}};
 return summary;
}
function modifiedRegion(results,scene){
 const ids=new Set(results.flatMap(r=>r.changes??[]).flatMap(c=>c.primitiveIds??[]));
 const points=[];
 const add=o=>{for(const [x,y]of [[o.x,o.y],[o.startX,o.startY],[o.endX,o.endY]])if(Number.isFinite(x)&&Number.isFinite(y))points.push([x,y]);};
 for(const c of scene.components)if(ids.has(c.primitiveId)){add(c);if(c.nativeBounds)points.push([c.nativeBounds.minX,c.nativeBounds.minY],[c.nativeBounds.maxX,c.nativeBounds.maxY]);}
 for(const p of scene.pads)if(ids.has(p.primitiveId)||ids.has(p.parentPrimitiveId??p.componentPrimitiveId)){const b=padBounds(p);if(b)points.push([b.minX,b.minY],[b.maxX,b.maxY]);}
 for(const kind of ['lines','arcs','vias','strings'])for(const o of scene[kind]??[])if(ids.has(o.primitiveId))add(o);
 if(!points.length)return null;
 const margin=2/0.0254;
 return {minX:Math.min(...points.map(p=>p[0]))-margin,maxX:Math.max(...points.map(p=>p[0]))+margin,minY:Math.min(...points.map(p=>p[1]))-margin,maxY:Math.max(...points.map(p=>p[1]))+margin};
}
export async function saveFeedback(scene,options={}){
 const render=renderFeedbackSvg(scene,options),directory=artifactDirectory();await fs.mkdir(directory,{recursive:true});
 const file=options.outputPath??path.join(directory,`pcb-${crypto.randomUUID()}.svg`);
 if(!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.svg')throw error('INVALID_PATH','SVG outputPath must be an absolute .svg path');
 await fs.writeFile(file,render.svg,{flag:'wx'});
 return {path:file,uri:pathToFileURL(file).href,bytes:Buffer.byteLength(render.svg),viewBox:render.viewBox,metadata:render.metadata,svg:render.svg};
}
export async function renderView(request){
 const {scene,target}=await collectScene(request),scale=request.units==='mil'?1:1/0.0254;
 const region=request.region?{minX:Math.min(request.region.left,request.region.right)*scale,maxX:Math.max(request.region.left,request.region.right)*scale,minY:Math.min(request.region.top,request.region.bottom)*scale,maxY:Math.max(request.region.top,request.region.bottom)*scale}:null;
 return {ok:true,target,...await saveFeedback(scene,{...request,region})};
}

/** The model submits one batch; transport slicing is internal and never repeats uncertain writes. */
export async function applyEdits(request,dependencies={}){
 if(request.planPath){if(request.operations)throw error('INVALID_PARAMETER','Supply operations or planPath, not both');if(!path.isAbsolute(request.planPath))throw error('INVALID_PATH','planPath must be absolute');const source=JSON.parse((await fs.readFile(request.planPath,'utf8')).replace(/^\uFEFF/,''));const {editSchema}=await import('./simple-contract.mjs');const z=await import('zod/v4');request=z.object(editSchema).strict().parse({...source,...Object.fromEntries(Object.entries(request).filter(([k])=>!['planPath','operations','units','save','view'].includes(k)))});if(request.planPath)throw error('INVALID_PARAMETER','Nested planPath is not supported');}
 if(!request.operations?.length)throw error('INVALID_PARAMETER','At least one explicit operation is required');
 const actions=expandOperations(request.operations),context=await (dependencies.resolve??resolvePcbTarget)(request),run=dependencies.run??executeBridgeCode;
 const executionId=crypto.randomUUID(),results=[];let offset=0,batches=0,transportError=null;
 while(offset<actions.length){
  let bytes=0,end=offset;
  while(end<actions.length){const next=Buffer.byteLength(JSON.stringify(actions[end]));if(end>offset&&bytes+next>196608)break;bytes+=next;end++;}
  const job={target:context.target,units:request.units??'mm',executionId,offset,operations:actions.slice(offset,end)};
  try{
   const batch=await run(context.bridge,codeFor(simpleEditRuntime,job),65000);batches++;
   if(!Number.isInteger(batch.nextIndex)||batch.nextIndex<=offset)throw error('INVALID_EXECUTION_RESULT','The native execution did not advance',{batch});
   results.push(...batch.results);offset=batch.nextIndex;
   if(batch.results.some(r=>r.status==='unknown'||r.error?.code==='TARGET_CHANGED'))break;
  }catch(e){
   transportError={code:e.code??'TRANSPORT_ERROR',message:String(e.message),outcome:'unknown'};
   try{const journal=await run(context.bridge,codeFor(simpleEditRuntime,{target:context.target,units:request.units??'mm',executionId,inspect:true}),20000);if(journal.found){const known=new Set(results.map(r=>r.index));results.push(...journal.results.filter(r=>!known.has(r.index)));offset=journal.nextIndex;transportError.journalRunning=journal.running;transportError.current=journal.current??null;transportError.outcome=journal.running?'in_progress':'journal_recovered';}}catch(readError){transportError.journalError=String(readError.message);}
   break;
  }
 }
 for(const a of actions.slice(offset))results.push({index:a.index,sourceIndex:a.sourceIndex,itemIndex:a.itemIndex,op:a.op,status:transportError&&a.index===offset?'unknown':'not_executed',changes:[]});
 const counts=results.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{}),output={ok:!transportError&&results.every(r=>r.status==='applied'),target:context.target,units:'mil',inputUnits:request.units??'mm',executionId,requestedOperationCount:request.operations.length,expandedOperationCount:actions.length,batchCount:batches,counts,results,saved:false,...(transportError?{transportError}:{})};
 if(request.save!==false&&!transportError&&!results.some(r=>r.status==='unknown'||r.error?.code==='TARGET_CHANGED')){try{output.saved=await (dependencies.save??saveDocument)(context.bridge,context.target);}catch(e){output.ok=false;output.saveError={code:e.code??'SAVE_FAILED',message:String(e.message)};}}
 if((request.view??'auto')!=='none'&&!transportError){
  try{const {scene}=await (dependencies.collect??collectScene)({target:context.target,geometry:true},context);const local=request.view==='board'?null:modifiedRegion(results,scene);output.view=await (dependencies.feedback??saveFeedback)(scene,{region:local,side:'both',pinLabels:request.view==='local'||request.view==='auto'&&!!local});}
  catch(e){output.feedbackError={message:String(e.message),pcbExecutionUnchanged:true};}
 }
 return output;
}

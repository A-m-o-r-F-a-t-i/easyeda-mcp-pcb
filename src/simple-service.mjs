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
import {executeWithReceipt,getReceipt,listReceipts,summarizeChanges} from './execution-receipts.mjs';
import {parseComplexPolygon} from './polygon-path.mjs';

export const artifactDirectory=()=>process.env.EASYEDA_PCB_ARTIFACT_DIR??path.join(os.tmpdir(),'easyeda-pcb-artifacts');
export const codeFor=(fn,request)=>`return await (${fn.toString()})(eda,${JSON.stringify(request)},${createNativeHelpers.toString()});`;
const error=(code,message,details)=>Object.assign(new Error(message),{code,details});

/** No global last-window cache: stdio servers can be shared by independent conversations. */
export async function resolvePcbTarget({target}={}){
 const requested=typeof target==='string'?{documentUuid:target}:target;
 if(requested?.windowId){
  const bridge=await resolveBridge({windowId:requested.windowId});
  const identity=await executeBridgeCode(bridge,'return {document:await eda.dmt_SelectControl.getCurrentDocumentInfo(),project:await eda.dmt_Project.getCurrentProjectInfo()};');
  if(identity.document?.documentType!==3||identity.document.uuid!==requested.documentUuid||requested.projectUuid&&identity.project?.uuid!==requested.projectUuid)throw error('TARGET_CHANGED','The selected window is not displaying the specified PCB',{requested,identity});
  const exact={windowId:bridge.windowId,projectUuid:identity.project.uuid,documentUuid:identity.document.uuid,...(identity.document.tabId?{tabId:identity.document.tabId}:{})};assertAllowedTarget(exact);return {target:exact,bridge};
 }
 const base=await resolveBridge({requireEda:false}),listing=await fetchJson(`${base.baseUrl}/eda-windows`),candidates=[],failures=[];
 for(const w of listing.windows??[]){if(!w.connected)continue;const bridge={...base,windowId:w.windowId};try{const identity=await executeBridgeCode(bridge,'return {document:await eda.dmt_SelectControl.getCurrentDocumentInfo(),project:await eda.dmt_Project.getCurrentProjectInfo()};');if(identity.document?.documentType!==3)continue;if(requested?.documentUuid&&requested.documentUuid!==identity.document.uuid)continue;if(requested?.projectUuid&&requested.projectUuid!==identity.project?.uuid)continue;candidates.push({target:{windowId:w.windowId,projectUuid:identity.project.uuid,documentUuid:identity.document.uuid,...(identity.document.tabId?{tabId:identity.document.tabId}:{})},bridge,name:identity.document.name,project:identity.project.name});}catch(e){failures.push({windowId:w.windowId,message:String(e.message)});}}
 if(candidates.length!==1)throw error('TARGET_SELECTION_REQUIRED','Select one exact PCB document UUID when multiple candidates exist',{candidates:candidates.map(({target,name,project})=>({...target,name,project})),failures});
 assertAllowedTarget(candidates[0].target);return candidates[0];
}
export async function collectScene({target,geometry=true},resolved){
 const context=resolved??await resolvePcbTarget({target});
 const scene=await executeBridgeCode(context.bridge,codeFor(collectSceneRuntime,{target:context.target,geometry}),180000);
 return {scene,...context};
}
export async function readOverview(request){const {scene,target}=await collectScene(request);return {ok:true,...buildOverview(scene,request),target};}

const heldResults=new Map();
export async function retainResult(value){
 const resultId=crypto.randomUUID(),directory=artifactDirectory();await fs.mkdir(directory,{recursive:true});const file=path.join(directory,`result-${resultId}.json`);await fs.writeFile(file,JSON.stringify(value),{flag:'wx'});heldResults.set(resultId,file);return {resultId,path:file};
}
export async function readRetained({resultId,section,offset=0,limit=200}){
 if(typeof resultId!=='string'||!/^[a-f0-9-]{36}$/.test(resultId))throw error('RESULT_NOT_FOUND','Invalid retained result ID');
 const file=heldResults.get(resultId)??path.join(artifactDirectory(),`result-${resultId}.json`);
 const data=JSON.parse(await fs.readFile(file,'utf8'));let selected=data;
 for(const key of (section??'').split('.').filter(Boolean)){if(!selected||!Object.hasOwn(selected,key))throw error('SECTION_NOT_FOUND','Result section is absent: '+section);selected=selected[key];}
 if(!Array.isArray(selected))return {ok:true,resultId,section:section??null,data:selected};
 return {ok:true,resultId,section,total:selected.length,offset,items:selected.slice(offset,offset+limit),nextOffset:offset+limit<selected.length?offset+limit:null};
}
export async function compactResult(value){
 const size=Buffer.byteLength(JSON.stringify(value));if(size<=120000)return value;
 const retained=await retainResult(value),summary={ok:value.ok??true,...retained,bytes:size,completeDataRetained:true,target:value.target??null,units:value.units??null,counts:value.counts??null};
 for(const key of ['totalComponents','returnedComponents','totalPads','coverage','executionId','saved','saveError','feedbackError','transportError','executionError','operationCounts','requestedOperationCount','expandedOperationCount','batchCount','nextIndex','view','receiptId','receiptState','replayed','boardDelta','wrotePcb','transactional','automaticReplay'])if(value[key]!==undefined)summary[key]=value[key];
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
 for(const kind of ['fills','pours','regions','polylines'])for(const o of scene[kind]??[])if(ids.has(o.primitiveId))for(const p of parseComplexPolygon(o.polygon??o.complexPolygon)){points.push([p.bounds.minX,p.bounds.minY],[p.bounds.maxX,p.bounds.maxY]);}
 for(const kind of ['lines','arcs','vias','strings'])for(const o of scene[kind]??[])if(ids.has(o.primitiveId))add(o);
 if(!points.length)return null;
 const margin=80;
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
 const {scene,target}=await collectScene(request);
 const region=request.region?{minX:Math.min(request.region.left,request.region.right),maxX:Math.max(request.region.left,request.region.right),minY:Math.min(request.region.top,request.region.bottom),maxY:Math.max(request.region.top,request.region.bottom)}:null;
 return {ok:true,target,...await saveFeedback(scene,{...request,region})};
}

/** The model submits one batch; transport slicing is internal and never repeats uncertain writes. */
async function performEdits(request,dependencies={}){
 if(!request.operations?.length)throw error('INVALID_PARAMETER','At least one explicit operation is required');
 const actions=expandOperations(request.operations),context=await (dependencies.resolve??resolvePcbTarget)(request),run=dependencies.run??executeBridgeCode;
 const executionId=dependencies.executionId??crypto.randomUUID(),results=[];let offset=0,batches=0,transportError=null;
 await dependencies.onProgress?.({target:context.target,executionId,dispatchStarted:false,wrotePcb:false,nextIndex:0});
 while(offset<actions.length){
  let bytes=0,end=offset;
  while(end<actions.length){const next=Buffer.byteLength(JSON.stringify(actions[end]));if(end>offset&&bytes+next>196608)break;bytes+=next;end++;}
  const job={target:context.target,executionId,offset,operations:actions.slice(offset,end)};
  try{
   await dependencies.onProgress?.({dispatchStarted:true,wrotePcb:results.some(r=>r.changes?.length)?true:null,nextIndex:offset});
   const batch=await run(context.bridge,codeFor(simpleEditRuntime,job),65000);batches++;
   if(!Number.isInteger(batch.nextIndex)||batch.nextIndex<=offset)throw error('INVALID_EXECUTION_RESULT','The native execution did not advance',{batch});
   results.push(...batch.results);offset=batch.nextIndex;
   await dependencies.onProgress?.({target:context.target,nextIndex:offset,...summarizeChanges(results),results});
   if(batch.results.some(r=>r.status==='unknown'||r.error?.code==='TARGET_CHANGED'))break;
  }catch(e){
   transportError={code:e.code??'TRANSPORT_ERROR',message:String(e.message),outcome:'unknown'};
   try{const journal=await run(context.bridge,codeFor(simpleEditRuntime,{target:context.target,executionId,inspect:true}),20000);if(journal.found){const known=new Set(results.map(r=>r.index));results.push(...journal.results.filter(r=>!known.has(r.index)));offset=journal.nextIndex;transportError.journalRunning=journal.running;transportError.current=journal.current??null;transportError.outcome=journal.running?'in_progress':'journal_recovered';}}catch(readError){transportError.journalError=String(readError.message);}
   break;
  }
 }
 for(const a of actions.slice(offset))results.push({index:a.index,sourceIndex:a.sourceIndex,itemIndex:a.itemIndex,op:a.op,status:transportError&&a.index===offset?'unknown':'not_executed',changes:[]});
 const counts=results.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{}),output={ok:!transportError&&results.every(r=>r.status==='applied'),target:context.target,units:'mil',executionId,requestedOperationCount:request.operations.length,expandedOperationCount:actions.length,batchCount:batches,nextIndex:offset,counts,results,...summarizeChanges(results),saved:false,...(transportError?{transportError}:{})};
 if(request.save!==false&&!transportError&&!results.some(r=>r.status==='unknown'||r.error?.code==='TARGET_CHANGED')){try{output.saved=await (dependencies.save??saveDocument)(context.bridge,context.target);if(output.saved!==true){output.ok=false;output.saveError={code:'SAVE_NOT_ACKNOWLEDGED',message:'The native save did not return true'};}}catch(e){output.ok=false;output.saveError={code:e.code??'SAVE_FAILED',message:String(e.message)};}}
 if((request.view??'auto')!=='none'&&!transportError){
  try{const {scene}=await (dependencies.collect??collectScene)({target:context.target,geometry:true},context);const local=request.view==='board'?null:modifiedRegion(results,scene);output.view=await (dependencies.feedback??saveFeedback)(scene,{region:local,side:'both',pinLabels:request.view==='local'||request.view==='auto'&&!!local});}
  catch(e){output.feedbackError={message:String(e.message),pcbExecutionUnchanged:true};}
 }
 return output;
}

export async function applyEdits(request,dependencies={}){
 expandOperations(request.operations??[]);
 return executeWithReceipt(request,(executionId,onProgress)=>performEdits(request,{...dependencies,executionId,onProgress}),{directory:dependencies.receiptDirectory});
}
export {listReceipts};
export async function readReceipt({receiptId,refresh=false}){
 const receipt=await getReceipt(receiptId);
 if(!refresh||!receipt.executionId||!receipt.target)return receipt;
 try{const context=await resolvePcbTarget({target:receipt.target});const journal=await executeBridgeCode(context.bridge,codeFor(simpleEditRuntime,{target:context.target,executionId:receipt.executionId,inspect:true}),20000);return {...receipt,nativeJournal:journal,nativeJournalReadOnly:true};}
 catch(e){return {...receipt,nativeJournalError:{code:e.code??'JOURNAL_READ_FAILED',message:String(e.message)}};}
}

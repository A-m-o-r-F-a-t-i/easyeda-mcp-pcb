import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const receiptDirectory=()=>path.join(process.env.EASYEDA_PCB_STATE_DIR??process.env.PLUGIN_DATA??path.join(os.homedir(),'.easyeda-pcb'),'receipts');
const safeId=id=>{if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw Object.assign(new Error('Invalid receipt/request ID'),{code:'INVALID_RECEIPT_ID'});return id;};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])])):value;
const fingerprint=request=>crypto.createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
async function readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function atomicJson(file,value){const temporary=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}}
function names(id,directory){safeId(id);return {intent:path.join(directory,id+'.intent.json'),progress:path.join(directory,id+'.progress.json'),result:path.join(directory,id+'.result.json')};}
export async function getReceipt(receiptId,{directory=receiptDirectory()}={}){
 const files=names(receiptId,directory),intent=await readJson(files.intent);
 if(!intent)throw Object.assign(new Error('Execution receipt was not found'),{code:'RECEIPT_NOT_FOUND'});
 const result=await readJson(files.result);
 if(result)return {...result,receiptId,receiptState:result.transportError||result.counts?.unknown?'review_required':'completed',replayed:true};
 const progress=await readJson(files.progress);
 return {ok:false,receiptId,receiptState:'incomplete',executionId:intent.executionId,target:progress?.target??intent.requestTarget??null,createdAt:intent.createdAt,progress:progress??null,wrotePcb:progress?.wrotePcb??null,automaticReplay:false,error:{code:'EXECUTION_OUTCOME_UNCONFIRMED',message:'The durable intent exists without a terminal receipt. Inspect the native journal and actual objects; do not resubmit this write.'}};
}
export async function listReceipts({target,offset=0,limit=30,directory=receiptDirectory()}={}){
 let files;try{files=await fs.readdir(directory);}catch(e){if(e.code==='ENOENT')return {ok:true,total:0,items:[],nextOffset:null};throw e;}
 const rows=[];
 for(const name of files.filter(f=>f.endsWith('.intent.json'))){const id=name.slice(0,-12),intent=await readJson(path.join(directory,name));if(!intent)continue;const progress=await readJson(names(id,directory).progress),resolved=progress?.target??intent.requestTarget;const documentUuid=typeof resolved==='string'?resolved:resolved?.documentUuid;if(target&&documentUuid!==target)continue;const done=await readJson(names(id,directory).result);rows.push({receiptId:id,executionId:intent.executionId,target:done?.target??resolved,createdAt:intent.createdAt,state:done?(done.transportError||done.counts?.unknown?'review_required':'completed'):'incomplete',wrotePcb:done?.wrotePcb??progress?.wrotePcb??null,saved:done?.saved??null,counts:done?.counts??null});}
 rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return {ok:true,total:rows.length,offset,items:rows.slice(offset,offset+limit),nextOffset:offset+limit<rows.length?offset+limit:null};
}
/** Exclusive durable intent prevents duplicate dispatch; it is not a native PCB transaction. */
export async function executeWithReceipt(request,execute,{directory=receiptDirectory()}={}){
 const receiptId=safeId(request.requestId??crypto.randomUUID()),files=names(receiptId,directory),digest=fingerprint(request);
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const intent={schema:'easyeda-pcb-receipt/v1',receiptId,executionId:crypto.randomUUID(),fingerprint:digest,requestTarget:request.target??null,createdAt:new Date().toISOString(),requestedOperationCount:request.operations?.length??0};
 let handle;
 try{handle=await fs.open(files.intent,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;const prior=await readJson(files.intent);if(!prior||prior.fingerprint!==digest)throw Object.assign(new Error('This request ID is already bound to different content'),{code:'REQUEST_ID_CONFLICT',details:{receiptId}});return getReceipt(receiptId,{directory});}
 try{await handle.writeFile(JSON.stringify(intent));await handle.sync();}finally{await handle.close();}
 let progress={executionId:intent.executionId,wrotePcb:false},result;
 const update=async value=>{progress={...progress,...value};await atomicJson(files.progress,progress);};
 try{result=await execute(intent.executionId,update);}
 catch(e){result={ok:false,executionId:intent.executionId,target:progress.target??intent.requestTarget,wrotePcb:progress.dispatchStarted?null:false,saved:false,counts:progress.counts??{},error:{code:e.code??'EXECUTION_FAILED',message:String(e.message),details:e.details??null},...(progress.dispatchStarted?{transportError:{outcome:'unknown',message:'Execution ended without a complete receipt'}}:{})};}
 const output={...result,receiptId,replayed:false,automaticReplay:false,transactional:false};
 try{await atomicJson(files.result,output);}catch(e){output.receiptError={code:'RECEIPT_PERSIST_FAILED',message:String(e.message)};output.ok=false;}
 return output;
}
export function summarizeChanges(results){
 const groups={created:{},modified:{},deleted:{}};
 for(const row of results)for(const change of row.changes??[]){const name={create:'created',modify:'modified',delete:'deleted'}[change.action];if(!name)continue;const ids=groups[name][change.kind]??=[];ids.push(...(change.primitiveIds??[]));}
 for(const group of Object.values(groups))for(const key of Object.keys(group))group[key]=[...new Set(group[key])];
 const total=Object.values(groups).reduce((sum,g)=>sum+Object.values(g).reduce((n,ids)=>n+ids.length,0),0),hasUnknown=results.some(r=>r.status==='unknown');
 return {boardDelta:groups,wrotePcb:total>0?true:hasUnknown?null:false,confirmedChangedObjectReferences:total};
}

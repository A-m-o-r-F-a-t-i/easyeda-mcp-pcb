import {buildDrcStartCode,buildDrcStatusCode,createDrcJobId,waitForDrcJob} from './drc-job.mjs';

const MIN_PORT=49620;
const MAX_PORT=49629;
const DEFAULT_TIMEOUT_MS=65_000;

function fail(message,details,code){const error=new Error(message);if(details!==undefined)error.details=details;if(code)error.code=code;throw error;}

export function normalizeBridgeUrl(value){
 if(value==null||value==='')return null;
 let parsed;try{parsed=new URL(value);}catch{fail('EASYEDA_BRIDGE_URL must be a valid URL');}
 const port=Number(parsed.port);
 if(parsed.protocol!=='http:'||!['127.0.0.1','localhost'].includes(parsed.hostname)||!Number.isInteger(port)||port<MIN_PORT||port>MAX_PORT||parsed.pathname!=='/'||parsed.search||parsed.hash||parsed.username||parsed.password)fail(`EASYEDA_BRIDGE_URL must be http://127.0.0.1:${MIN_PORT}-${MAX_PORT}`);
 return parsed.origin;
}

export async function fetchJson(url,options={},timeoutMs=DEFAULT_TIMEOUT_MS){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetch(url,{...options,signal:controller.signal}),maximumResponseBytes=64*1024*1024,declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared)&&declared>maximumResponseBytes){await response.body?.cancel?.();fail('Bridge response exceeds byte limit');}
  let text;
  if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let bytes=0;try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>maximumResponseBytes){await reader.cancel();fail('Bridge response exceeds byte limit');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}text=Buffer.concat(chunks).toString('utf8');}
  else{text=await response.text();if(Buffer.byteLength(text,'utf8')>maximumResponseBytes)fail('Bridge response exceeds byte limit');}
  let body;try{body=text?JSON.parse(text):{};}catch{fail(`Bridge returned non-JSON data from ${url}`,{preview:text.slice(0,300)});}
  if(!response.ok){const payload=body?.error,error=new Error(`Bridge HTTP ${response.status}: ${String(payload?.message??payload??body?.message??'request failed').slice(0,1500)}`);error.code=payload?.code??'BRIDGE_HTTP_ERROR';error.details=payload?.details??body;throw error;}
  return body;
 }catch(error){if(error?.name==='AbortError')fail(`Bridge request timed out after ${timeoutMs} ms: ${url}`,{outcome:'unknown',requiresReadbackBeforeRetry:true},'REQUEST_TIMEOUT');throw error;}finally{clearTimeout(timer);}
}

export async function resolveBridge({windowId=null,requireEda=true}={}){
 const explicit=normalizeBridgeUrl(process.env.EASYEDA_BRIDGE_URL??null),candidates=explicit?[explicit]:Array.from({length:MAX_PORT-MIN_PORT+1},(_,i)=>`http://127.0.0.1:${MIN_PORT+i}`),failures=[];
 for(const baseUrl of candidates){
  try{
   const health=await fetchJson(`${baseUrl}/health`,{},explicit?2500:1200);
   if(health?.service!=='easyeda-bridge'){failures.push({baseUrl,error:'service identifier mismatch'});continue;}
   if(requireEda&&!health.edaConnected)fail('EasyEDA Bridge is running, but no EasyEDA window is connected');
   const listing=requireEda?await fetchJson(`${baseUrl}/eda-windows`,{},2500):null,connected=listing?.windows?.filter(item=>item.connected===true)??[];
   if(requireEda&&!windowId&&connected.length>1)fail('Multiple EasyEDA windows are connected; specify an exact PCB document UUID');
   if(requireEda&&windowId&&!connected.some(item=>item.windowId===windowId))fail('Exact EasyEDA window is not connected',{windowId});
   const resolvedWindowId=windowId??(requireEda?connected[0]?.windowId:null)??null;
   if(requireEda&&!resolvedWindowId)fail('No connected EasyEDA window');
   return {baseUrl,health,windowId:resolvedWindowId};
  }catch(error){if(explicit)throw error;failures.push({baseUrl,error:String(error?.message??error)});}
 }
 fail(`No EasyEDA Bridge found on 127.0.0.1:${MIN_PORT}-${MAX_PORT}`,{failures});
}

export async function executeBridgeCode(bridge,code,timeoutMs=DEFAULT_TIMEOUT_MS){
 const body={code};if(bridge.windowId)body.windowId=bridge.windowId;
 const payload=await fetchJson(`${bridge.baseUrl}/execute`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},timeoutMs);
 if(!payload?.success)fail(payload?.error??'EasyEDA Bridge execution failed',payload);
 if(bridge.windowId&&payload.windowId&&payload.windowId!==bridge.windowId)fail('Bridge response window mismatch; inspect actual state before retry');
 return payload.result;
}

export function assertAllowedTarget(target){
 const config=process.env.EASYEDA_ALLOWED_PROJECT_UUIDS;if(!config)return;
 let allowed;try{allowed=JSON.parse(config);}catch{fail('EASYEDA_ALLOWED_PROJECT_UUIDS must be a JSON string array');}
 if(!Array.isArray(allowed)||!allowed.length||!allowed.every(item=>typeof item==='string'&&item.trim()))fail('EASYEDA_ALLOWED_PROJECT_UUIDS must be a nonempty JSON string array');
 if(!target?.projectUuid||!target?.windowId||!allowed.includes(target.projectUuid))fail('Target outside configured project scope');
}

const statusCode=target=>`const d=await eda.dmt_SelectControl.getCurrentDocumentInfo();const p=await eda.dmt_Project.getCurrentProjectInfo();if(d?.uuid!==${JSON.stringify(target.documentUuid)}||d?.documentType!==3)throw Error('PCB document/type mismatch');if(p?.uuid!==${JSON.stringify(target.projectUuid)})throw Error('PCB project mismatch');return {document:d,project:{uuid:p.uuid,name:p.friendlyName??p.name},canvasOrigin:await eda.pcb_Document.getCanvasOrigin(),clientVersion:await eda.sys_Environment?.getEditorCurrentVersion?.()??null};`;

export async function saveDocument(bridge,target){
 assertAllowedTarget(target);
 const code=`const d=await eda.dmt_SelectControl.getCurrentDocumentInfo();const p=await eda.dmt_Project.getCurrentProjectInfo();if(d?.uuid!==${JSON.stringify(target.documentUuid)}||d?.documentType!==3||p?.uuid!==${JSON.stringify(target.projectUuid)})throw Error('PCB target changed before save');return await eda.pcb_Document.save(${JSON.stringify(target.documentUuid)});`;
 const saved=await executeBridgeCode(bridge,code);if(saved!==true)fail('EasyEDA save was not acknowledged');return true;
}

export async function saveAndCheck({target,save,runDrc=true,drcJobId=null,drcWaitMs=15000,drcPollIntervalMs=300,drcDetailOffset=0,drcDetailLimit=100,releaseDrcJob=false}){
 if(!target?.documentUuid)fail('Exact PCB target is required');
 if(drcJobId!=null&&(typeof drcJobId!=='string'||!drcJobId.trim()))fail('drcJobId must be nonempty');
 if(!Number.isSafeInteger(drcDetailOffset)||drcDetailOffset<0)fail('drcDetailOffset must be nonnegative');
 if(!Number.isSafeInteger(drcDetailLimit)||drcDetailLimit<0||drcDetailLimit>250)fail('drcDetailLimit must be 0..250');
 if(!Number.isSafeInteger(drcWaitMs)||drcWaitMs<0||drcWaitMs>45000)fail('drcWaitMs must be 0..45000');
 if(!Number.isSafeInteger(drcPollIntervalMs)||drcPollIntervalMs<100||drcPollIntervalMs>2000)fail('drcPollIntervalMs must be 100..2000');
 const resuming=drcJobId!=null,shouldSave=save??!resuming;
 if(resuming&&shouldSave)fail('DRC continuation must use save=false');
 if(!runDrc&&resuming)fail('drcJobId requires runDrc=true');
 assertAllowedTarget(target);
 const bridge=await resolveBridge({windowId:target.windowId}),status=await executeBridgeCode(bridge,statusCode(target));
 const saved=shouldSave?await saveDocument(bridge,target):null;
 if(!runDrc)return {ok:true,target,status,saved,drcState:'NOT_REQUESTED',drcVerified:false,drcErrorCount:null,drcPassed:null};
 let effectiveJobId=drcJobId??createDrcJobId();
 const readJob=()=>executeBridgeCode(bridge,buildDrcStatusCode({target,jobId:effectiveJobId,offset:drcDetailOffset,limit:drcDetailLimit,release:releaseDrcJob}),20_000);
 let initial=resuming?await readJob():await executeBridgeCode(bridge,buildDrcStartCode({target,jobId:effectiveJobId}),20_000);
 if(typeof initial?.jobId==='string'&&initial.jobId)effectiveJobId=initial.jobId;
 if(initial?.state==='COMPLETED'&&!initial.report)initial=await readJob();
 const job=await waitForDrcJob({initial,poll:readJob,waitMs:drcWaitMs,pollIntervalMs:drcPollIntervalMs});
 if(job?.state==='RUNNING')return {ok:true,target,status,saved,drcState:'RUNNING',drcJobId:effectiveJobId,drcVerified:false,nextAction:{tool:'pcb_save_and_drc',arguments:{target:target.documentUuid,save:false,runDrc:true,drcJobId:effectiveJobId,drcDetailOffset,drcDetailLimit}}};
 if(job?.state!=='COMPLETED'||job?.report?.verified!==true){const error=new Error(job?.error?.message??`Native DRC ended in ${String(job?.state??'UNKNOWN')}`);error.code=job?.error?.code??'NATIVE_DRC_UNVERIFIED';error.details={drcState:job?.state??'UNKNOWN',drcJobId:effectiveJobId,nativeError:job?.error??null,saved};throw error;}
 const report=job.report,statusAfterDrc=await executeBridgeCode(bridge,statusCode(target));
 return {ok:true,target,status,statusAfterDrc,saved,drcState:'COMPLETED',drcJobId:effectiveJobId,drcJobReleased:job.released===true,drcStartedAt:job.startedAt??null,drcCompletedAt:job.completedAt??null,drcDurationMs:job.durationMs??null,drcVerified:true,drcErrorCount:report.total,drcPassed:report.total===0,drcItems:report.items,drcItemsOffset:report.page.offset,drcItemsLimit:report.page.limit,drcItemsReturned:report.page.returned,drcItemsHasMore:report.page.hasMore,drcItemsNextOffset:job.released===true?null:report.page.nextOffset,drcDetailsComplete:report.page.detailsComplete,drcSummary:{topLevelCount:report.topLevelCount,groupCount:report.groupCount,visitedNodes:report.visitedNodes,visibleFindingCount:report.visibleFindingCount,hiddenFindingCount:report.hiddenFindingCount,countsByCategory:report.countsByCategory,countsByRule:report.countsByRule,countsByObjectType:report.countsByObjectType,countsByLayer:report.countsByLayer,countsByErrorType:report.countsByErrorType,countsByRuleType:report.countsByRuleType},rawNativeDrcOmitted:true};
}

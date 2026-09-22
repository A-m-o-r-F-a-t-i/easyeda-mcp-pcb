import crypto from 'node:crypto';
import { summarizeDrcReport } from './drc-report.mjs';

export const DRC_JOB_REGISTRY_KEY = '__easyedaPcbMcpDrcJobsV1';
export const DRC_JOB_TERMINAL_TTL_MS = 15 * 60 * 1000;
export const DRC_JOB_MAX_RUNTIME_MS = 10 * 60 * 1000;

export function createDrcJobId() {
  return crypto.randomUUID();
}

function targetLiteral(target) {
  return JSON.stringify({
    windowId: target?.windowId ?? null,
    projectUuid: target?.projectUuid ?? null,
    documentUuid: target?.documentUuid ?? null,
  });
}

function commonPrelude(target) {
  return `
const target=${targetLiteral(target)};
const documentInfo=await eda.dmt_SelectControl.getCurrentDocumentInfo();
if(documentInfo?.uuid!==target.documentUuid||documentInfo?.documentType!==3)throw new Error('PCB document/type mismatch before native DRC operation');
const projectInfo=await eda.dmt_Project.getCurrentProjectInfo();
if(target.projectUuid&&projectInfo?.uuid!==target.projectUuid)throw new Error('PCB project mismatch before native DRC operation');
const registryKey=${JSON.stringify(DRC_JOB_REGISTRY_KEY)};
const now=Date.now();
let registry=globalThis[registryKey];
if(!registry||registry.version!==1||!registry.jobs||typeof registry.jobs!=='object'){
  registry={version:1,jobs:Object.create(null)};
  globalThis[registryKey]=registry;
}
const jobs=registry.jobs;
for(const [id,job] of Object.entries(jobs)){
  if(!job||typeof job!=='object'){delete jobs[id];continue;}
  if(job.state==='RUNNING'&&now-Number(job.startedAt??0)>${DRC_JOB_MAX_RUNTIME_MS}){
    job.state='FAILED';job.completedAt=now;job.result=null;
    job.error={code:'NATIVE_DRC_JOB_TIMEOUT',message:'Native DRC job exceeded the maximum retained runtime'};
  }
  if(job.state!=='RUNNING'&&now-Number(job.completedAt??job.startedAt??0)>${DRC_JOB_TERMINAL_TTL_MS})delete jobs[id];
}
const targetKey=[target.windowId??'',target.projectUuid??'',target.documentUuid??''].join('|');
`;
}

export function buildDrcStartCode({ target, jobId }) {
  if (!jobId || typeof jobId !== 'string') throw new Error('A DRC job ID is required');
  return `${commonPrelude(target)}
const requestedJobId=${JSON.stringify(jobId)};
const describe=(job,reused)=>({
  state:job.state,jobId:job.jobId,reused,startedAt:job.startedAt,completedAt:job.completedAt??null,
  durationMs:job.completedAt?job.completedAt-job.startedAt:null,
  nativeCallStarted:job.nativeCallStarted===true,
  error:job.error??null,
});
const active=Object.values(jobs)
  .filter(job=>job&&job.targetKey===targetKey&&job.state==='RUNNING')
  .sort((a,b)=>Number(b.startedAt??0)-Number(a.startedAt??0))[0];
if(active)return describe(active,true);
const collision=jobs[requestedJobId];
if(collision){
  if(collision.targetKey!==targetKey)throw new Error('DRC job ID belongs to a different PCB target');
  return describe(collision,true);
}
const job={
  schema:'easyeda-pcb-drc-job/v1',jobId:requestedJobId,targetKey,
  target:{windowId:target.windowId,projectUuid:target.projectUuid,documentUuid:target.documentUuid},
  state:'RUNNING',startedAt:now,completedAt:null,nativeCallStarted:false,result:null,error:null,
};
jobs[requestedJobId]=job;
const beginSettlement=()=>{
  if(job.state!=='RUNNING'||jobs[requestedJobId]!==job)return false;
  job.completedAt=Date.now();
  if(job.completedAt-job.startedAt>${DRC_JOB_MAX_RUNTIME_MS}){
    job.state='FAILED';job.result=null;
    job.error={code:'NATIVE_DRC_JOB_TIMEOUT',message:'Native DRC job exceeded the maximum retained runtime'};
    return false;
  }
  return true;
};
const complete=value=>{
  if(!beginSettlement())return;
  if(!Array.isArray(value)){
    job.state='FAILED';job.result=null;
    job.error={code:'INVALID_VERBOSE_DRC_RESPONSE',message:'Native verbose DRC did not return an array',responseType:typeof value};
    return;
  }
  job.state='COMPLETED';job.result=value;job.error=null;
};
const reject=error=>{
  if(!beginSettlement())return;
  job.state='FAILED';job.result=null;
  job.error={code:'NATIVE_DRC_FAILED',message:String(error?.message??error),name:String(error?.name??'Error')};
};
if(typeof eda.pcb_Drc?.check!=='function'){
  job.state='FAILED';job.completedAt=Date.now();
  job.error={code:'NATIVE_DRC_API_UNAVAILABLE',message:'The current EasyEDA client does not expose pcb_Drc.check'};
  return describe(job,false);
}
try{
  job.nativeCallStarted=true;
  const nativeResult=eda.pcb_Drc.check(true,false,true);
  if(Array.isArray(nativeResult))complete(nativeResult);
  else if(nativeResult&&typeof nativeResult.then==='function')nativeResult.then(complete,reject);
  else complete(nativeResult);
}catch(error){reject(error);}
return describe(job,false);
`;
}

export function buildDrcStatusCode({ target, jobId, offset = 0, limit = 100, release = false }) {
  if (!jobId || typeof jobId !== 'string') throw new Error('A DRC job ID is required');
  const summarizeSource = summarizeDrcReport.toString();
  return `${commonPrelude(target)}
const requestedJobId=${JSON.stringify(jobId)};
const job=jobs[requestedJobId];
if(!job)return {state:'MISSING',jobId:requestedJobId,error:{code:'DRC_JOB_NOT_FOUND',message:'DRC job is missing, expired, or belongs to another EasyEDA window'}};
if(job.targetKey!==targetKey)return {state:'MISMATCH',jobId:requestedJobId,error:{code:'DRC_JOB_TARGET_MISMATCH',message:'DRC job belongs to a different PCB target'}};
const base={jobId:job.jobId,startedAt:job.startedAt,completedAt:job.completedAt??null,durationMs:job.completedAt?job.completedAt-job.startedAt:null,nativeCallStarted:job.nativeCallStarted===true};
if(job.state==='RUNNING')return {state:'RUNNING',...base};
if(job.state==='FAILED')return {state:'FAILED',...base,error:job.error??{code:'NATIVE_DRC_FAILED',message:'Native DRC failed without an error payload'}};
if(job.state!=='COMPLETED')return {state:'FAILED',...base,error:{code:'INVALID_DRC_JOB_STATE',message:'DRC job has an unsupported state'}};
if(!Array.isArray(job.result))return {state:'FAILED',...base,error:{code:'INVALID_VERBOSE_DRC_RESPONSE',message:'Completed DRC job has no readable native result array'}};
let report;
try{
  const summarize=(${summarizeSource});
  report=summarize(job.result,{offset:${Number(offset)},limit:${Number(limit)}});
}catch(error){
  return {state:'FAILED',...base,error:{code:'DRC_REPORT_PARSE_FAILED',message:String(error?.message??error)}};
}
const response={state:'COMPLETED',...base,report,nativeTopLevelCount:job.result.length,rawNativeReportOmitted:true,released:false};
if(${release === true}){delete jobs[requestedJobId];response.released=true;}
return response;
`;
}

export async function waitForDrcJob({ initial, poll, waitMs = 15000, pollIntervalMs = 300 }) {
  if (!initial || typeof initial !== 'object') throw new Error('Initial DRC job state is required');
  if (typeof poll !== 'function') throw new Error('DRC job poll function is required');
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 45000) throw new Error('drcWaitMs must be an integer from 0 to 45000');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 2000) throw new Error('drcPollIntervalMs must be an integer from 100 to 2000');
  let current = initial;
  if (current.state !== 'RUNNING' || waitMs === 0) return current;
  const deadline = Date.now() + waitMs;
  while (current.state === 'RUNNING') {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    current = await poll();
  }
  return current;
}

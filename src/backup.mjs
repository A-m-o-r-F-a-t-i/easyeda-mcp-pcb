import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertAllowedTarget, resolveBridge, executeBridgeCode } from './bridge.mjs';

// Export native files or the exact tab's rendered PNG. No window activation or PCB modification.
export async function nativeBackupRuntime(eda, request) {
  const guard=async()=>{
    const d=await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const p=await eda.dmt_Project.getCurrentProjectInfo();
    if(d?.uuid!==request.target.documentUuid||d?.documentType!==3||p?.uuid!==request.target.projectUuid)throw Error('Native backup target changed');
    return d;
  };
  if(!request.target?.projectUuid||!request.target?.documentUuid||!request.target?.windowId)throw Error('Native backup requires exact project/document/window');
  if(!['document','project','view'].includes(request.scope))throw Error('Unsupported native backup scope');
  if(!Number.isInteger(request.maxBytes)||request.maxBytes<1||request.maxBytes>16777216)throw Error('Invalid backup size limit');
  const document=await guard();
  const method=request.scope==='project'?'getProjectFile':'getDocumentFile';
  if(request.scope==='view'&&(!document.tabId||typeof eda.dmt_EditorControl?.getCurrentRenderedAreaImage!=='function'))throw Error('Exact-tab rendered capture API unavailable');
  if(request.scope!=='view'&&typeof eda.sys_FileManager?.[method]!=='function')throw Error('Native backup API unavailable');
  const file=request.scope==='view'?await eda.dmt_EditorControl.getCurrentRenderedAreaImage(document.tabId):await eda.sys_FileManager[method](request.fileName,undefined,'epro');
  if(!file||typeof file.arrayBuffer!=='function'||!Number.isInteger(file.size)||file.size<4)throw Error('Native export returned no readable File/Blob');
  if(file.size>request.maxBytes)throw Error('Native export exceeds maxBytes; no bytes transferred');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size)throw Error('Native File size/readback mismatch');
  const signature=request.scope==='view'?[137,80,78,71,13,10,26,10]:[80,75,3,4];
  if(signature.some((b,i)=>bytes[i]!==b))throw Error('Native export file signature mismatch');
  await guard();
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts=[];let chunk='';
  for(let i=0;i<bytes.length;i+=3){
    const a=bytes[i],b=bytes[i+1]??0,c=bytes[i+2]??0;
    chunk+=alphabet[a>>2]+alphabet[((a&3)<<4)|(b>>4)]+(i+1<bytes.length?alphabet[((b&15)<<2)|(c>>6)]:'=')+(i+2<bytes.length?alphabet[c&63]:'=');
    if(chunk.length>=32768){parts.push(chunk);chunk='';}
  }
  if(chunk)parts.push(chunk);
  return {name:file.name??null,size:bytes.length,scope:request.scope,encoding:'base64',data:parts.join(''),nativeFormat:request.scope==='view'?'png':'epro',tabId:document.tabId};
}

export function decodeBackup(payload,maxBytes,format='epro'){
  if(payload?.encoding!=='base64'||typeof payload.data!=='string'||!Number.isInteger(payload.size)||payload.size<4||payload.size>maxBytes)throw Error('Invalid native backup response');
  if(payload.data.length!==4*Math.ceil(payload.size/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data))throw Error('Invalid backup base64 length/encoding');
  const bytes=Buffer.from(payload.data,'base64');
  if(bytes.length!==payload.size||bytes.toString('base64')!==payload.data)throw Error('Backup transfer size/canonical encoding mismatch');
  if(!['epro','png'].includes(format))throw Error('Unsupported export format');
  const signature=Buffer.from(format==='png'?[137,80,78,71,13,10,26,10]:[80,75,3,4]);
  if(!bytes.subarray(0,signature.length).equals(signature))throw Error('Backup ZIP/PNG signature mismatch');
  return bytes;
}

async function exportNativeBinary({target,outputPath,scope='project',maxBytes=8388608,bridgeUrl}){
  assertAllowedTarget(target);
  if(!target?.projectUuid||!target?.windowId)throw Error('Exact project/window required for binary export');
  const format=scope==='view'?'png':'epro';
  if(typeof outputPath!=='string'||!path.isAbsolute(outputPath)||path.extname(outputPath).toLowerCase()!=='.'+format)throw Error('outputPath must be an absolute .'+format+' filename');
  if(!Number.isInteger(maxBytes)||maxBytes<4||maxBytes>16777216)throw Error('maxBytes must be 4..16777216');
  if(!['project','document','view'].includes(scope))throw Error('Unsupported binary export scope');
  const parent=await fs.lstat(path.dirname(outputPath));
  if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('Export parent must be an existing regular directory');
  try{await fs.lstat(outputPath);throw Error('Export destination already exists; overwrite is not supported');}catch(error){if(error.code!=='ENOENT')throw error;}
  const bridge=await resolveBridge({bridgeUrl,windowId:target.windowId});
  const request={target,scope,maxBytes,fileName:path.basename(outputPath,'.'+format)};
  const payload=await executeBridgeCode(bridge,`return await (${nativeBackupRuntime.toString()})(eda,${JSON.stringify(request)});`,120000);
  const bytes=decodeBackup(payload,maxBytes,format);
  const handle=await fs.open(outputPath,'wx');
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  const persisted=await fs.readFile(outputPath);
  const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
  if(sha256(persisted)!==sha256(bytes))throw Error('Local export readback mismatch');
  return {ok:true,path:outputPath,size:bytes.length,sha256:sha256(bytes),scope,nativeFormat:format,tabId:payload.tabId??null,experimental:scope==='view',verifiedTransfer:true,overwritten:false,limitations:scope==='view'?['BETA API; captures only the exact tab rendered viewport, not manufacturing output, 3D or hidden layers.','This call does not activate windows, change zoom, layer visibility or editor selection.']:['Export contains native project/document data at export time. Unsaved forms and concurrent edits are not transactionally locked.','ZIP signature, byte length and local readback are checked; restoration into the editor is a separate verification.']};
}

export async function exportNativeBackup(request){
  if(request.scope!==undefined&&!['project','document'].includes(request.scope))throw Error('scope must be project or document');
  return exportNativeBinary(request);
}
export async function captureView(request){return exportNativeBinary({...request,scope:'view'});}

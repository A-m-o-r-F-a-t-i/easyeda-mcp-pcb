import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {exportNativeBackup} from './backup.mjs';
import {exportManufacturingFile} from './manufacturing.mjs';
import {parseDsnScene} from './dsn.mjs';
import {assertAllowedTarget,executeBridgeCode,resolveBridge} from './bridge.mjs';

const MANUFACTURING={gerber:'gerber',bom:'bom',pick_place:'pickAndPlace',test_point:'testPoints',netlist:'netlist',ipc_d_356a:'ipcD356A'};
const toolError=(code,message,details={})=>Object.assign(new Error(message),{code,details});
const hashBytes=value=>crypto.createHash('sha256').update(value).digest('hex');

export async function assertNewLocalPath(outputPath){
 if(typeof outputPath!=='string'||!path.isAbsolute(outputPath)||/^\\\\/.test(outputPath)||outputPath.includes('\0'))throw toolError('INVALID_REQUEST','Export requires an absolute local path');
 const absolute=path.resolve(outputPath),basename=path.basename(absolute);
 if(!basename||/[<>:"|?*]/.test(basename)||/[. ]$/.test(basename)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename))throw toolError('INVALID_REQUEST','Unsafe or reserved export filename');
 let current=path.dirname(absolute);while(true){const info=await fs.lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw toolError('INVALID_REQUEST','Export parent must be an existing non-symlink directory');const parent=path.dirname(current);if(parent===current)break;current=parent;}
 try{await fs.lstat(absolute);throw toolError('OUTPUT_EXISTS','Export refuses to overwrite an existing file');}catch(error){if(error.code!=='ENOENT')throw error;}
 return absolute;
}

export async function createAtomicExport(outputPath,producer,{maximumBytes=16777216}={}){
 const absolute=await assertNewLocalPath(outputPath),temporaryDirectory=await fs.mkdtemp(path.join(path.dirname(absolute),'.pcb-export-')),temporary=path.join(temporaryDirectory,path.basename(absolute));let linked=false;
 try{
  const detail=await producer(temporary),stat=await fs.lstat(temporary);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>maximumBytes)throw toolError('FILE_TOO_LARGE','Invalid export file size or type');
  const bytes=await fs.readFile(temporary);if(bytes.length!==stat.size)throw toolError('TRANSFER_HASH_MISMATCH','Temporary file changed during readback');
  const handle=await fs.open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
  await fs.link(temporary,absolute);linked=true;const readback=await fs.readFile(absolute);if(!bytes.equals(readback))throw toolError('TRANSFER_HASH_MISMATCH','Final export readback differs');
  return {...detail,outputPath:absolute,byteLength:bytes.length,sha256:hashBytes(bytes),atomicFinalization:true,documentWritten:false};
 }catch(error){if(linked){const a=await fs.lstat(absolute).catch(()=>null),b=await fs.lstat(temporary).catch(()=>null);if(a&&b&&a.ino===b.ino&&a.dev===b.dev)await fs.unlink(absolute).catch(()=>{});}if(error.code==='EEXIST')throw toolError('OUTPUT_EXISTS','Another process created the destination');throw error;}
 finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});await fs.rmdir(temporaryDirectory).catch(error=>{if(!['ENOENT','ENOTEMPTY'].includes(error.code))throw error;});}
}

export async function nativeDsnRuntime(eda,request){
 const guard=async()=>{const document=await eda.dmt_SelectControl.getCurrentDocumentInfo(),project=await eda.dmt_Project.getCurrentProjectInfo();if(document?.uuid!==request.target.documentUuid||document?.documentType!==3||project?.uuid!==request.target.projectUuid)throw Error('PCB target changed during DSN export');};
 await guard();if(typeof eda.pcb_ManufactureData?.getDsnFile!=='function')throw Error('Native DSN export unavailable');
 const file=await eda.pcb_ManufactureData.getDsnFile('PCB_Inspection');if(!file||typeof file.arrayBuffer!=='function'||!Number.isInteger(file.size)||file.size<1||file.size>request.maxBytes)throw Error('Invalid or oversized DSN File');
 const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length!==file.size)throw Error('DSN File length changed');await guard();
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';const parts=[];let chunk='';for(let i=0;i<bytes.length;i+=3){const a=bytes[i],b=bytes[i+1]??0,c=bytes[i+2]??0;chunk+=alphabet[a>>2]+alphabet[((a&3)<<4)|(b>>4)]+(i+1<bytes.length?alphabet[((b&15)<<2)|(c>>6)]:'=')+(i+2<bytes.length?alphabet[c&63]:'=');if(chunk.length>=32768){parts.push(chunk);chunk='';}}if(chunk)parts.push(chunk);
 return {encoding:'base64',size:bytes.length,data:parts.join(''),name:file.name??null};
}

function decodeDsn(payload,maxBytes){
 if(payload?.encoding!=='base64'||typeof payload.data!=='string'||!Number.isInteger(payload.size)||payload.size<1||payload.size>maxBytes)throw toolError('TRANSFER_HASH_MISMATCH','Invalid DSN transfer envelope');
 const bytes=Buffer.from(payload.data,'base64');if(bytes.length!==payload.size||bytes.toString('base64')!==payload.data)throw toolError('TRANSFER_HASH_MISMATCH','DSN transfer size or encoding mismatch');
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(!/^\uFEFF?\s*\(\s*PCB\b/i.test(text))throw toolError('METHOD_FAILED','Native File lacks a PCB DSN header');return {bytes,text};
}

export async function exportPcb(request){
 const {target,kind,outputPath,maxBytes=8388608,scope='project',parseScene=true,format,netlistType}=request;
 if(!['backup','dsn',...Object.keys(MANUFACTURING)].includes(kind))throw toolError('INVALID_REQUEST','Unknown export kind');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<4||maxBytes>16777216)throw toolError('INVALID_REQUEST','Export byte limit must be 4..16777216');
 if(kind==='backup'&&path.extname(outputPath).toLowerCase()!=='.epro')throw toolError('INVALID_REQUEST','Native backup requires .epro');
 if(kind==='dsn'&&path.extname(outputPath).toLowerCase()!=='.dsn')throw toolError('INVALID_REQUEST','DSN export requires .dsn');
 return createAtomicExport(outputPath,async temporary=>{
  if(kind==='backup'){await exportNativeBackup({target,outputPath:temporary,scope,maxBytes});return {ok:true,kind,scope,target};}
  if(kind==='dsn'){
   assertAllowedTarget(target);const bridge=await resolveBridge({windowId:target.windowId}),payload=await executeBridgeCode(bridge,`return await (${nativeDsnRuntime.toString()})(eda,${JSON.stringify({target,maxBytes})});`,180000),file=decodeDsn(payload,maxBytes),scene=parseScene?parseDsnScene(file.text):null;
   await fs.writeFile(temporary,file.bytes,{flag:'wx'});return {ok:true,kind,target,units:'mil',scene:scene?{...scene.summary,units:'mil',sourceUnits:scene.sourceUnits,resolution:scene.resolution,coordinateFrame:scene.coordinateFrame,coverage:{...scene.coverage,warnings:scene.coverage.warnings.slice(0,20)}}:null};
  }
  await exportManufacturingFile({target,kind:MANUFACTURING[kind],outputPath:temporary,format,netlistType,maxBytes});
  return {ok:true,kind,target,format:format??null,unit:kind==='pick_place'?'mil':null,netlistType:netlistType??null};
 },{maximumBytes:maxBytes});
}

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAtomicExport,assertNewLocalPath} from '../src/export.mjs';
import {decodeManufacturingFile,normalizeExportRequest} from '../src/manufacturing.mjs';
import {decodeBackup} from '../src/backup.mjs';

test('atomic export creates a new verified file and refuses overwrite',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-export-v4-')),output=path.join(directory,'result.net'),bytes=Buffer.from('MIL EXPORT\n','utf8');
 try{
  const result=await createAtomicExport(output,async temporary=>{await fs.writeFile(temporary,bytes,{flag:'wx'});return {ok:true,kind:'netlist'};});
  assert.equal(result.byteLength,bytes.length);assert.equal(result.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(await fs.readFile(output),bytes);assert.equal(result.atomicFinalization,true);assert.equal(result.documentWritten,false);
  await assert.rejects(assertNewLocalPath(output),error=>error.code==='OUTPUT_EXISTS');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('pick-and-place export is fixed to MIL and exposes no metric selector',()=>{
 const xlsx=normalizeExportRequest({kind:'pickAndPlace'}),csv=normalizeExportRequest({kind:'pickAndPlace',format:'csv'});assert.equal(xlsx.unit,'mil');assert.equal(xlsx.extension,'.xlsx');assert.equal(csv.unit,'mil');assert.equal(csv.extension,'.csv');assert.equal(normalizeExportRequest({kind:'bom'}).unit,null);
});

test('manufacturing transfer validates canonical bytes and archive signatures',()=>{
 const zip=Buffer.from([80,75,3,4,1,2,3,4]),payload={encoding:'base64',size:zip.length,data:zip.toString('base64')};assert.deepEqual(decodeManufacturingFile(payload,1024,true),zip);
 const text=Buffer.from('NETLIST DATA','utf8'),textPayload={encoding:'base64',size:text.length,data:text.toString('base64')};assert.deepEqual(decodeManufacturingFile(textPayload,1024,false),text);assert.throws(()=>decodeManufacturingFile(textPayload,1024,true),/signature/);
});

test('native backup decoder accepts only EPRO ZIP bytes',()=>{
 const bytes=Buffer.from([80,75,3,4,10,20,30]),payload={encoding:'base64',size:bytes.length,data:bytes.toString('base64')};assert.deepEqual(decodeBackup(payload,1024),bytes);assert.throws(()=>decodeBackup({...payload,data:Buffer.from('bad').toString('base64'),size:3},1024));
});

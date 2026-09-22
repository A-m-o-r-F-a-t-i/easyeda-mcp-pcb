import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {nativeBackupRuntime,decodeBackup,exportNativeBackup,captureView} from '../src/backup.mjs';
import {constraintRuntime} from '../src/constraint-runtime.mjs';
import {validateTextPlan} from '../src/text-plan.mjs';
const target={documentUuid:'test-pcb',projectUuid:'test-project',windowId:'test-window'};
const doc={uuid:target.documentUuid,documentType:3,tabId:'explicit-test-tab'};
const base=()=>({dmt_SelectControl:{getCurrentDocumentInfo:async()=>doc},dmt_Project:{getCurrentProjectInfo:async()=>({uuid:target.projectUuid})}});
function constraints(version='3.2.186'){
 const groups=[];let colorSent;let writes=0;
 const eda={...base(),sys_Environment:{getEditorCurrentVersion:async()=>version},pcb_Drc:{getAllNetClasses:async()=>groups,createNetClass:async(name,nets,color)=>{writes++;colorSent=color;groups.push({name,nets,color:color===null?null:{...color,alpha:version==='3.2.186'?color.alpha/255:color.alpha}});return true;}}};
 return {eda,sent:()=>colorSent,writes:()=>writes};
}
const create=c=>({target,kind:'manage',operation:{action:'create',groupType:'netClass',name:'TEST',expected:null,definition:{nets:['GND'],color:c}}});
test('L01 client 3.2.186 alpha becomes a byte but readback stays normalized',async()=>{
 const f=constraints();const r=await constraintRuntime(f.eda,create({r:30,g:100,b:200,alpha:1}));assert.equal(f.sent().alpha,255);assert.equal(r.after.color.alpha,1);
});
test('L02 fractional alpha is quantized consistently for idempotent replay',async()=>{
 const f=constraints();const request=create({r:1,g:2,b:3,alpha:0.5});const first=await constraintRuntime(f.eda,request);assert.equal(first.after.color.alpha,128/255);assert.equal((await constraintRuntime(f.eda,request)).status,'already_exists');assert.equal(f.writes(),1);
});
test('L03 unknown client versions do not silently adopt the pinned adapter',async()=>{
 const f=constraints('3.2.test');await constraintRuntime(f.eda,create({r:1,g:2,b:3,alpha:0.5}));assert.equal(f.sent().alpha,0.5);
});
test('L04 explicitly null constraint colors round-trip',async()=>{
 const f=constraints();const r=await constraintRuntime(f.eda,create(null));assert.equal(f.sent(),null);assert.equal(r.after.color,null);
});
test('L04b client-assigned default color is accepted when null requests the native default',async()=>{
 const groups=[];let writes=0;const nativeDefault={r:35,g:120,b:90,alpha:1};
 const eda={...base(),sys_Environment:{getEditorCurrentVersion:async()=> '3.2.186'},pcb_Drc:{getAllNetClasses:async()=>structuredClone(groups),createNetClass:async(name,nets,color)=>{writes++;assert.equal(color,null);groups.push({name,nets,color:nativeDefault});return true;}}};
 const request=create(null);const first=await constraintRuntime(eda,request);assert.deepEqual(first.after.color,nativeDefault);assert.equal((await constraintRuntime(eda,request)).status,'already_exists');assert.equal(writes,1);
});
function padFixture(){
 const groups=[];let writes=0;const eda={...base(),pcb_PrimitiveComponent:{getAll:async()=>[{primitiveId:'c1',designator:'R1'}],getAllPinsByPrimitiveId:async()=>[{primitiveId:'c1p1',padNumber:'1'},{primitiveId:'c1p2',padNumber:'2'}]},pcb_PrimitivePad:{getAll:async()=>[{primitiveId:'free-pad'}]},pcb_Drc:{getAllPadPairGroups:async()=>groups,createPadPairGroup:async(name,padPairs)=>{writes++;groups.push({name,padPairs});return true;}}};return {eda,writes:()=>writes};
}
const padRequest=padPairs=>({target,kind:'manage',operation:{action:'create',groupType:'padPairGroup',name:'TEST',expected:null,definition:{padPairs}}});
test('L05 component pads use Designator:PadNumber and standalone pads keep IDs',async()=>{const f=padFixture();assert.equal((await constraintRuntime(f.eda,padRequest([['R1:1','free-pad'],['R1:1','R1:2']]))).verified,true)});
test('L06 internal component pad IDs are rejected before native writes',async()=>{const f=padFixture();await assert.rejects(constraintRuntime(f.eda,padRequest([['c1p1','c1p2']])),/Designator:PadNumber/);assert.equal(f.writes(),0)});
test('L07 missing component pin number is rejected before native writes',async()=>{const f=padFixture();await assert.rejects(constraintRuntime(f.eda,padRequest([['R1:1','R1:99']])),/Unknown or ambiguous/);assert.equal(f.writes(),0)});
const attribute={parentPrimitiveId:'c1',layer:3,x:0,y:0,key:'Designator',value:'R1',keyVisible:false,valueVisible:false,fontFamily:'default',fontSize:45,lineWidth:6,alignMode:3,rotation:4050.0000000000005,reverse:false,expansion:0,mirror:false,primitiveLock:false};
const textPlan=set=>({schema:'easyeda-pcb-text-plan/v1',intent:'Attribute display test',target,units:'mil',operations:[{id:'a',type:'attribute.modify',primitiveId:'a1',expected:attribute,set}]});
test('L08 existing rotations beyond 3600 degrees remain valid expected state',()=>assert.doesNotThrow(()=>validateTextPlan(textPlan({valueVisible:true}))));
test('L09 arbitrary new over-limit rotations and non-finite old state still reject',()=>{assert.throws(()=>validateTextPlan(textPlan({rotation:4050})),/rotation/);const p=textPlan({valueVisible:true});p.operations[0].expected={...attribute,rotation:NaN};assert.throws(()=>validateTextPlan(p),/finite/)});
function binaryFixture(bytes){let requestedTab;let reads=0;const file={name:'test.epro',size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer};const eda={...base(),sys_FileManager:{getProjectFile:async()=>{reads++;return file},getDocumentFile:async()=>file},dmt_EditorControl:{getCurrentRenderedAreaImage:async tab=>{requestedTab=tab;return file}}};return {eda,reads:()=>reads,tab:()=>requestedTab,file};}
const zip=Uint8Array.from([80,75,3,4,11,22,33,44,55]);const png=Uint8Array.from([137,80,78,71,13,10,26,10,1]);
const binaryRequest=(scope='project',maxBytes=100)=>({target,scope,maxBytes,fileName:'test'});
test('L10 native export base64 round-trip preserves each byte',async()=>{const f=binaryFixture(zip);const r=await nativeBackupRuntime(f.eda,binaryRequest());assert.deepEqual(decodeBackup(r,100),Buffer.from(zip))});
test('L11 PNG capture passes the exact tab ID without activating a window',async()=>{const f=binaryFixture(png);const r=await nativeBackupRuntime(f.eda,binaryRequest('view'));assert.equal(f.tab(),'explicit-test-tab');assert.deepEqual(decodeBackup(r,100,'png'),Buffer.from(png))});
test('L12 native oversized File is rejected before binary transfer',async()=>{const f=binaryFixture(zip);let read=0;f.file.arrayBuffer=async()=>{read++;return zip.buffer};await assert.rejects(nativeBackupRuntime(f.eda,binaryRequest('project',8)),/exceeds/);assert.equal(read,0)});
test('L13 native permission denial remains visible and no fallback is called',async()=>{const f=binaryFixture(zip);f.eda.sys_FileManager.getProjectFile=async()=>{throw Error('Permission denied')};await assert.rejects(nativeBackupRuntime(f.eda,binaryRequest()),/Permission denied/)});
test('L14 target drift rejects the export before returning bytes',async()=>{const f=binaryFixture(zip);let n=0;f.eda.dmt_SelectControl.getCurrentDocumentInfo=async()=>++n===1?doc:{...doc,uuid:'other'};await assert.rejects(nativeBackupRuntime(f.eda,binaryRequest()),/target changed/)});
test('L15 corrupted length, signature and noncanonical base64 are rejected',()=>{assert.throws(()=>decodeBackup({encoding:'base64',size:9,data:'!!!!'},100),/base64/);assert.throws(()=>decodeBackup({encoding:'base64',size:4,data:'AAAAAAAA'},100),/size|encoding|base64/);assert.throws(()=>decodeBackup({encoding:'base64',size:4,data:'AAAAAA=='},100),/signature/)});
test('L16 existing destinations cannot be overwritten and do not reach the Bridge',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-backup-test-'));const file=path.join(dir,'existing.epro');await fs.writeFile(file,'preserve');try{await assert.rejects(exportNativeBackup({target,outputPath:file}),/already exists/);assert.equal(await fs.readFile(file,'utf8'),'preserve')}finally{await fs.rm(dir,{recursive:true})}});
test('L17 export rejects relative paths and incorrect file extensions',async()=>{await assert.rejects(exportNativeBackup({target,outputPath:'backup.epro'}),/absolute/);await assert.rejects(captureView({target,outputPath:path.resolve('wrong.epro')}),/\.png/)});
test('L18 serialized backup runtime remains self-contained',()=>{const fn=new Function('eda','r',`return (${nativeBackupRuntime.toString()})(eda,r)`);assert.equal(typeof fn,'function');assert.doesNotMatch(nativeBackupRuntime.toString(),/node:|Buffer\.from|process\./)});

function memberFixture(){const f=constraints();let calls=0;f.eda.pcb_Drc.addNetToNetClass=async(name,nets)=>{calls++;const g=(await f.eda.pcb_Drc.getAllNetClasses()).find(x=>x.name===name);g.nets=[...new Set([...g.nets,...nets])];g.color={r:0,g:0,b:0,alpha:1};return true;};return {...f,calls:()=>calls};}
test('L19 known member-edit color loss refuses before write by default',async()=>{const f=memberFixture();const created=await constraintRuntime(f.eda,create({r:10,g:20,b:30,alpha:1}));await assert.rejects(constraintRuntime(f.eda,{target,kind:'manage',operation:{action:'addMembers',groupType:'netClass',name:'TEST',members:['5V'],expected:created.after}}),/resets group color/);assert.equal(f.calls(),0)});
test('L20 explicitly accepted native color reset is verified along with members',async()=>{const f=memberFixture();const created=await constraintRuntime(f.eda,create({r:10,g:20,b:30,alpha:1}));const r=await constraintRuntime(f.eda,{target,kind:'manage',operation:{action:'addMembers',groupType:'netClass',name:'TEST',members:['5V'],expected:created.after,allowColorReset:true}});assert.equal(r.verified,true);assert.deepEqual(r.after.color,{r:0,g:0,b:0,alpha:1});assert.deepEqual(r.after.nets,['5V','GND'])});

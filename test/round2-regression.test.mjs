import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntime, batchRuntime } from '../src/runtime.mjs';
import { textBatchRuntime } from '../src/text-runtime.mjs';
import { validateTextPlan } from '../src/text-plan.mjs';
import { pcbToolsRuntime } from '../src/pcb-tools-runtime.mjs';
import { compareSnapshots } from '../src/inspection.mjs';
import { saveAndCheck } from '../src/bridge.mjs';
const target={documentUuid:'test-pcb',projectUuid:'test-project',windowId:'test-window'};
const doc={uuid:target.documentUuid,documentType:3,parentProjectUuid:target.projectUuid};
const base=()=>({dmt_SelectControl:{getCurrentDocumentInfo:async()=>doc},dmt_Project:{getCurrentProjectInfo:async()=>({uuid:target.projectUuid})}});
const text={layer:3,x:10,y:20,text:'TEST',fontFamily:'default',fontSize:48,lineWidth:7,alignMode:5,rotation:0,reverse:false,expansion:0,mirror:false,primitiveLock:false};
test('R201 missing component-pin read must not become an empty valid array',async()=>{const e={...base(),pcb_PrimitiveComponent:{getAllPinsByPrimitiveId:async()=>undefined}};await assert.rejects(readRuntime(e,{target,kind:'pins',ids:['c1']}),/unavailable|invalid/i)});
test('R202 getAll undefined must not masquerade as an empty PCB',async()=>{const e={...base(),pcb_PrimitiveLine:{getAll:async()=>undefined}};await assert.rejects(readRuntime(e,{target,kind:'lines'}),/unavailable|invalid/i)});
test('R203 failed text enumeration prevents duplicate creation',async()=>{let writes=0;const e={...base(),pcb_PrimitiveString:{getAll:async()=>undefined,create:async()=>{writes++;return null}}};const r=await textBatchRuntime(e,{target,operations:[{id:'x',kind:'string',type:'string.create',state:text}]});assert.equal(r.ok,false);assert.equal(writes,0)});
test('R204 same-window human text edit during preflight is not overwritten',async()=>{let guards=0,writes=0;let current={primitiveId:'s1',...text};const e=base();e.dmt_SelectControl.getCurrentDocumentInfo=async()=>{if(++guards===2)current={...current,x:99};return doc};e.pcb_PrimitiveString={get:async()=>({...current}),modify:async(id,set)=>{writes++;current={...current,...set};return current}};const r=await textBatchRuntime(e,{target,operations:[{id:'x',kind:'string',type:'string.modify',primitiveId:'s1',expected:text,set:{text:'NEW'}}]});assert.equal(r.ok,false);assert.equal(writes,0);assert.equal(current.text,'TEST')});
test('R205 component position edit during pin preflight prevents stale move',async()=>{let writes=0;const expected={x:0,y:0,rotation:0,layer:1,primitiveLock:false};let current={primitiveId:'c1',...expected};const e=base();e.pcb_PrimitiveComponent={get:async()=>({...current}),getAllPinsByPrimitiveId:async()=>{current={...current,x:99};return [{padNumber:'1',net:'GND'}]},modify:async(id,set)=>{writes++;current={...current,...set};return current}};const r=await batchRuntime(e,{target,operations:[{id:'x',kind:'component',type:'component.modify',primitiveId:'c1',expected,set:{x:10},copperPolicy:'replan',affectedNets:['GND']}]});assert.equal(r.ok,false);assert.equal(writes,0);assert.equal(current.x,99)});
test('R206 text plan cannot rename electrical Designator identity',()=>{const {text:unused,...format}=text;const expected={...format,parentPrimitiveId:'c1',key:'Designator',value:'R1',keyVisible:false,valueVisible:true};assert.throws(()=>validateTextPlan({schema:'easyeda-pcb-text-plan/v1',intent:'Display labels',target,units:'mil',operations:[{id:'a',type:'attribute.modify',primitiveId:'a1',expected,set:{value:'UART'}}]}),/identity|semantic|Designator/i)});
test('R207 unacknowledged static repour retains every target as unverified',async()=>{const e={...base(),pcb_PrimitivePour:{getAll:async()=>[{primitiveId:'p1'}],rebuildCopperRegions:async()=>undefined},pcb_PrimitivePoured:{getAll:async()=>[{primitiveId:'f1',pourPrimitiveId:'p1',pourFills:[[]]}]}};const r=await pcbToolsRuntime(e,{target,kind:'rebuildPours'});assert.deepEqual(r.unverifiedRebuildIds,['p1'])});
test('R208 attribute identity changes are not classified as purely visual',()=>{const b={document:doc,units:'mil',attributes:[{primitiveId:'a1',parentPrimitiveId:'c1',key:'Designator',value:'R1'}]};const a=structuredClone(b);a.attributes[0].value='UART';const r=compareSnapshots(b,a);assert.equal(r.sensitiveAttributeChangeCount,1)});
test('R209 missing metadata coverage remains explicit',()=>{const s={document:doc,units:'mil',lines:[]};const r=compareSnapshots(s,s);assert.deepEqual(r.missingData,['netlist','layers','constraints'])});
test('R210 invalid verbose DRC response cannot return verified zero errors',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  let body;
  if(String(url).endsWith('/health'))body={service:'easyeda-bridge',edaConnected:true};
  else if(String(url).endsWith('/eda-windows'))body={windows:[{windowId:target.windowId,connected:true}]};
  else{
   const code=JSON.parse(options.body).code;
   const invalid=code.includes('const nativeResult=eda.pcb_Drc.check');
   body={success:true,windowId:target.windowId,result:invalid?{state:'FAILED',jobId:'bad-job',nativeCallStarted:true,error:{code:'INVALID_VERBOSE_DRC_RESPONSE',message:'Native verbose DRC did not return an array'}}:{document:doc}};
  }
  return new Response(JSON.stringify(body));
 };
 try{await assert.rejects(saveAndCheck({target,bridgeUrl:'http://127.0.0.1:49620',save:false}),/DRC.*array|invalid.*DRC/i)}
 finally{globalThis.fetch=original}
});

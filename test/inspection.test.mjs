import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedTarget } from '../src/bridge.mjs';
import { compareSnapshots, inspectSilkscreenRuntime, listTargets, openTargetRuntime } from '../src/inspection.mjs';
import { pcbToolsRuntime } from '../src/pcb-tools-runtime.mjs';

const target={documentUuid:'pcb-lab',projectUuid:'project-lab',windowId:'window-lab'};
const project={uuid:target.projectUuid,friendlyName:'Lab',data:[{name:'B',pcb:{uuid:target.documentUuid,name:'PCB1'},schematic:{uuid:'sch-lab',page:[]}}]};
function fixture(){
 let doc=null,opens=0;
 const eda={dmt_Project:{getCurrentProjectInfo:async()=>structuredClone(project)},dmt_SelectControl:{getCurrentDocumentInfo:async()=>doc},dmt_EditorControl:{openDocument:async uuid=>{opens++;doc={uuid,documentType:3,parentProjectUuid:target.projectUuid};return 'tab-lab'}}};
 return {eda,setDoc:d=>{doc=d},opens:()=>opens};
}
test('N01 open existing PCB with exact null baseline and verify its identity',async()=>{
 const f=fixture();const r=await openTargetRuntime(f.eda,{target,expectedCurrentDocumentUuid:null});assert.equal(r.status,'opened');assert.equal(f.opens(),1);assert.equal(r.document.uuid,target.documentUuid);
});
test('N02 open refuses a project mismatch without selecting another project',async()=>{
 const f=fixture();await assert.rejects(openTargetRuntime(f.eda,{target:{...target,projectUuid:'other'},expectedCurrentDocumentUuid:null}),/Project mismatch/);assert.equal(f.opens(),0);
});
test('N03 open refuses a stale current-document expectation',async()=>{
 const f=fixture();f.setDoc({uuid:'human-tab',documentType:1});await assert.rejects(openTargetRuntime(f.eda,{target,expectedCurrentDocumentUuid:null}),/changed before open/);assert.equal(f.opens(),0);
});
test('N04 target discovery addresses windows explicitly and never selects one',async()=>{
 const original=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,options={})=>{
  requests.push(String(url));let body;
  if(String(url).endsWith('/health'))body={service:'easyeda-bridge',edaConnected:true,edaWindowCount:2,activeWindowId:'production-window'};
  else if(String(url).endsWith('/eda-windows'))body={activeWindowId:'production-window',windows:[{windowId:'production-window',connected:true},{windowId:target.windowId,connected:true}]};
  else if(String(url).endsWith('/execute')){const req=JSON.parse(options.body);assert.ok(req.windowId);assert.doesNotMatch(req.code,/pcb_Primitive|activateDocument|openDocument/);body={success:true,windowId:req.windowId,result:{project:{uuid:req.windowId===target.windowId?target.projectUuid:'production'},document:null,boards:[]}};}
  else throw Error('Unexpected request '+url);
  return new Response(JSON.stringify(body));
 };
 try{const r=await listTargets({bridgeUrl:'http://127.0.0.1:49620',projectUuid:target.projectUuid});assert.equal(r.items.length,1);assert.equal(r.filteredOutWindowCount,1);assert.equal(r.activeWindowId,'production-window');assert.equal(requests.some(x=>x.endsWith('/select')),false);}finally{globalThis.fetch=original;}
});
test('N05 configured allowlist fails closed without exact project and window',()=>{
 const old=process.env.EASYEDA_ALLOWED_PROJECT_UUIDS;
 try{process.env.EASYEDA_ALLOWED_PROJECT_UUIDS=JSON.stringify([target.projectUuid]);assert.doesNotThrow(()=>assertAllowedTarget(target));assert.throws(()=>assertAllowedTarget({...target,projectUuid:'production'}),/scope/);assert.throws(()=>assertAllowedTarget({documentUuid:'pcb-lab'}),/scope/);assert.throws(()=>assertAllowedTarget(),/scope/);process.env.EASYEDA_ALLOWED_PROJECT_UUIDS='bad-json';assert.throws(()=>assertAllowedTarget(target),/JSON/);}finally{if(old===undefined)delete process.env.EASYEDA_ALLOWED_PROJECT_UUIDS;else process.env.EASYEDA_ALLOWED_PROJECT_UUIDS=old;}
});
const snap=()=>({units:'mil',document:{uuid:'pcb-lab',parentProjectUuid:'project-lab'},components:[{primitiveId:'u1',x:1,y:2}],pads:[],lines:[{primitiveId:'l1',net:'GND',startX:1,endX:20,lineWidth:8}],vias:[],strings:[{primitiveId:'s1',text:'OLD',x:20}],attributes:[]});
test('N06 diff reports exact old/new fields and preserves caller snapshots',()=>{
 const before=snap(),after=structuredClone(before);after.strings[0].text='NEW';const saved=structuredClone(before);const r=compareSnapshots(before,after);assert.equal(r.changeCount,1);assert.deepEqual(r.nonTextChanged,[]);assert.deepEqual(r.details[0].fields[0],{field:'text',before:'OLD',after:'NEW',beforePresent:true,afterPresent:true});assert.deepEqual(before,saved);
});
test('N07 diff identifies unintended copper edits during text-only work',()=>{
 const b=snap(),a=snap();a.lines[0].net='POWER';const r=compareSnapshots(b,a);assert.deepEqual(r.nonTextChanged,['lines']);assert.equal(r.engineeringRelease,'NOT_EVALUATED');assert.ok(r.missingKinds.includes('poured'));
});
test('N08 incomplete, foreign-unit, foreign-document and duplicate-ID snapshots reject',()=>{
 const b=snap(),a=snap();a.components.push({...a.components[0]});assert.throws(()=>compareSnapshots(b,a),/duplicate/);assert.throws(()=>compareSnapshots(b,{...b,units:'mm'}),/units/);assert.throws(()=>compareSnapshots(b,{...b,document:{uuid:'other'}}),/UUID/);assert.throws(()=>compareSnapshots(b,{...b,coverage:{complete:false}}),/Incomplete/);assert.throws(()=>compareSnapshots(b,{...b,lines:{items:[]}}),/complete array/);
});
test('N09 diff counts all changes when details are truncated and ignores key order',()=>{
 const b=snap(),a=snap();a.components[0]={y:2,x:1,primitiveId:'u1'};assert.equal(compareSnapshots(b,a).unchangedWithinComparedScope,true);a.lines=[];a.strings=[];const r=compareSnapshots(b,a,{detailLimit:0});assert.equal(r.changeCount,2);assert.deepEqual(r.details,[]);assert.equal(r.truncated,true);
});
function textFixture(){const f=fixture();f.setDoc({uuid:target.documentUuid,documentType:3});f.eda.pcb_PrimitiveString={getAll:async()=>[]};f.eda.pcb_PrimitiveAttribute={getAll:async()=>[{primitiveId:'a1',parentPrimitiveId:'u1',key:'Designator',value:'U1',layer:3,fontSize:20,lineWidth:5,keyVisible:false,valueVisible:true},{primitiveId:'a2',parentPrimitiveId:'u2',key:'Value',value:'MCU',layer:3,fontSize:20,lineWidth:5,keyVisible:false,valueVisible:false}]};f.eda.pcb_Primitive={getPrimitivesBBox:async()=>({minX:0,maxX:30,minY:0,maxY:20})};return f;}
test('N10 strings empty still inspects visible and hidden component attributes',async()=>{
 const f=textFixture(),r=await inspectSilkscreenRuntime(f.eda,{target});assert.equal(r.total,2);assert.equal(r.items[0].fontSizeMm,0.508);assert.ok(r.items[0].warnings.includes('NOMINAL_FONT_BELOW_DESIGN_TARGET'));assert.equal(r.items[1].visibility,'hidden-attribute');assert.deepEqual(r.items[1].warnings,[]);assert.deepEqual(r.sameLayerBBoxOverlaps,[]);
});
test('N11 unavailable graphics bounds stay unknown, never pass clearance',async()=>{
 const f=textFixture();f.eda.pcb_Primitive.getPrimitivesBBox=async()=>undefined;const r=await inspectSilkscreenRuntime(f.eda,{target});assert.equal(r.items[0].bounds,null);assert.ok(r.items[0].warnings.includes('GRAPHICS_BOUNDS_UNKNOWN'));assert.equal(r.coverage.atomic,false);
});
test('N12 text bounding-box overlap is page-scoped and hidden text excluded',async()=>{
 const f=textFixture();f.eda.pcb_PrimitiveString.getAll=async()=>[{primitiveId:'s1',layer:3,fontSize:48,lineWidth:8,text:'TX'}];const r=await inspectSilkscreenRuntime(f.eda,{target});assert.deepEqual(r.sameLayerBBoxOverlaps,[['a1','s1']]);const page=await inspectSilkscreenRuntime(f.eda,{target,limit:1});assert.equal(page.hasMore,true);assert.deepEqual(page.sameLayerBBoxOverlaps,[]);
});
test('N13 text inspection rejects document drift during bbox read',async()=>{
 const f=textFixture();f.eda.pcb_Primitive.getPrimitivesBBox=async()=>{f.setDoc({uuid:'production',documentType:3});return null};await assert.rejects(inspectSilkscreenRuntime(f.eda,{target}),/document mismatch/);
});
test('N14 old fill data does not hide an undefined repour result',async()=>{
 const f=fixture();f.setDoc({uuid:target.documentUuid,documentType:3});f.eda.pcb_PrimitivePour={getAll:async()=>[{primitiveId:'p1',rebuildCopperRegion:async()=>undefined}]};f.eda.pcb_PrimitivePoured={getAll:async()=>[{primitiveId:'old-fill',pourPrimitiveId:'p1',pourFills:[{}]}]};const r=await pcbToolsRuntime(f.eda,{target,kind:'rebuildPours'});assert.equal(r.after[0].nonEmpty,true);assert.deepEqual(r.unverifiedRebuildIds,['p1']);
});
test('N15 sync preflight rejects a changing snapshot across two reads',async()=>{
 const f=fixture();f.setDoc({uuid:target.documentUuid,documentType:3});let count=0;const empty={getAll:async()=>[]};
 for(const key of ['Component','Pad','Line','Via','Pour','String','Attribute'])f.eda['pcb_Primitive'+key]={...empty};
 f.eda.pcb_Net={getNetlist:async()=>({revision:++count})};await assert.rejects(pcbToolsRuntime(f.eda,{target,kind:'syncSnapshot'}),/changed during synchronization/);
});
test('N16 exposed inspection/open runtimes serialize without Node dependencies',()=>{
 for(const fn of [openTargetRuntime,inspectSilkscreenRuntime]){assert.doesNotMatch(fn.toString(),/node:|process\.|require\(/);new Function('eda','request',`return (${fn.toString()})(eda,request);`);}
});

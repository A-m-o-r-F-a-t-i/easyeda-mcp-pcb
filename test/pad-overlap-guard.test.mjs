import test from 'node:test';
import assert from 'node:assert/strict';
import { batchRuntime, buildBatchCode } from '../src/runtime.mjs';

const target={documentUuid:'pcb-overlap',projectUuid:'project-overlap',windowId:'window-overlap'};
const clone=value=>structuredClone(value);

function fixture({secondLayer=1}={}){
 const components=new Map([
  ['c1',{primitiveId:'c1',designator:'U1',x:0,y:0,rotation:0,layer:1,primitiveLock:false}],
  ['c2',{primitiveId:'c2',designator:'J1',x:100,y:0,rotation:0,layer:secondLayer,primitiveLock:false}],
 ]);
 const pins=new Map([
  ['c1',[{primitiveId:'p1',padNumber:'1',net:'SHARED',layer:1,x:0,y:0,rotation:0,pad:['RECT',20,20,0],hole:null,metallization:true,primitiveLock:false}]],
  ['c2',[{primitiveId:'p2',padNumber:'1',net:'SHARED',layer:secondLayer,x:100,y:0,rotation:0,pad:['ELLIPSE',40,40],hole:null,metallization:true,primitiveLock:false}]],
 ]);
 const standalonePads=[];
 const vias=[];
 let writes=0,padCreates=0;
 const componentApi={
  getAll:async()=>[...components.values()].map(clone),
  get:async primitiveId=>clone(components.get(primitiveId)),
  getAllPinsByPrimitiveId:async primitiveId=>(pins.get(primitiveId)??[]).map(clone),
  modify:async(primitiveId,set)=>{
   writes++;
   const before=components.get(primitiveId),after={...before,...set};components.set(primitiveId,after);
   const delta=(after.rotation??0)-(before.rotation??0),angle=delta*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
   pins.set(primitiveId,(pins.get(primitiveId)??[]).map(pin=>{
    const rx=pin.x-before.x,ry=pin.y-before.y;
    return {...pin,x:after.x+rx*cos-ry*sin,y:after.y+rx*sin+ry*cos,rotation:(pin.rotation??0)+delta,layer:after.layer===before.layer?pin.layer:after.layer};
   }));
   return clone(after);
  },
 };
 const padApi={
  getAll:async()=>[...pins.values()].flat().concat(standalonePads).map(clone),
  create:async(layer,padNumber,x,y,rotation,pad,net,hole,holeOffsetX,holeOffsetY,holeRotation,metallization,padType,specialPad,masks,heat,primitiveLock)=>{
   padCreates++;
   const value={primitiveId:`sp${padCreates}`,layer,padNumber,x,y,rotation,pad,net:net??'',hole,holeOffsetX,holeOffsetY,holeRotation,metallization,padType,primitiveLock};standalonePads.push(value);return clone(value);
  },
  modify:async()=>{throw new Error('unexpected standalone pad modify')},
  delete:async()=>{throw new Error('unexpected standalone pad delete')},
 };
 const viaApi={getAll:async()=>vias.map(clone),create:async(net,x,y,holeDiameter,diameter,viaType,special,masks,primitiveLock)=>{writes++;const value={primitiveId:`v${vias.length+1}`,net,x,y,holeDiameter,diameter,viaType,primitiveLock};vias.push(value);return clone(value);}};
 const eda={
  sys_Environment:{getEditorCurrentVersion:async()=> '4.1.60'},
  dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:target.documentUuid,documentType:3})},
  dmt_Project:{getCurrentProjectInfo:async()=>({uuid:target.projectUuid})},
  pcb_PrimitiveComponent:componentApi,pcb_PrimitivePad:padApi,pcb_PrimitiveVia:viaApi,
  pcb_PrimitiveLine:{getAll:async()=>[]},pcb_PrimitiveArc:{getAll:async()=>[]},pcb_PrimitiveFill:{getAll:async()=>[]},pcb_PrimitivePour:{getAll:async()=>[]},
 };
 return {eda,writes:()=>writes,padCreates:()=>padCreates,component:id=>clone(components.get(id)),pins:id=>(pins.get(id)??[]).map(clone)};
}

const componentMove=(set,expectedOverride={})=>({
 id:'move-u1',type:'component.modify',kind:'component',primitiveId:'c1',
 expected:{x:0,y:0,rotation:0,layer:1,primitiveLock:false,designator:'U1',...expectedOverride},set,
 copperPolicy:'replan',affectedNets:['SHARED'],
});
const padCreate=(x,y)=>({id:'large-pad',type:'pad.create',kind:'pad',state:{layer:12,padNumber:'BAT',x,y,rotation:0,pad:['ELLIPSE',80,80],net:'SHARED',hole:['ROUND',40],holeOffsetX:0,holeOffsetY:0,holeRotation:0,metallization:true,padType:0,primitiveLock:false}});
const viaCreate=(x,y)=>({id:'large-via',type:'via.create',kind:'via',state:{net:'SHARED',x,y,holeDiameter:20,diameter:60,viaType:0,primitiveLock:false}});
const run=(f,operations)=>batchRuntime(f.eda,{target,toleranceMil:0.02,operations});

test('C01 component move is blocked before write when its pad would overlap another component pad, even on the same net',async()=>{
 const f=fixture(),result=await run(f,[componentMove({x:100})]);
 assert.equal(result.ok,false);assert.equal(result.error.code,'PAD_OVERLAP_BLOCKED');assert.match(result.error.message,/U1 pad 1 intersects J1 pad 1/);assert.equal(result.error.details.collisionCount,1);assert.equal(f.writes(),0);assert.equal(f.component('c1').x,0);
});

test('C02 large standalone plated pad and via are blocked before they overlap a component pad',async()=>{
 const padFixture=fixture(),padResult=await run(padFixture,[padCreate(100,0)]);
 assert.equal(padResult.ok,false);assert.equal(padResult.error.code,'PAD_OVERLAP_BLOCKED');assert.equal(padFixture.padCreates(),0);
 const viaFixture=fixture(),viaResult=await run(viaFixture,[viaCreate(100,0)]);
 assert.equal(viaResult.ok,false);assert.equal(viaResult.error.code,'PAD_OVERLAP_BLOCKED');assert.equal(viaFixture.writes(),0);
});

test('C03 a clear component placement succeeds and returns pre/post overlap evidence',async()=>{
 const f=fixture(),result=await run(f,[componentMove({x:60})]);
 assert.equal(result.ok,true);assert.equal(result.results[0].status,'modified');assert.equal(result.results[0].overlapGuard.preflight.checked,true);assert.equal(result.results[0].overlapGuard.postflight.checked,true);assert.equal(f.writes(),1);assert.equal(f.component('c1').x,60);
});

test('C04 native layer flip is post-checked and rolled back when actual pads overlap',async()=>{
 const f=fixture({secondLayer:2}),result=await run(f,[componentMove({x:100,layer:2})]);
 assert.equal(result.ok,false);assert.equal(result.error.code,'PAD_OVERLAP_BLOCKED');assert.equal(result.error.details.rollbackVerified,true);assert.equal(f.writes(),2);assert.deepEqual(f.component('c1'),{primitiveId:'c1',designator:'U1',x:0,y:0,rotation:0,layer:1,primitiveLock:false});assert.equal(f.pins('c1')[0].layer,1);
});

test('C05 serialized executor includes the collision guard and remains self-contained',async()=>{
 const f=fixture();
 const code=buildBatchCode({target,toleranceMil:0.02,operations:[componentMove({x:60})]});
 const result=await new Function('eda',`return (async()=>{${code}})()`)(f.eda);
 assert.equal(result.ok,true);assert.equal(result.results[0].overlapGuard.postflight.checked,true);
});

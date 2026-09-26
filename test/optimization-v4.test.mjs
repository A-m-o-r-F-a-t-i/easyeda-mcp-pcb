import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copperCorridor,viaArray} from '../src/explicit-geometry.mjs';
import {modelCopper,nativePolygon,containsPoint} from '../src/copper-geometry.mjs';
import {analyzeCopperTopology} from '../src/copper-topology.mjs';
import {executeWithReceipt,getReceipt,listReceipts} from '../src/execution-receipts.mjs';
import {applyEdits} from '../src/simple-service.mjs';
import {createMockEda,runEdit,target} from './fixture.mjs';

const scene=()=>({units:'mil',components:[],layers:[{id:1},{id:2}],pads:[],vias:[],lines:[],arcs:[],fills:[],pours:[],poured:[],regions:[],polylines:[],coverage:{missing:[]}});
const pad=(id,x,y=0,layer=2)=>({primitiveId:id,net:'PWR',x,y,layer,rotation:0,pad:['RECT',10,10,0],hole:null,metallization:true});
const via=(id,x,y=0)=>({primitiveId:id,net:'PWR',x,y,viaType:0,diameter:24,holeDiameter:12});
const line=(id,a,b,layer=2,width=20)=>({primitiveId:id,net:'PWR',layer,startX:a[0],startY:a[1],endX:b[0],endY:b[1],lineWidth:width});
const rectangle=(x0,y0,x1,y1)=>[x0,y0,'L',x1,y0,x1,y1,x0,y1,x0,y0];
const fill=(id,source,layer=2)=>({primitiveId:id,net:'PWR',layer,complexPolygon:source,fillMode:0,lineWidth:0});
const paths=[{net:'PWR',from:'a',to:'b'}];
const report=s=>analyzeCopperTopology(s,{paths,maxDetails:100});
async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-receipt-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('wide same-side copper connects pads and exposes exact requested section',()=>{
 const s=scene();s.pads=[pad('a',0),pad('b',100)];s.fills=[fill('bus',rectangle(-10,-15,110,15))];
 const r=analyzeCopperTopology(s,{paths,sections:[{net:'PWR',layer:2,from:[50,-40],to:[50,40]}]});
 assert.equal(r.coverage.complete,true);assert.equal(r.paths[0].layerChanges,0);assert.deepEqual(r.paths[0].sameLayerPaths,[2]);assert.equal(r.sections[0].totalCopperLengthMil,30);
});
test('a concave copper notch is not treated as its enclosing rectangle',()=>{
 const s=scene();s.fills=[fill('concave',[-20,-20,'L',120,-20,120,30,80,30,80,0,40,0,40,30,-20,30,-20,-20])];s.pads=[pad('a',0,10),pad('b',60,20)];
 assert.equal(report(s).paths[0].connected,false);
});
test('same-winding inner contour remains an actual hole',()=>{
 const s=scene();s.pads=[pad('a',0),pad('b',50)];s.fills=[fill('ring',[rectangle(-10,-30,110,30),rectangle(35,-20,65,20)])];
 const r=report(s);assert.equal(r.paths[0].connected,false);assert.equal(r.coverage.complete,true);assert.equal(nativePolygon(s.fills[0].complexPolygon)[0].length,2);
});
test('projected SMD pads on different layers are not connected',()=>{const s=scene();s.pads=[pad('a',0,0,1),pad('b',0,0,2)];assert.equal(report(s).paths[0].connected,false);});
test('single required via is distinguished from parallel layer links',()=>{
 const s=scene();s.pads=[pad('a',0,0,1),pad('b',100,0,2)];s.fills=[fill('top',rectangle(-10,-20,60,20),1),fill('bottom',rectangle(40,-20,110,20),2)];s.vias=[via('v1',50,-6)];
 let r=report(s);assert.equal(r.paths[0].layerChanges,1);assert.deepEqual(r.paths[0].mandatoryViaIds,['v1']);assert.equal(r.paths[0].transitions[0].holeDiameterMil,12);
 s.vias.push(via('v2',50,12));r=report(s);assert.equal(r.paths[0].layerChanges,1);assert.deepEqual(r.paths[0].mandatoryViaIds,[]);
});
test('explicit via exclusion recomputes contact topology without editing source',()=>{
 const s=scene();s.pads=[pad('a',0,0,1),pad('b',100,0,2)];s.lines=[line('t',[0,0],[50,0],1),line('b',[50,0],[100,0],2)];s.vias=[via('v',50)];
 const before=JSON.stringify(s),r=analyzeCopperTopology(s,{paths,excludeIds:['v']});assert.equal(r.paths[0].connected,false);assert.equal(JSON.stringify(s),before);
});
test('NPTH drills subtract copper and can split a narrow bus',()=>{
 const s=scene();s.pads=[pad('a',0),pad('b',100),{primitiveId:'mount',net:'',layer:12,x:50,y:0,pad:['ELLIPSE',40,40],hole:['ROUND',40],metallization:false}];s.fills=[fill('bus',rectangle(-10,-10,110,10))];
 const r=report(s);assert.equal(r.coverage.complete,true);assert.equal(r.paths[0].connected,false);assert.equal(r.coverage.excluded.length,1);
});
test('empty pour boundary is unknown and never substituted for actual fill',()=>{
 const s=scene();s.pads=[pad('a',0),pad('b',100)];s.pours=[{primitiveId:'pour',net:'PWR',layer:2,complexPolygon:rectangle(-20,-30,120,30)}];
 let r=report(s);assert.equal(r.connectivityVerdict,'PARTIAL');assert.equal(r.paths[0].connected,false);
 s.poured=[{primitiveId:'pour',pourPrimitiveId:'pour',fillGeometry:{verified:true,units:'mil'},pourFillsMil:[{fill:true,lineWidth:0,path:{complexPolygon:rectangle(-20,-30,120,30)}}]}];
 r=report(s);assert.equal(r.coverage.complete,true);assert.equal(r.paths[0].connected,true);
});
test('blind via and unknown pad coordinate frames remain explicit coverage gaps',()=>{
 const s=scene();s.vias=[{...via('blind',50),viaType:1}];s.pads=[{...pad('a',0),pad:['POLYGON',rectangle(-5,-5,5,5)],padGeometryFrame:'unknown'},pad('b',100)];
 const r=report(s);assert.equal(r.connectivityVerdict,'PARTIAL');assert.equal(r.coverage.unsupported.length,2);assert.equal(r.paths[0].status,'UNRESOLVED');
});
test('native circular contour supports complete sweeps and hollow rings',()=>{
 const g=nativePolygon([[-20,0,'ARC',180,20,0,'ARC',180,-20,0],[-10,0,'ARC',180,10,0,'ARC',180,-10,0]]);
 assert.equal(g.length,1);assert.equal(g[0].length,2);assert.equal(containsPoint([0,0],g[0]),false);assert.equal(containsPoint([15,0],g[0]),true);
});
test('world-coordinate custom pads are not transformed twice',()=>{
 const s=scene();s.pads=[{...pad('a',500,500),pad:['POLYGON',rectangle(-5,-5,5,5)],padGeometryFrame:'board'},pad('b',100)];s.lines=[line('wire',[0,0],[100,0])];assert.equal(report(s).paths[0].connected,true);
});
test('isolated copper is reported without an automatic deletion verdict',()=>{
 const s=scene();s.pads=[pad('a',0)];s.fills=[fill('orphan',rectangle(200,200,250,250))];const r=analyzeCopperTopology(s);assert.equal(r.nets[0].copperOnlyIslandCount,1);assert.equal(r.nets[0].copperOnlyIslands[0].deletionRecommendation,null);
});
test('explicit copper construction handles arbitrary turns without route search',()=>{
 const points=copperCorridor([[0,0],[0,0],[100,0],[140,40]],20);assert.ok(points.length>=6);assert.throws(()=>copperCorridor([[0,0],[100,0],[0,0]],20),/double back/);assert.throws(()=>copperCorridor([[0,0],[0,0]],20),/distinct/);
});
test('via-array geometry keeps exact rotation, pitch and drill semantics',()=>{
 const points=viaArray({origin:[10,20],rows:2,columns:2,pitch:[30,40],angle:90,diameter:32,holeDiameter:18});assert.equal(points.length,4);assert.ok(Math.abs(points[3][0]+30)<1e-8);assert.ok(Math.abs(points[3][1]-50)<1e-8);assert.throws(()=>viaArray({origin:[0,0],rows:2,columns:2,pitch:[30,40],diameter:10,holeDiameter:12}),/exceed/);
});
test('typed copper path and array write native fills/vias in one ordered edit',async()=>{
 const env=createMockEda();const r=await runEdit(env,[{op:'copper_path',net:'SIG',layer:'bottom',width:30,points:[[0,0],[100,0],[130,30]]},{op:'via_array',net:'GND',origin:[100,200],rows:2,columns:3,pitch:[40,40],diameter:32,holeDiameter:18}]);assert.equal(r.ok,true);assert.equal(env.stores.fill.size,1);assert.equal(env.stores.via.size,6);
});
test('orientation uses actual same-side pads and leaves identity and side intact',async()=>{
 const env=createMockEda(),c=[...env.stores.component.values()][0];c.layer=2;const r=await runEdit(env,[{op:'orient',ref:'U1',pads:['1'],toward:[0,200]}]);assert.equal(r.ok,true);assert.equal(c.layer,2);assert.equal(c.designator,'U1');const p=(await env.eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId))[0];assert.ok(Math.abs(p.x)<1e-8);assert.ok(p.y>0);
});
test('undefined pad-group orientation causes zero native changes',async()=>{const env=createMockEda();const r=await runEdit(env,[{op:'orient',ref:'U1',pads:['1','2'],toward:[100,100]}]);assert.equal(r.ok,false);assert.equal(env.calls.length,0);});
test('durable request identity returns prior result without duplicate dispatch',async t=>{
 const dir=await directory(t),request={requestId:'same',operations:[{op:'test'}]};let calls=0;const execute=async()=>({ok:true,wrotePcb:true,saved:true,counts:{applied:1},number:++calls});
 const a=await executeWithReceipt(request,execute,{directory:dir}),b=await executeWithReceipt(request,execute,{directory:dir});assert.equal(calls,1);assert.equal(b.replayed,true);assert.equal(a.receiptId,b.receiptId);
 await assert.rejects(()=>executeWithReceipt({...request,operations:[{op:'different'}]},execute,{directory:dir}),{code:'REQUEST_ID_CONFLICT'});
});
test('a new Node process can query a persisted execution receipt',async t=>{
 const dir=await directory(t);await executeWithReceipt({requestId:'restart',operations:[]},async()=>({ok:true,wrotePcb:false,saved:false}),{directory:dir});
 const code=`import {getReceipt} from ${JSON.stringify(new URL('../src/execution-receipts.mjs',import.meta.url).href)};console.log(JSON.stringify(await getReceipt('restart',{directory:${JSON.stringify(dir)}})));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code]);assert.equal(JSON.parse(stdout).receiptState,'completed');
});
test('unknown dispatched write is retained and never replayed',async t=>{
 const dir=await directory(t),request={requestId:'unknown',operations:[{op:'test'}]};let calls=0;
 const execute=async(_id,update)=>{calls++;await update({dispatchStarted:true,target});throw Error('Response lost');};
 const first=await executeWithReceipt(request,execute,{directory:dir}),second=await executeWithReceipt(request,execute,{directory:dir});assert.equal(first.wrotePcb,null);assert.equal(second.receiptState,'review_required');assert.equal(calls,1);
 const list=await listReceipts({directory:dir,target:target.documentUuid});assert.equal(list.items.length,1);
});
test('bulk edit receipts distinguish saved=false from native edit success',async t=>{
 const dir=await directory(t),env=createMockEda(),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const deps={receiptDirectory:dir,resolve:async()=>({target,bridge:{}}),run:async(_bridge,code)=>new AsyncFunction('eda',code)(env.eda),save:async()=>false};
 const req={requestId:'save-fails',operations:[{op:'via',positions:[[10,10]],net:'GND',diameter:24,holeDiameter:12}],save:true,view:'none'};
 const a=await applyEdits(req,deps),b=await applyEdits(req,deps);assert.equal(a.ok,false);assert.equal(a.wrotePcb,true);assert.equal(a.saveError.code,'SAVE_NOT_ACKNOWLEDGED');assert.equal(b.replayed,true);assert.equal(env.stores.via.size,1);assert.equal(a.boardDelta.created.via.length,1);
});

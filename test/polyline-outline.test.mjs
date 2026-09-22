import test from 'node:test';
import assert from 'node:assert/strict';
import { planSummary, validatePlan } from '../src/plan.mjs';
import { batchRuntime, readRuntime } from '../src/runtime.mjs';
import { renderSnapshotSvg } from '../src/vector-inspection.mjs';

const target={documentUuid:'pcb-outline',projectUuid:'project-outline',windowId:'window-outline'};
const rawPlan=()=>({
 schema:'easyeda-pcb-plan/v2',intent:'native closed board outline',target,units:'mm',phase:'layout',
 constraints:{boardBounds:{minX:-6,minY:-6,maxX:6,maxY:6}},
 operations:[{id:'outline',type:'outline.create',points:[[-5,-5],[5,-5],[5,5],[-5,5]],width:0.1,locked:true}],
});
const compiled=()=>validatePlan(rawPlan());
const rawCirclePlan=()=>({
 schema:'easyeda-pcb-plan/v2',intent:'native circular board outline',target,units:'mm',phase:'layout',
 constraints:{boardBounds:{minX:-6,minY:-6,maxX:6,maxY:6}},
 operations:[{id:'outline-circle',type:'outline.create',shape:'CIRCLE',position:[0,0],diameter:10,width:0.1,locked:true}],
});
const compiledCircle=()=>validatePlan(rawCirclePlan());

test('O01 outline.create compiles to one native closed polyline',()=>{
 const plan=compiled();assert.equal(plan.operations.length,1);const op=plan.operations[0];
 assert.equal(op.type,'polyline.create');assert.equal(op.kind,'polyline');assert.equal(op.state.layer,11);assert.equal(op.state.net,'');assert.equal(op.state.primitiveLock,true);
 assert.equal(op.polygon[2],'L');assert.deepEqual(op.polygon.slice(-2),op.polygon.slice(0,2));
});

test('O02 direct BOARD_OUTLINE line creation is rejected before client access',()=>{
 const plan=rawPlan();plan.operations=[{id:'legacy',type:'line.create',net:'',layer:'BOARD_OUTLINE',start:[0,0],end:[10,0],width:0.1}];
 assert.throws(()=>validatePlan(plan),/Use outline\.create/);
});

function fixture({mutate=true,initial=[]}={}){
 let writes=0,items=[...initial];
 const eda={
  dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:target.documentUuid,documentType:3})},
  dmt_Project:{getCurrentProjectInfo:async()=>({uuid:target.projectUuid})},
  pcb_MathPolygon:{createPolygon:source=>({getSource:()=>structuredClone(source)})},
  pcb_PrimitivePolyline:{
   getAll:async(net,layer)=>items.filter(item=>(net===undefined||item.net===net)&&(layer===undefined||item.layer===layer)),
   get:async id=>Array.isArray(id)?items.filter(x=>id.includes(x.primitiveId)):items.find(x=>x.primitiveId===id),
   create:async(net,layer,polygon,lineWidth,primitiveLock)=>{writes++;if(mutate)items=[{primitiveId:'outline-1',net:net||null,layer,polygon,lineWidth,primitiveLock}];},
  },
 };
 return {eda,writes:()=>writes,items:()=>items};
}

test('O03 native polyline creation requires independent polygon readback',async()=>{
 const plan=compiled(),f=fixture();
 const result=await batchRuntime(f.eda,{target,operations:plan.operations,toleranceMil:plan.options.toleranceMil});
 assert.equal(result.ok,true);assert.equal(result.completedCount,1);assert.equal(result.results[0].status,'created');assert.deepEqual(result.results[0].primitiveIds,['outline-1']);assert.equal(f.writes(),1);
 const read=await readRuntime(f.eda,{target,kind:'polylines'});assert.equal(read.total,1);assert.deepEqual(read.items[0].polygon,plan.operations[0].polygon);
});

test('O04 native create acknowledgement without geometry mutation fails',async()=>{
 const plan=compiled(),f=fixture({mutate:false});
 const result=await batchRuntime(f.eda,{target,operations:plan.operations,toleranceMil:plan.options.toleranceMil});
 assert.equal(result.ok,false);assert.equal(result.completedCount,0);assert.match(result.error.message,/not verified/);assert.equal(f.writes(),1);
});

test('O05 vector inspection renders typed board-outline polylines',()=>{
 const polygon=[0,0,'L',100,0,100,100,0,100,0,0];
 const snapshot={units:'mil',layers:[{id:11,name:'BoardOutline',layerStatus:1,color:'#ffffff'}],components:[],pads:[],lines:[],polylines:[{primitiveId:'outline-1',net:'',layer:11,polygon,lineWidth:4}],vias:[],pours:[],poured:[],fills:[],arcs:[],regions:[],strings:[],attributes:[]};
 const rendered=renderSnapshotSvg(snapshot,{layerMode:'all',designators:'none',marginMil:0});
 assert.equal(rendered.counts.polylines,1);assert.match(rendered.svg,/class="track"/);assert.equal(rendered.widthMil,100);assert.equal(rendered.heightMil,100);
});

test('O06 native null net is equivalent to an empty outline net',async()=>{
 const plan=compiled(),op=plan.operations[0];
 const f=fixture({initial:[{primitiveId:'existing-outline',net:null,layer:op.state.layer,polygon:op.polygon,lineWidth:op.state.lineWidth,primitiveLock:op.state.primitiveLock}]});
 const result=await batchRuntime(f.eda,{target,operations:plan.operations,toleranceMil:plan.options.toleranceMil});
 assert.equal(result.ok,true);assert.equal(result.results[0].status,'already_exists');assert.deepEqual(result.results[0].primitiveIds,['existing-outline']);assert.equal(f.writes(),0);
});

test('O07 circular outline compiles to the native CIRCLE polygon source',()=>{
 const plan=compiledCircle();assert.equal(plan.operations.length,1);const op=plan.operations[0],scale=1/0.0254;
 assert.equal(op.type,'polyline.create');assert.equal(op.kind,'polyline');assert.equal(op.state.layer,11);
 assert.deepEqual(op.polygon,['CIRCLE',0,0,5*scale]);
 assert.ok(planSummary(plan).checks.includes('native circular or closed polygon outlines'));
});

test('O08 circular outline rejects polygon mixing, nonpositive diameter and bounds overflow',()=>{
 const mixed=rawCirclePlan();mixed.operations[0].points=[[0,0],[1,0],[0,1]];assert.throws(()=>validatePlan(mixed),/not points/);
 const zero=rawCirclePlan();zero.operations[0].diameter=0;assert.throws(()=>validatePlan(zero),/Positive outline diameter/);
 const overflow=rawCirclePlan();overflow.operations[0].diameter=30;assert.throws(()=>validatePlan(overflow),/Circular outline exceeds/);
 const polygonWithCircleFields=rawPlan();polygonWithCircleFields.operations[0].position=[5,5];assert.throws(()=>validatePlan(polygonWithCircleFields),/Polygon outline uses points/);
});

test('O08B new board outlines must be centered on the coordinate origin',()=>{
 const circle=rawCirclePlan();circle.operations[0].position=[1,0];assert.throws(()=>validatePlan(circle),/coordinate origin/);
 const polygon=rawPlan();polygon.operations[0].points=[[-4,-5],[6,-5],[6,5],[-4,5]];assert.throws(()=>validatePlan(polygon),/bounding-box center/);
 assert.ok(planSummary(compiled()).checks.includes('new board outline centered at coordinate origin'));
});

test('O09 native circular outline requires exact center and radius readback',async()=>{
 const plan=compiledCircle(),op=plan.operations[0],existing={primitiveId:'circle-outline',net:null,layer:op.state.layer,polygon:[...op.polygon],lineWidth:op.state.lineWidth,primitiveLock:op.state.primitiveLock};
 const present=fixture({initial:[existing]});
 const same=await batchRuntime(present.eda,{target,operations:plan.operations,toleranceMil:plan.options.toleranceMil});
 assert.equal(same.ok,true);assert.equal(same.results[0].status,'already_exists');assert.equal(present.writes(),0);
 const wrongRadius=fixture({initial:[{...existing,polygon:['CIRCLE',op.polygon[1],op.polygon[2],op.polygon[3]+1]}]});
 const created=await batchRuntime(wrongRadius.eda,{target,operations:plan.operations,toleranceMil:plan.options.toleranceMil});
 assert.equal(created.ok,true);assert.equal(created.results[0].status,'created');assert.equal(wrongRadius.writes(),1);
});

test('O10 a polygon with the same bounding box is not accepted as a native circle',async()=>{
 const plan=compiledCircle(),op=plan.operations[0],r=op.polygon[3],cx=op.polygon[1],cy=op.polygon[2];
 const square=[cx-r,cy-r,'L',cx+r,cy-r,cx+r,cy+r,cx-r,cy+r,cx-r,cy-r];
 const f=fixture({initial:[{primitiveId:'square-outline',net:null,layer:op.state.layer,polygon:square,lineWidth:op.state.lineWidth,primitiveLock:op.state.primitiveLock}]});
 const result=await batchRuntime(f.eda,{target,operations:plan.operations,toleranceMil:plan.options.toleranceMil});
 assert.equal(result.ok,true);assert.equal(result.results[0].status,'created');assert.equal(f.writes(),1);
});

test('O11 vector inspection renders native circular board-outline geometry',()=>{
 const snapshot={units:'mil',layers:[{id:11,name:'BoardOutline',layerStatus:1,color:'#ffffff'}],components:[],pads:[],lines:[],polylines:[{primitiveId:'circle-outline',net:'',layer:11,polygon:['CIRCLE',50,50,50],lineWidth:4}],vias:[],pours:[],poured:[],fills:[],arcs:[],regions:[],strings:[],attributes:[]};
 const rendered=renderSnapshotSvg(snapshot,{layerMode:'all',designators:'none',marginMil:0});
 assert.equal(rendered.counts.polylines,1);assert.equal(rendered.widthMil,100);assert.equal(rendered.heightMil,100);assert.match(rendered.svg,/A 50 50 0 1 0/);
});

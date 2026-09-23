import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import {getToolRegistry,createPcbServer} from '../src/server.mjs';
import {editSchema,expandOperations,catalog} from '../src/simple-contract.mjs';
import {createNativeHelpers} from '../src/simple-native.mjs';
import {simpleEditRuntime} from '../src/simple-runtime.mjs';
import {collectSceneRuntime,buildOverview,padBounds} from '../src/component-overview.mjs';
import {renderFeedbackSvg} from '../src/feedback-svg.mjs';
import {applyEdits,codeFor,retainResult,readRetained} from '../src/simple-service.mjs';
const target={documentUuid:'pcb-test',projectUuid:'project-test',windowId:'window-test'};
test('world-coordinate polygon pads are neither translated nor rotated twice',()=>{
 const p={primitiveId:'world-pad',padNumber:'1',net:'SIG',layer:1,x:110,y:210,rotation:90,pad:['POLYGON',[100,200,'L',120,200,120,220,100,220,100,200]],padGeometryFrame:'board'};
 assert.deepEqual(padBounds(p),{minX:100,maxX:120,minY:200,maxY:220});
 assert.equal(padBounds({...p,padGeometryFrame:'unknown'}),null);
 const r=renderFeedbackSvg({document:{uuid:'test'},components:[],pads:[p],coverage:{passes:1}},{side:'top',pinLabels:true});
 assert.match(r.svg,/PAD.1 \/ SIG/);assert.doesNotMatch(r.svg,/translate\(110 210\)/);
});
let counter=0;
test('dense pin legends use compact columns and board framing reports staging objects',()=>{
 const pads=Array.from({length:84},(_,i)=>({primitiveId:'p'+i,padNumber:String(i),net:'N'+i,layer:1,x:20+(i%12)*20,y:20+Math.floor(i/12)*20,pad:['ELLIPSE',10,10]}));
 const s={document:{uuid:'test'},components:[{primitiveId:'off',designator:'OFF',x:10000,y:10000,layer:1}],pads,polylines:[{primitiveId:'outline',layer:11,polygon:[0,0,'L',300,0,300,200,0,200,0,0]}],coverage:{passes:1}};
 const r=renderFeedbackSvg(s,{pinLabels:true});assert.equal(r.metadata.pinLabelLayout,'indexed-grid');assert.equal(r.metadata.legendColumns,4);assert.ok(r.viewBox.height<1200);assert.deepEqual(r.metadata.componentsOutsideView,['OFF']);assert.ok(r.boardBounds.maxX<10000);
});
export function mockEda(count=2){
 const names={component:'Component',pad:'Pad',line:'Line',arc:'Arc',via:'Via',polyline:'Polyline',fill:'Fill',pour:'Pour',poured:'Poured',region:'Region',string:'String',attribute:'Attribute'};
 const stores=Object.fromEntries(Object.keys(names).map(k=>[k,new Map()]));
 const calls=[];let next=0;
 const eda={dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:target.documentUuid,documentType:3,name:'TEST'})},dmt_Project:{getCurrentProjectInfo:async()=>({uuid:target.projectUuid})},sys_Environment:{getEditorCurrentVersion:async()=> '4.1.60'},pcb_Document:{getCanvasOrigin:async()=>({x:0,y:0}),save:async()=>true},pcb_Layer:{getAllLayers:async()=>[{id:1,name:'Top',layerStatus:1},{id:2,name:'Bottom',layerStatus:1},{id:3,name:'Top Silk',layerStatus:1},{id:4,name:'Bottom Silk',layerStatus:1},{id:11,name:'Board Outline',layerStatus:1},{id:12,name:'Multi',layerStatus:1}],setTheNumberOfCopperLayers:async()=>true},pcb_MathPolygon:{createPolygon:s=>({getSource:()=>s})},pcb_Primitive:{getPrimitivesBBox:async ids=>{const c=stores.component.get(ids[0]);return c?{minX:c.x-30,maxX:c.x+30,minY:c.y-20,maxY:c.y+20}:undefined;},getPrimitiveBoardLine:(id,layers)=>{const c=stores.component.get(id);return c&&layers[0]===48?{getSource:()=>['CIRCLE',c.x,c.y,20]}:undefined;}},pcb_Net:{getAllNets:async()=>['SIG','GND'],getNetlist:async()=>({})}};
 const add=(kind,data)=>{const o={primitiveId:kind+'-'+next++,...data};stores[kind].set(o.primitiveId,o);return o;};
 const signatures={line:['net','layer','startX','startY','endX','endY','lineWidth','primitiveLock'],arc:['net','layer','startX','startY','endX','endY','arcAngle','lineWidth','interactiveMode','primitiveLock'],via:['net','x','y','holeDiameter','diameter','viaType','a','b','primitiveLock'],pad:['layer','padNumber','x','y','rotation','pad','net','hole','holeOffsetX','holeOffsetY','holeRotation','metallization','padType','a','b','c','primitiveLock'],polyline:['net','layer','polygon','lineWidth','primitiveLock'],fill:['layer','complexPolygon','net','fillMode','lineWidth','primitiveLock'],pour:['net','layer','complexPolygon','fillMode','preserveSilos','pourName','pourPriority','lineWidth','primitiveLock'],region:['layer','complexPolygon','ruleType','regionName','lineWidth','primitiveLock'],string:['layer','x','y','text','fontFamily','fontSize','lineWidth','alignMode','rotation','reverse','expansion','mirror','primitiveLock'],component:['component','layer','x','y','rotation','primitiveLock']};
 for(const [kind,Name]of Object.entries(names))eda['pcb_Primitive'+Name]={
  get:async id=>stores[kind].get(id),getAll:async()=>kind==='pad'?[...stores.pad.values(),...await allPins()]:[...stores[kind].values()],
  create:async(...args)=>{calls.push({kind,action:'create',args});return add(kind,Object.fromEntries((signatures[kind]??[]).map((key,i)=>[key,args[i]])));},
  modify:async(id,set)=>{calls.push({kind,action:'modify',id,set});const o=stores[kind].get(id);if(!o)return undefined;Object.assign(o,set);return o;},
  delete:async id=>{calls.push({kind,action:'delete',id});return stores[kind].delete(id);}
 };
 async function componentPins(id){const c=stores.component.get(id);if(!c)return [];const a=(c.rotation??0)*Math.PI/180;return [-1,1].map((v,i)=>{const x=v*20*(c.layer===2?-1:1);return {primitiveId:id+'-p'+i,parentPrimitiveId:id,padNumber:String(i+1),net:i?'GND':'SIG',layer:c.layer,x:c.x+x*Math.cos(a),y:c.y+x*Math.sin(a),rotation:c.rotation??0,pad:['RECT',12,8,0],hole:null,metallization:true};});}
 async function allPins(){return (await Promise.all([...stores.component.keys()].map(componentPins))).flat();}
 eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId=componentPins;
 for(let i=0;i<count;i++){const c=add('component',{designator:'U'+(i+1),name:'MCU',footprint:{name:'SOIC-2',uuid:'fp'},layer:1,x:i*100,y:0,rotation:0,primitiveLock:false});add('attribute',{parentPrimitiveId:c.primitiveId,key:'Designator',value:c.designator,keyVisible:false,valueVisible:true,layer:3,x:c.x,y:0});}
 return {eda,stores,calls,add};
}
const normalize=operations=>z.object(editSchema).strict().parse({operations,save:false,view:'none'});
async function edit(env,operations){const request=normalize(operations);return simpleEditRuntime(env.eda,{target,units:request.units,executionId:'test-'+counter++,offset:0,operations:expandOperations(request.operations)},createNativeHelpers);}
async function scene(env){return collectSceneRuntime(env.eda,{target,geometry:true},createNativeHelpers);}

test('v3 default registry exposes 21 simplified tools with no execution credentials',()=>{
 assert.equal(getToolRegistry().size,21);createPcbServer();const schema=z.toJSONSchema(z.object(getToolRegistry().get('pcb_execute_plan').definition.inputSchema));
 for(const k of ['guard','expected','mode','phase','executionId'])assert.equal(k in schema.properties,false,k);
 assert.ok(schema.properties.operations.items);assert.ok(catalog().operations);assert.equal(schema.properties.operations.maxItems,undefined);
});
test('arbitrary angle and an explicit right corner are executed unchanged',async()=>{
 const e=mockEda();const r=await edit(e,[{op:'route',net:'SIG',layer:'top',width:0.25,items:[{points:[[0,0],[3,1.732],[3,4]]}]}]);
 assert.equal(r.ok,true);assert.equal(e.stores.line.size,2);const values=[...e.stores.line.values()];assert.equal(values[0].endY,1.732/0.0254);assert.equal(values[1].startX,3/0.0254);
});
test('placement and pin endpoints use native post-placement coordinates in the same batch',async()=>{
 const e=mockEda();const r=await edit(e,[{op:'place',items:[{ref:'U1',at:[10,8],angle:30,side:'bottom'}]},{op:'route',layer:'bottom',width:0.2,items:[{from:'U1.1',to:'U2.1',through:[[9,8]]}]}]);
 assert.equal(r.ok,true);const c=[...e.stores.component.values()][0],p=(await e.eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId))[0],line=[...e.stores.line.values()][0];assert.equal(line.startX,p.x);assert.equal(line.startY,p.y);assert.equal(line.net,'SIG');assert.equal(c.primitiveLock,false);
});
test('omitted pose and unrelated component fields remain unchanged',async()=>{
 const e=mockEda(),c=[...e.stores.component.values()][0];c.primitiveLock=true;const r=await edit(e,[{op:'place',items:[{ref:'U1',angle:47}]}]);assert.equal(r.ok,true);assert.equal(c.x,0);assert.equal(c.name,'MCU');assert.equal(c.primitiveLock,true);
});
test('large component and route arrays have no small-batch public limit',async()=>{
 const e=mockEda(350),ops=[{op:'place',items:Array.from({length:350},(_,i)=>({ref:'U'+(i+1),at:[i,0],angle:17}))},{op:'route',net:'SIG',layer:'top',width:0.1,items:Array.from({length:600},(_,i)=>({points:[[i,0],[i+0.5,0.31]]}))}];
 const r=await edit(e,ops);assert.equal(r.results.length,950);assert.equal(r.ok,true);assert.equal(e.stores.line.size,600);
});
test('native false is reported but independent actions continue',async()=>{
 const e=mockEda();let n=0;const original=e.eda.pcb_PrimitiveVia.create;e.eda.pcb_PrimitiveVia.create=async(...args)=>++n===1?false:original(...args);
 const r=await edit(e,[{op:'via',positions:[[0,0],[1,1]],net:'GND',diameter:0.6,holeDiameter:0.3}]);assert.deepEqual(r.results.map(x=>x.status),['failed','applied']);assert.equal(e.stores.via.size,1);
});
test('uncertain native write stops without replay and preserves earlier applied results',async()=>{
 const e=mockEda();let n=0;const original=e.eda.pcb_PrimitiveVia.create;e.eda.pcb_PrimitiveVia.create=async(...args)=>{const value=await original(...args);if(++n===2)throw Error('lost response');return value;};
 const r=await edit(e,[{op:'via',positions:[[0,0],[1,1],[2,2]],net:'GND',diameter:0.6,holeDiameter:0.3}]);assert.deepEqual(r.results.map(x=>x.status),['applied','unknown']);assert.equal(e.stores.via.size,2);assert.equal(r.nextIndex,2);
});
test('native region wraps rule enum flags and exact circle without polygon approximation',async()=>{
 const e=mockEda();const r=await edit(e,[{op:'region',geometry:{type:'circle',center:[7,9],diameter:6},layer:'multi',ruleTypes:[2,5,6],name:'mount'}]);assert.equal(r.ok,true);const o=[...e.stores.region.values()][0];assert.deepEqual(o.ruleType,[2,5,6]);const source=o.complexPolygon.getSource();assert.equal(source[0],'CIRCLE');for(const [i,wanted]of [7/0.0254,9/0.0254,3/0.0254].entries())assert.ok(Math.abs(source[i+1]-wanted)<1e-10);
});
test('off-origin outline and unconstrained via dimensions are passed to native API',async()=>{
 const e=mockEda();const r=await edit(e,[{op:'outline',geometry:{type:'circle',center:[50,50],diameter:48}},{op:'via',positions:[[80,80]],net:'GND',diameter:0.3,holeDiameter:0.2}]);assert.equal(r.ok,true);assert.equal(e.stores.polyline.size,1);assert.equal(e.stores.via.size,1);
});
test('text, pads, holes, pours and fill common actions use native signatures',async()=>{
 const e=mockEda();const r=await edit(e,[{op:'text',layer:'top_silkscreen',fontSize:1,items:[{at:[2,3],text:'TX / RX'}]},{op:'pad',at:[1,1],number:'1',net:'5V',layer:'top',padShape:{type:'rect',size:[2,1]}},{op:'hole',positions:[[4,4]],diameter:2,length:4,angle:30},{op:'pour',geometry:{type:'rectangle',at:[0,0],size:[10,10]},net:'GND',layer:'bottom'},{op:'fill',geometry:{type:'polygon',points:[[0,0],[2,0],[1,1]]},net:'5V',layer:'top'}]);
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal(e.stores.string.size,1);assert.equal([...e.stores.string.values()][0].fontSize,1/0.0254);assert.equal(e.stores.pad.size,2);assert.equal(e.stores.pour.size,1);assert.equal(e.stores.fill.size,1);
});
test('cleanup preserves semantic identity and unrelated strings',async()=>{
 const e=mockEda();[...e.stores.component.values()][0].primitiveLock=true;e.add('string',{text:'SIGNAL'});const r=await edit(e,[{op:'cleanup',unlock:true,hideDesignators:true}]);assert.equal(r.ok,true);assert.equal(e.stores.string.size,1);assert.ok([...e.stores.attribute.values()].every(x=>x.valueVisible===false));assert.equal([...e.stores.component.values()][0].designator,'U1');
});
test('transform, align, distribute and radial preserve caller geometry',async()=>{
 const e=mockEda(4);const r=await edit(e,[{op:'align',refs:['U1','U2'],axis:'y',value:2},{op:'distribute',refs:['U1','U2'],axis:'x',start:1,spacing:4},{op:'radial',refs:['U3','U4'],center:[0,0],radius:10,startAngle:0,stepAngle:90,orientationOffset:15},{op:'transform',select:{refs:['U1','U2']},translate:[1,0]}]);assert.equal(r.ok,true);const c=[...e.stores.component.values()];assert.ok(Math.abs(c[0].x-2/0.0254)<1e-9);assert.equal(c[3].rotation,105);
});
test('duplicate designators are reported as ambiguity before any write',async()=>{
 const e=mockEda();[...e.stores.component.values()][1].designator='U1';const r=await edit(e,[{op:'place',items:[{ref:'U1',at:[1,1]}]}]);assert.equal(r.results[0].status,'failed');assert.equal(r.results[0].error.code,'AMBIGUOUS_COMPONENT');assert.equal(e.calls.length,0);
});
test('overview returns all components, footprint names, physical dimension sources and orientation nets',async()=>{
 const e=mockEda();const s=await scene(e),data=buildOverview(s,{angles:[30],orientationCoordinates:true});assert.equal(data.totalComponents,2);assert.equal(data.totalPads,4);assert.equal(data.components[0].footprint.name,'SOIC-2');assert.equal(data.components[0].dimensions.body.width,1.016);assert.equal(data.components[0].dimensions.assembly,null);assert.equal(data.components[0].orientations[0].sides.left[0].net,'SIG');assert.equal(data.components[0].orientations[1].pads.length,2);assert.equal(data.nets.length,2);
});
test('bottom pose orientation derives from actual pads without double-mirroring',async()=>{
 const e=mockEda();await edit(e,[{op:'place',items:[{ref:'U1',at:[10,8],side:'bottom',angle:90}]}]);const data=buildOverview(await scene(e),{angles:[90],orientationCoordinates:true});const c=data.components[0];assert.equal(c.side,'bottom');assert.ok(c.orientations[0].pads[0].offset[1]>0);assert.equal(c.orientations[0].pads[0].net,'SIG');
});
test('SVG visibly labels pins/nets, preserves IDs and mirrors geometry only once',async()=>{
 const e=mockEda();await edit(e,[{op:'place',items:[{ref:'U1',at:[10,8],side:'bottom'}]}]);const s=await scene(e),view=renderFeedbackSvg(s,{side:'bottom',pinLabels:true});assert.match(view.svg,/U1\.1 \/ SIG/);assert.match(view.svg,/scale\(-1,-1\)/);assert.match(view.svg,/data-primitive-id=/);assert.equal(view.metadata.pinLabelCount,2);assert.equal(view.metadata.coverage.passes,1);assert.doesNotMatch(view.svg,/stableReads/);
});
test('serialized code runs without host closures or imported helpers',async()=>{
 const e=mockEda();const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;const request={target,units:'mm',executionId:'serialized-'+counter++,offset:0,operations:expandOperations(normalize([{op:'place',items:[{ref:'U1',at:[1,2]}]}]).operations)};
 const result=await new AsyncFunction('eda',codeFor(simpleEditRuntime,request))(e.eda);assert.equal(result.ok,true);
});
test('MCP service transport slices large batches internally and saves once',async()=>{
 const e=mockEda(2),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;let saves=0;
 const request=normalize([{op:'route',net:'SIG',layer:'top',width:0.1,items:Array.from({length:1800},(_,i)=>({points:[[i,0],[i+1,0.3]]}))}]);request.save=true;
 const result=await applyEdits(request,{resolve:async()=>({target,bridge:{}}),run:async(_,code)=>new AsyncFunction('eda',code)(e.eda),save:async()=>{saves++;return true;}});assert.equal(result.ok,true);assert.ok(result.batchCount>1);assert.equal(e.stores.line.size,1800);assert.equal(saves,1);
});
test('retained result paging preserves the full data without rerunning PCB reads',async()=>{
 const old=process.env.EASYEDA_PCB_ARTIFACT_DIR,dir=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-retain-'));process.env.EASYEDA_PCB_ARTIFACT_DIR=dir;try{const stored=await retainResult({components:Array.from({length:513},(_,i)=>({i}))});const page=await readRetained({resultId:stored.resultId,section:'components',offset:500,limit:20});assert.equal(page.items.length,13);assert.equal(page.total,513);assert.equal(page.nextOffset,null);}finally{if(old===undefined)delete process.env.EASYEDA_PCB_ARTIFACT_DIR;else process.env.EASYEDA_PCB_ARTIFACT_DIR=old;await fs.rm(dir,{recursive:true,force:true});}
});

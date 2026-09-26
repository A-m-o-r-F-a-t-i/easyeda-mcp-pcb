import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import {getToolRegistry,createPcbServer,VERSION} from '../src/server.mjs';
import {editSchema,catalog} from '../src/simple-contract.mjs';
import {createMockEda,runEdit,target} from './fixture.mjs';

const expectedTools=['pcb_list_targets','pcb_open_target','pcb_status','pcb_read','pcb_pick','pcb_edit','pcb_read_constraints','pcb_manage_constraint_group','pcb_compare_associated_netlists','pcb_sync_schematic','pcb_rebuild_pours','pcb_save_and_drc','pcb_audit_geometry','pcb_inspect_silkscreen','pcb_render_svg','pcb_capture_view','pcb_export'];
const schemaFor=name=>z.toJSONSchema(z.object(getToolRegistry().get(name).definition.inputSchema).strict());
const propertyNames=value=>{const names=[];const walk=node=>{if(!node||typeof node!=='object')return;if(node.properties)names.push(...Object.keys(node.properties));for(const child of Object.values(node))walk(child);};walk(value);return names;};

test('single v4 registry contains exactly 17 non-compatibility tools',()=>{
 assert.equal(VERSION,'4.1.0');assert.deepEqual([...getToolRegistry().keys()],expectedTools);assert.equal(getToolRegistry().size,17);createPcbServer();
 for(const removed of ['pcb_execute_plan','pcb_execute_text_plan','pcb_cleanup_components','pcb_inspect_pinmap','pcb_verify_api_gates','pcb_render_inspection_svg','pcb_capture_inspection_view','pcb_capture_snapshot','pcb_compare_snapshots','pcb_realtime_drc'])assert.equal(getToolRegistry().has(removed),false,removed);
});

test('all public schemas remove unit switches and old execution controls',()=>{
 for(const [name]of getToolRegistry()){
  const names=propertyNames(schemaFor(name));
  for(const field of ['units','bridgeUrl','mode','phase','guard','expected','executionId','planPath','snapshot'])assert.equal(names.includes(field),false,`${name}:${field}`);
 }
 const edit=schemaFor('pcb_edit');assert.ok(edit.properties.operations);assert.equal(edit.properties.operations.maxItems,undefined);assert.equal(edit.properties.target.type,'string');
 assert.equal(z.object(editSchema).strict().safeParse({operations:[{op:'place',items:[{ref:'U1',angle:30}]}],units:'mm'}).success,false);
 assert.equal(z.object(editSchema).strict().safeParse({operations:[{op:'place',items:[{ref:'U1',angle:30}]}],target:{documentUuid:'x'}}).success,false);
});

test('operation catalog is v4 and all public geometry is MIL',()=>{
 const value=catalog();assert.equal(value.schema,'easyeda-pcb-edit/v4');assert.equal(value.units,'mil');assert.doesNotMatch(JSON.stringify(value),/millimet|\bmm\b/i);
});

test('arbitrary-angle and right-corner routes pass exact MIL values unchanged',async()=>{
 const environment=createMockEda();const result=await runEdit(environment,[{op:'route',net:'SIG',layer:'top',width:10,items:[{points:[[0,0],[300,173.2],[300,400]]}]}]);
 assert.equal(result.ok,true);assert.equal(environment.stores.line.size,2);const [a,b]=[...environment.stores.line.values()];assert.deepEqual([a.startX,a.startY,a.endX,a.endY,a.lineWidth],[0,0,300,173.2,10]);assert.deepEqual([b.startX,b.startY,b.endX,b.endY],[300,173.2,300,400]);
});

test('same-batch placement resolves route endpoints from the new native pad positions',async()=>{
 const environment=createMockEda();const result=await runEdit(environment,[{op:'place',items:[{ref:'U1',at:[400,320],angle:30,side:'bottom'}]},{op:'route',layer:'bottom',width:8,items:[{from:'U1.1',to:'U2.1',through:[[360,320]]}]}]);
 assert.equal(result.ok,true,JSON.stringify(result));const component=[...environment.stores.component.values()][0],pin=(await environment.eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(component.primitiveId))[0],line=[...environment.stores.line.values()][0];assert.equal(line.startX,pin.x);assert.equal(line.startY,pin.y);assert.equal(line.net,'SIG');assert.equal(component.x,400);assert.equal(component.y,320);assert.equal(component.rotation,30);assert.equal(component.layer,2);
});

test('unspecified component fields retain their current native values',async()=>{
 const environment=createMockEda(),component=[...environment.stores.component.values()][0];component.primitiveLock=true;component.name='KEEP';const result=await runEdit(environment,[{op:'place',items:[{ref:'U1',angle:47}]}]);assert.equal(result.ok,true);assert.equal(component.x,0);assert.equal(component.y,0);assert.equal(component.name,'KEEP');assert.equal(component.primitiveLock,true);assert.equal(component.rotation,47);
});

test('large component and route batches have no small public cap',async()=>{
 const environment=createMockEda(350),operations=[{op:'place',items:Array.from({length:350},(_,index)=>({ref:`U${index+1}`,at:[index*10,50],angle:17}))},{op:'route',net:'SIG',layer:'top',width:4,items:Array.from({length:600},(_,index)=>({points:[[index*2,0],[index*2+1,3]]}))}];
 const result=await runEdit(environment,operations);assert.equal(result.ok,true);assert.equal(result.results.length,950);assert.equal(environment.stores.line.size,600);assert.equal([...environment.stores.component.values()][349].x,3490);
});

test('native false is a failed action while independent following actions continue',async()=>{
 const environment=createMockEda();let calls=0,original=environment.eda.pcb_PrimitiveVia.create;environment.eda.pcb_PrimitiveVia.create=async(...args)=>++calls===1?false:original(...args);
 const result=await runEdit(environment,[{op:'via',positions:[[0,0],[100,100]],net:'GND',diameter:24,holeDiameter:12}]);assert.deepEqual(result.results.map(item=>item.status),['failed','applied']);assert.equal(environment.stores.via.size,1);
});

test('a response lost after a native write becomes unknown and is never replayed',async()=>{
 const environment=createMockEda();let calls=0,original=environment.eda.pcb_PrimitiveVia.create;environment.eda.pcb_PrimitiveVia.create=async(...args)=>{const value=await original(...args);if(++calls===2)throw Error('response lost');return value;};
 const result=await runEdit(environment,[{op:'via',positions:[[0,0],[100,100],[200,200]],net:'GND',diameter:24,holeDiameter:12}]);assert.deepEqual(result.results.map(item=>item.status),['applied','unknown']);assert.equal(environment.stores.via.size,2);assert.equal(result.nextIndex,2);
});

test('native circles, pads, slots, copper and text use exact MIL geometry',async()=>{
 const environment=createMockEda();const result=await runEdit(environment,[{op:'outline',geometry:{type:'circle',center:[2000,2000],diameter:1900}},{op:'region',geometry:{type:'circle',center:[400,400],diameter:240},layer:'multi',ruleTypes:[2,5,6,7,8],name:'MOUNT'},{op:'pad',at:[100,100],number:'1',net:'5V',layer:'top',padShape:{type:'rect',size:[80,40]}},{op:'hole',positions:[[500,500]],diameter:80,length:200,angle:30},{op:'pour',geometry:{type:'rectangle',at:[0,0],size:[1000,1000]},net:'GND',layer:'bottom'},{op:'fill',geometry:{type:'polygon',points:[[0,0],[200,0],[100,100]]},net:'5V',layer:'top'},{op:'text',layer:'top_silkscreen',fontSize:50,width:8,items:[{at:[250,300],text:'TX / RX'}]}]);
 assert.equal(result.ok,true,JSON.stringify(result));const outline=[...environment.stores.polyline.values()].at(-1),source=outline.polygon.getSource();assert.deepEqual(source,['CIRCLE',2000,2000,950]);assert.equal(environment.stores.region.size,1);assert.equal(environment.stores.pad.size,2);assert.equal(environment.stores.pour.size,1);assert.equal(environment.stores.fill.size,1);assert.equal([...environment.stores.string.values()][0].fontSize,50);
});

test('cleanup hides only attached designators and preserves component identity',async()=>{
 const environment=createMockEda(),component=[...environment.stores.component.values()][0];component.primitiveLock=true;environment.add('string',{text:'SIGNAL',layer:3,x:0,y:0,fontSize:50,lineWidth:8});const result=await runEdit(environment,[{op:'cleanup',unlock:true,hideDesignators:true}]);assert.equal(result.ok,true);assert.equal(component.primitiveLock,false);assert.equal(component.designator,'U1');assert.equal(environment.stores.string.size,1);assert.ok([...environment.stores.attribute.values()].every(item=>item.valueVisible===false));
});

test('align, distribute, radial and transform execute caller geometry',async()=>{
 const environment=createMockEda(4);const result=await runEdit(environment,[{op:'align',refs:['U1','U2'],axis:'y',value:200},{op:'distribute',refs:['U1','U2'],axis:'x',start:100,spacing:400},{op:'radial',refs:['U3','U4'],center:[0,0],radius:1000,startAngle:0,stepAngle:90,orientationOffset:15},{op:'transform',select:{refs:['U1','U2']},translate:[100,0]}]);
 assert.equal(result.ok,true);const components=[...environment.stores.component.values()];assert.equal(components[0].x,200);assert.equal(components[1].x,600);assert.equal(components[0].y,200);assert.equal(components[3].rotation,105);
});

test('duplicate designators fail before any native write',async()=>{
 const environment=createMockEda();[...environment.stores.component.values()][1].designator='U1';const result=await runEdit(environment,[{op:'place',items:[{ref:'U1',at:[100,100]}]}]);assert.equal(result.results[0].status,'failed');assert.equal(result.results[0].error.code,'AMBIGUOUS_COMPONENT');assert.equal(environment.calls.length,0);
});

test('exact internal target remains separate from the public document UUID',()=>{assert.equal(target.documentUuid,'pcb-test');assert.equal(schemaFor('pcb_status').properties.target.type,'string');});

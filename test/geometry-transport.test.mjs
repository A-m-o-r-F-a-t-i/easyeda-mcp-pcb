import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGeometryTransport, circularReadbackRequests, verifyCircularCopperReadback } from '../src/geometry-transport.mjs';
import { validatePlan } from '../src/plan.mjs';
import { assertGuardMatchesPlan } from '../src/guarded-plan.mjs';
import { hashObject } from '../src/gateway-client.mjs';

const base=()=>({schema:'easyeda-pcb-plan/v2',intent:'check circle transport',target:{documentUuid:'pcb',projectUuid:'project',windowId:'window'},units:'mm',phase:'route',constraints:{minTrackWidth:.15,minViaHole:.3,minAnnularRing:.15,circularKeepouts:[{name:'screw',center:[0,0],diameter:6}]},operations:[{id:'via-1',type:'via.create',net:'GND',position:[5,0],diameter:.6,holeDiameter:.3}]});
const circles=[{name:'screw',x:0,y:0,radius:3}];

test('geometry transport preserves original circles, operations and prepared hash identity',()=>{
 const raw=base(), before=structuredClone(raw), normalized=validatePlan(raw);
 const transport=prepareGeometryTransport(raw);
 assert.deepEqual(raw,before);
 assert.ok(raw.constraints.circularKeepouts);
 assert.equal(transport.wirePlan.constraints.circularKeepouts,undefined);
 assert.deepEqual(transport.wirePlan.operations,raw.operations);
 assert.deepEqual(validatePlan(transport.wirePlan).operations,normalized.operations);
 assert.equal(transport.enforcement.originalPlanRetained,true);
 const guard={schema:'easyeda-pcb-guard/v1',planSha256:hashObject(raw),target:raw.target};
 assert.doesNotThrow(()=>assertGuardMatchesPlan(guard,raw,normalized));
 assert.throws(()=>assertGuardMatchesPlan(guard,transport.wirePlan,normalized),/plan changed/);
});

test('geometry transport rejects a via inside the circle before producing a wire plan',()=>{
 const raw=base();raw.operations[0].position=[3.2,0];
 assert.throws(()=>prepareGeometryTransport(raw),/circular keepout/);
});

test('geometry transport rejects whole segments crossing the circle with endpoints outside',()=>{
 const raw=base();raw.operations=[{id:'line',type:'line.create',net:'GND',layer:'TOP',start:[-10,0],end:[10,0],width:.2}];
 assert.throws(()=>prepareGeometryTransport(raw),/circular keepout/);
});

test('unknown constraints remain errors rather than being removed for compatibility',()=>{
 const raw=base();raw.constraints.ignoreThisSafetyRule=true;
 assert.throws(()=>prepareGeometryTransport(raw),/unknown field/);
});

test('old-state assertions remain byte-equivalent in native transport',()=>{
 const raw=base();raw.operations=[{id:'via',type:'via.modify',primitiveId:'existing',expected:{net:'GND',x:5,y:0,diameter:.6,holeDiameter:.3,viaType:0,primitiveLock:false},set:{x:6}}];
 const transport=prepareGeometryTransport(raw);
 assert.deepEqual(transport.wirePlan.operations,raw.operations);
});

test('native via intrusion is rejected even after requested geometry passed',()=>{
 assert.throws(()=>verifyCircularCopperReadback(circles,'vias',['v'],[{primitiveId:'v',x:3.2,y:0,diameter:.6}]),/Actual copper intersects/);
});

test('native line width is included and coordinate tolerance does not relax clearance',()=>{
 assert.throws(()=>verifyCircularCopperReadback(circles,'lines',['l'],[{primitiveId:'l',startX:-5,startY:3.09,endX:5,endY:3.09,lineWidth:.2,layer:1}]),/Actual copper intersects/);
 assert.equal(verifyCircularCopperReadback(circles,'lines',['l'],[{primitiveId:'l',startX:-5,startY:3.1,endX:5,endY:3.1,lineWidth:.2,layer:1}]).verified,true);
});

test('missing, duplicate and unknown actual identities cannot pass circular readback',()=>{
 assert.throws(()=>verifyCircularCopperReadback(circles,'vias',['v'],[]),/Missing/);
 assert.throws(()=>verifyCircularCopperReadback(circles,'vias',['v'],[{primitiveId:'other',x:5,y:0,diameter:.6}]),/identity/);
 assert.throws(()=>verifyCircularCopperReadback(circles,'vias',['v','w'],[{primitiveId:'v',x:5,y:0,diameter:.6},{primitiveId:'v',x:6,y:0,diameter:.6}]),/identity/);
});

test('missing actual geometry remains an error',()=>{
 assert.throws(()=>verifyCircularCopperReadback(circles,'vias',['v'],[{primitiveId:'v',x:5,y:0}]),/Incomplete/);
});

test('readback requests include split or merged native IDs without double counting',()=>{
 const ops=[{id:'a',kind:'line',type:'line.create',state:{layer:1}},{id:'b',kind:'line',type:'line.create',state:{layer:1}},{id:'c',kind:'via',type:'via.create'}];
 const results=[{id:'a',verified:true,primitiveIds:['l1','l2']},{id:'b',verified:true,primitiveIds:['l2']},{id:'c',verified:true,primitiveId:'v'}];
 assert.deepEqual(circularReadbackRequests(ops,results),[{kind:'lines',ids:['l1','l2']},{kind:'vias',ids:['v']}]);
});

test('incomplete or unaddressable native result inventory cannot skip checks',()=>{
 const ops=[{id:'a',kind:'via',type:'via.create'}];
 assert.throws(()=>circularReadbackRequests(ops,[]),/Incomplete/);
 assert.throws(()=>circularReadbackRequests(ops,[{id:'b',verified:true,primitiveId:'v'}]),/identity/);
 assert.throws(()=>circularReadbackRequests(ops,[{id:'a',verified:true}]),/addressable/);
});

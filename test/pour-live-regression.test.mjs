import test from 'node:test';
import assert from 'node:assert/strict';
import {batchRuntime} from '../src/runtime.mjs';
const target={documentUuid:'pcb',projectUuid:'project'};
const shape=[0,0,'L',100,0,100,100,0,100,0,0];
const state={net:'GND',layer:1,pourName:'TEST',pourPriority:5,lineWidth:0.2,preserveSilos:true,primitiveLock:false};
function fixture(source=[100,100,'L',100,0,0,0,0,100,100,100]){
  let rows=[{primitiveId:'p1',...state,complexPolygon:source}],writes=0;
  const eda={dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'pcb',documentType:3})},dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'project'})},sys_Environment:{getEditorCurrentVersion:async()=> '3.2.186'},pcb_PrimitivePour:{getAll:async()=>rows,get:async id=>({primitiveId:id,...state,complexPolygon:source}),delete:async()=>{rows=[];writes++;return true},create:async()=>{writes++;return rows[0]},modify:async()=>{writes++;return rows[0]}}};
  return {eda,writes:()=>writes};
}
const create=(patch={})=>{const {pourPriority,...nativeState}=state;return {id:'create',type:'pour.create',kind:'pour',priorityPolicy:'native',state:{...nativeState,...patch},polygon:shape};};
test('P201 cyclic start and opposite winding represent the same explicit ring',async()=>{const f=fixture();const r=await batchRuntime(f.eda,{target,operations:[create()]});assert.equal(r.ok,true);assert.equal(r.results[0].status,'already_exists');assert.equal(f.writes(),0)});
test('P202 equal bounding box but altered interior vertex is not the same ring',async()=>{const f=fixture([0,0,'L',100,0,50,50,0,100,0,0]);const r=await batchRuntime(f.eda,{target,operations:[create()]});assert.equal(r.ok,false);assert.equal(f.writes(),0)});
test('P203 client ignored nondefault pour properties fail before create',async()=>{const f=fixture();const r=await batchRuntime(f.eda,{target,operations:[create({pourPriority:1,lineWidth:1})]});assert.equal(r.ok,false);assert.match(r.error.message,/No write performed/);assert.equal(f.writes(),0)});
test('P204 client ignored nondefault property update fails before modify',async()=>{const f=fixture();const r=await batchRuntime(f.eda,{target,operations:[{id:'modify',kind:'pour',type:'pour.modify',primitiveId:'p1',expected:state,set:{pourPriority:1}}]});assert.equal(r.ok,false);assert.equal(f.writes(),0)});
test('P205 scalar get placeholder cannot cause a false failed-delete result',async()=>{const f=fixture();const r=await batchRuntime(f.eda,{target,operations:[{id:'delete',kind:'pour',type:'pour.delete',primitiveId:'p1',expected:state}]});assert.equal(r.ok,true);assert.equal(r.results[0].status,'deleted');assert.equal(f.writes(),1)});
test('P206 curved or compound unknown polygon syntax is not silently equated',async()=>{const f=fixture([0,0,'Q',100,0,100,100,0,100,0,0]);const r=await batchRuntime(f.eda,{target,operations:[create()]});assert.equal(r.ok,false);assert.equal(f.writes(),0)});

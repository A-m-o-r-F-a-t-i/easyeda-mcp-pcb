import test from 'node:test';
import assert from 'node:assert/strict';
import {auditGeometry} from '../src/audit.mjs';
import {analyzeConnectivity} from '../src/connectivity.mjs';
import {inspectGroupQuality} from '../src/group-quality.mjs';
import {parseDsnScene} from '../src/dsn.mjs';
import {DRC_JOB_REGISTRY_KEY,buildDrcStartCode,buildDrcStatusCode,waitForDrcJob} from '../src/drc-job.mjs';
import {constraintRuntime,pickRuntime,simpleReadRuntime} from '../src/simple-utilities.mjs';
import {createNativeHelpers} from '../src/simple-native.mjs';
import {createMockEda,target} from './fixture.mjs';

const snapshot=()=>({
 units:'mil',
 lines:[{primitiveId:'l1',net:'N',layer:1,startX:0,startY:0,endX:100,endY:0,lineWidth:10},{primitiveId:'l2',net:'N',layer:1,startX:100,startY:0,endX:200,endY:0,lineWidth:10}],
 arcs:[],vias:[],fills:[],poured:[],regions:[],
 pads:[{primitiveId:'p1',net:'N',layer:1,x:0,y:0,rotation:0,pad:['RECT',20,20,0],hole:null,metallization:true,padNumber:'1'},{primitiveId:'p2',net:'N',layer:1,x:200,y:0,rotation:0,pad:['RECT',20,20,0],hole:null,metallization:true,padNumber:'2'}],
 coverage:{observedExcludedCounts:{arcs:0,fills:0,poured:0,regions:0}}
});

test('geometry audit uses MIL fields only and rejects metric snapshots',()=>{
 const report=auditGeometry(snapshot());assert.equal(report.units,'mil');assert.equal(report.toleranceMil,0.02);assert.equal(report.netStatistics[0].segmentLengthSumMil,200);assert.equal(report.counts.non45Segments,0);assert.equal(report.verdict,'NO_FINDINGS_IN_CHECKED_SCOPE');assert.throws(()=>auditGeometry({...snapshot(),units:'mm'}),/mil snapshot/);
});

test('modeled connectivity uses MIL tolerance and finds one connected net',()=>{
 const report=analyzeConnectivity(snapshot(),{toleranceMil:0.02});assert.equal(report.units,'mil');assert.equal(report.toleranceMil,0.02);assert.equal(report.connectivityVerdict,'CONNECTED_WITHIN_COVERAGE');assert.equal(report.modeledSplitPadNetCount,0);assert.equal(report.netCount,1);
});

test('functional group metrics expose MIL lengths and pad-pair distance',()=>{
 const report=inspectGroupQuality(snapshot(),{groups:[{name:'critical',nets:['N'],pairs:[{fromPadId:'p1',toPadId:'p2',maxDistanceMil:250}],maxViaCount:0}]});const group=report.groups[0];assert.equal(report.units,'mil');assert.equal(group.totals.straightLengthMil,200);assert.equal(group.pairs[0].distanceMil,200);assert.equal(group.state,'METRICS_AVAILABLE');assert.equal('straightLengthMm' in group.totals,false);
});

test('DSN source units are normalized to a MIL-only scene',()=>{
 const dsn=`(pcb TEST
 (unit mm)(resolution mm 1000)
 (structure (layer Top (type signal)) (boundary (path Top 0.1 0 0 25.4 0 25.4 12.7 0 12.7 0 0)))
 (placement (component IMG (place U1 2.54 5.08 front 0)))
 (library (padstack P1 (shape (circle Top 1.27))) (image IMG (pin P1 1 0 0)))
 (network (net N (pins U1-1)))
 (wiring (wire (path Top 0.254 0 0 25.4 0) (net N)) (via P1 12.7 6.35 (net N))))`;
 const scene=parseDsnScene(dsn);assert.equal(scene.schema,'easyeda-route-scene/v4');assert.equal(scene.units,'mil');assert.equal(scene.sourceUnits,'mm');assert.equal(scene.components[0].x,100);assert.equal(scene.components[0].y,200);assert.equal(scene.tracks[0].width,10);assert.equal(scene.tracks[0].end[0],1000);assert.equal(scene.vias[0].x,500);
});

test('constraint read and mutation use one direct runtime without guards',async()=>{
 const environment=createMockEda();const read=await constraintRuntime(environment.eda,{target,action:'read'},createNativeHelpers);assert.equal(read.ok,true);assert.deepEqual(read.netClasses,[]);
 const created=await constraintRuntime(environment.eda,{target,action:'manage',operation:{groupType:'netClass',action:'create',name:'POWER',nets:['5V','GND']}},createNativeHelpers);assert.equal(created.ok,true);assert.equal(created.after.name,'POWER');assert.deepEqual(created.after.nets,['5V','GND']);
 const renamed=await constraintRuntime(environment.eda,{target,action:'manage',operation:{groupType:'netClass',action:'rename',name:'POWER',newName:'PWR'}},createNativeHelpers);assert.equal(renamed.after.name,'PWR');
});

test('MIL point and rectangle picking return native objects',async()=>{
 const environment=createMockEda(),component=[...environment.stores.component.values()][0];component.x=120;component.y=140;
 const pointResult=await pickRuntime(environment.eda,{target,point:[120,140]},createNativeHelpers);assert.equal(pointResult.units,'mil');assert.ok(pointResult.items.some(item=>item.designator==='U1'));
 const regionResult=await pickRuntime(environment.eda,{target,region:{left:100,right:150,top:100,bottom:160},offset:0,limit:20},createNativeHelpers);assert.ok(regionResult.items.some(item=>item.designator==='U1'));
});

test('raw object read advertises MIL and never accepts a unit selector',async()=>{
 const environment=createMockEda(),result=await simpleReadRuntime(environment.eda,{target,kind:'components'},createNativeHelpers);assert.equal(result.units,'mil');assert.equal(result.total,2);
});

test('DRC job registry has one unversioned identity and supports polling continuation',async()=>{
 assert.equal(DRC_JOB_REGISTRY_KEY,'__easyedaPcbDrcJobs');const start=buildDrcStartCode({target,jobId:'job-1'}),status=buildDrcStatusCode({target,jobId:'job-1',offset:0,limit:10,release:false});assert.doesNotMatch(start,/V1|legacy|compat/i);assert.doesNotMatch(status,/V1|legacy|compat/i);
 let polls=0;const result=await waitForDrcJob({initial:{state:'RUNNING'},poll:async()=>++polls<2?{state:'RUNNING'}:{state:'COMPLETED',report:{verified:true}},waitMs:1000,pollIntervalMs:100});assert.equal(result.state,'COMPLETED');assert.equal(polls,2);
});

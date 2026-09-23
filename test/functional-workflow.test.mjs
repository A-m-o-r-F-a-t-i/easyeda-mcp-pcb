import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../src/plan.mjs';
import { preflightGeometry, assertPreflightClear } from '../src/copper-preflight.mjs';
import { buildExplicitPlan, buildRemainingPlan, verifiedContiguousPrefix, executionLedger } from '../src/plan-workflow.mjs';
import { inspectGroupQuality } from '../src/group-quality.mjs';
import { batchRuntime } from '../src/runtime.mjs';
import { runPlan } from '../src/guarded-plan.mjs';
import { invokeRegisteredTool, getToolRegistry } from '../src/server.mjs';
import { hashObject } from '../src/gateway-client.mjs';

const target={windowId:'fixture-window',projectUuid:'fixture-project',documentUuid:'fixture-pcb'};
const bridgeUrl='http://127.0.0.1:49620';
const rawPlan=(operations,extra={})=>({schema:'easyeda-pcb-plan/v2',intent:'Functional workflow regression',target,units:'mil',phase:'route',constraints:{allowedLayers:['TOP','BOTTOM'],minClearance:2,minHoleClearance:4},operations,...extra});
const line=(id,y=0)=>({id,type:'line.create',net:'SIG',layer:'TOP',start:[0,y],end:[20,y],width:2});
const snapshot=(extra={})=>({units:'mil',lines:[],arcs:[],fills:[],vias:[],pads:[],components:[],...extra});
const nativeLine=(primitiveId,net,startX,startY,endX,endY)=>({primitiveId,net,layer:1,startX,startY,endX,endY,lineWidth:2,primitiveLock:false});
const pad=(primitiveId,x,net='SIG',extra={})=>({primitiveId,padNumber:primitiveId,net,layer:1,x,y:0,rotation:0,pad:['ELLIPSE',4,4],hole:null,holeOffsetX:0,holeOffsetY:0,holeRotation:0,metallization:true,padType:0,primitiveLock:false,...extra});

function fixture(t,initial={},options={}) {
  const data=snapshot(structuredClone(initial));let epoch=1,writes=0,saves=0,batchCalls=0,rpcWrites=0,lost=false;const generationId='fixture-generation',bridgeGenerationId='fixture-bridge';
  const sourceHash=()=>hashObject(data), oldFetch=globalThis.fetch;
  const expected=()=>({generationId,bridgeGenerationId,changeEpoch:epoch,sourceHash:sourceHash(),eventCoverage:'partial'});
  const eda={
    dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:target.documentUuid,documentType:3,tabId:'fixture-tab'})},
    dmt_Project:{getCurrentProjectInfo:async()=>({uuid:target.projectUuid})},
    sys_Environment:{getEditorCurrentVersion:async()=> '4.1.60'},
    pcb_Layer:{getAllLayers:async()=>[{id:1},{id:2}]},
    pcb_MathPolygon:{createPolygon:source=>source},
  };
  const apiFor={lines:'pcb_PrimitiveLine',arcs:'pcb_PrimitiveArc',fills:'pcb_PrimitiveFill',vias:'pcb_PrimitiveVia',pads:'pcb_PrimitivePad',components:'pcb_PrimitiveComponent',pours:'pcb_PrimitivePour',polylines:'pcb_PrimitivePolyline'};
  for(const [key,apiName] of Object.entries(apiFor)){
    data[key]??=[];
    eda[apiName]={getAll:async()=>structuredClone(data[key]),get:async id=>Array.isArray(id)?data[key].filter(item=>id.includes(item.primitiveId)):structuredClone(data[key].find(item=>item.primitiveId===id)),delete:async id=>{writes++;epoch++;data[key]=data[key].filter(item=>item.primitiveId!==id);},modify:async(id,set)=>{writes++;epoch++;const item=data[key].find(item=>item.primitiveId===id);Object.assign(item,set);return structuredClone(item);}};
  }
  eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId=async id=>data.pads.filter(p=>p.parentPrimitiveId===id);
  eda.pcb_PrimitiveLine.create=async(net,layer,startX,startY,endX,endY,lineWidth,primitiveLock)=>{writes++;epoch++;const item={primitiveId:`line-${writes}`,net,layer,startX,startY,endX,endY,lineWidth,primitiveLock};data.lines.push(item);return item;};
  eda.pcb_PrimitiveVia.create=async(net,x,y,holeDiameter,diameter,viaType,_a,_b,primitiveLock)=>{writes++;epoch++;const item={primitiveId:`via-${writes}`,net,x,y,holeDiameter,diameter,viaType,primitiveLock};data.vias.push(item);return item;};
  const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  globalThis.fetch=async(url,request={})=>{
    if(String(url).endsWith('/health'))return response({service:'easyeda-bridge',edaConnected:true,bridgeVersion:'fixture',bridgeGenerationId,protocolVersions:[2]});
    if(String(url).endsWith('/eda-windows'))return response({windows:[{windowId:target.windowId,connected:true,protocolVersions:[2],gatewayVersion:'fixture'}]});
    const body=JSON.parse(request.body??'{}');
    if(String(url).endsWith('/execute')){
      const isBatch=body.code.startsWith('return await (async function batchRuntime');if(isBatch)batchCalls++;
      const result=await new (Object.getPrototypeOf(async function(){}).constructor)('eda',body.code)(eda);
      if(isBatch&&options.loseFirstBatchResponse&&!lost){lost=true;return response({error:{code:'REQUEST_TIMEOUT',message:'fixture response lost after native writes'}},504);}
      return response({success:true,windowId:target.windowId,result});
    }
    if(!String(url).endsWith('/rpc'))throw new Error('Unexpected fixture URL '+url);
    if(body.expected){if(Object.keys(body.expected).some(key=>!['generationId','bridgeGenerationId','changeEpoch','sourceHash'].includes(key)))return response({error:{code:'INVALID_REQUEST',message:'expected contains unknown fields'}},400);const current=expected();for(const key of ['generationId','bridgeGenerationId','changeEpoch','sourceHash'])if(body.expected[key]!==undefined&&body.expected[key]!==current[key])return response({error:{code:'EPOCH_MISMATCH',message:'fixture guard mismatch'}},409);}
    let result;
    if(body.operation==='target.inspect')result={...target,tabId:'fixture-tab'};
    else if(body.operation==='events.getState'){
      if(options.failFinalGuard&&saves>0)return response({error:{code:'CONCURRENT_CHANGE',message:'fixture final-state uncertainty'}},409);
      result={generationId,changeEpoch:epoch,eventCoverage:'partial'};
    }else if(body.operation==='document.sourceHash')result={sha256:sourceHash()};
    else if(body.operation==='system.capabilities')result={clientVersion:'4.1.60'};
    else if(body.operation==='pcb.save'){saves++;rpcWrites++;epoch++;result={saved:options.saveFalse!==true,sourceAfter:{sha256:sourceHash()}};}
    else if(body.operation==='pcb.read'){
      const r=body.arguments.request;if(r.kind==='snapshot'){result={units:'mil',...Object.fromEntries(r.include.map(k=>[k,data[k]]))};}else throw new Error('Unexpected read '+r.kind);
    }else throw new Error('Unexpected fixture RPC '+body.operation);
    return response({success:true,operation:body.operation,windowId:target.windowId,bridgeGenerationId,result,state:{documentUuid:target.documentUuid,generationId,changeEpoch:epoch,changeEpochAfter:epoch,sourceHash:sourceHash()}});
  };
  t.after(()=>{globalThis.fetch=oldFetch;});
  return {data,eda,expected,counters:()=>({writes,saves,batchCalls,rpcWrites})};
}

test('FW01 prepare rejects a later copper conflict before the first native mutation',async t=>{
  const f=fixture(t,{lines:[nativeLine('obstacle','GND',10,0,10,20)]});
  const plan=rawPlan([line('early-safe',100),line('late-conflict',10)]);
  await assert.rejects(runPlan({plan},{mode:'prepare',bridgeUrl}),e=>e.code==='COPPER_CLEARANCE_BLOCKED'&&e.details.wrotePCB===false);
  assert.equal(f.counters().writes,0);assert.equal(f.counters().saves,0);assert.equal(f.counters().batchCalls,0);
});
test('FW02 fabricated/uncached guard cannot skip execute preflight',async t=>{
  const f=fixture(t,{lines:[nativeLine('obstacle','GND',10,0,10,20)]}),plan=rawPlan([line('safe',100),line('conflict',10)]);
  const guard={schema:'easyeda-pcb-guard/v1',planSha256:hashObject(plan),target,expected:f.expected()};
  await assert.rejects(runPlan({plan},{mode:'execute',guard,bridgeUrl}),e=>e.code==='COPPER_CLEARANCE_BLOCKED');
  assert.equal(f.counters().writes,0);
});
test('FW03 identical-net copper is allowed but independent drill clearance remains mandatory',()=>{
  const oldVia={primitiveId:'old',net:'GND',x:0,y:0,holeDiameter:8,diameter:16,viaType:0};
  const plan=validatePlan(rawPlan([{id:'near',type:'via.create',net:'GND',position:[10,0],holeDiameter:8,diameter:16}]));
  const report=preflightGeometry(plan,snapshot({vias:[oldVia]}));
  assert.ok(report.findings.some(f=>f.code==='DRILL_CLEARANCE_BLOCKED'));assert.throws(()=>assertPreflightClear(report));
  const repeated=validatePlan(rawPlan([{id:'existing',type:'via.create',net:'GND',position:[0,0],holeDiameter:8,diameter:16}]));
  assert.equal(preflightGeometry(repeated,snapshot({vias:[oldVia]})).blockingCount,0);
});
test('FW04 same-net via cannot invade a component pad',()=>{
  const plan=validatePlan(rawPlan([{id:'via',type:'via.create',net:'SIG',position:[0,0],holeDiameter:2,diameter:4}]));
  const report=preflightGeometry(plan,snapshot({pads:[pad('p1',0,'SIG',{parentPrimitiveId:'component'})],components:[{primitiveId:'component',x:0,y:0,layer:1,rotation:0}]}));
  assert.ok(report.findings.some(f=>f.code==='PAD_OVERLAP_BLOCKED'));
});
test('FW05 modeled inventory exclusions cannot silently become clear',()=>{
  assert.throws(()=>preflightGeometry(validatePlan(rawPlan([line('x')])),snapshot({coverage:{excluded:['arcs']}})),/complete modeled copper/);
});
test('FW06 pure lines use the same verified adapter and complete ledger as mixed geometry',async t=>{
  const f=fixture(t),plan=rawPlan([line('a',0),line('b',10)]);
  const p=await runPlan({plan},{mode:'prepare',bridgeUrl});
  const r=await runPlan({plan},{mode:'execute',guard:p.guard,bridgeUrl});
  assert.equal(r.completedOperationCount,2);assert.equal(r.executionLedger.counts.VERIFIED,2);assert.equal(r.executionLedger.saveState,'SAVED');
  assert.equal(r.execution.operations[0].operation,'pcb.geometryLegacy');assert.equal(f.counters().writes,2);
});
test('FW07 lost response reconciles applied prefix and shrinks only the pending remainder',async t=>{
  const f=fixture(t,{}, {loseFirstBatchResponse:true});
  const plan=rawPlan([line('a',0),line('b',10),line('c',20)],{options:{batchSize:2}});
  const prepared=await runPlan({plan},{mode:'prepare',bridgeUrl});
  await assert.rejects(runPlan({plan},{mode:'execute',guard:prepared.guard,bridgeUrl}),e=>e.code==='REQUEST_TIMEOUT'&&e.details.executionLedger.counts.OUTCOME_UNKNOWN===2&&e.details.executionLedger.counts.NOT_EXECUTED===1);
  assert.equal(f.counters().writes,2);
  const result=await runPlan({plan},{mode:'reconcile',bridgeUrl});
  assert.equal(result.appliedCount,2);assert.equal(result.remainingPlan.operations.length,1);assert.equal(result.remainingPlan.operations[0].id,'c');
  assert.equal(result.remainingPlan.options.batchSize,1);assert.equal(result.adaptiveBatch.reason,'REQUEST_TIMEOUT');assert.equal(f.counters().writes,2);
  const next=await runPlan({plan:result.remainingPlan},{mode:'prepare',bridgeUrl});
  await runPlan({plan:result.remainingPlan},{mode:'execute',guard:next.guard,bridgeUrl});
  assert.equal(f.counters().writes,3);
});
test('FW08 a false save acknowledgement does not erase verified geometry or claim saved',async t=>{
  const f=fixture(t,{}, {saveFalse:true}),plan=rawPlan([line('a')]);
  const p=await runPlan({plan},{mode:'prepare',bridgeUrl});
  await assert.rejects(runPlan({plan},{mode:'execute',guard:p.guard,bridgeUrl}),e=>e.code==='SAVE_NOT_ACKNOWLEDGED'&&e.details.confirmedPlanOperations.length===1&&e.details.executionLedger.saveState==='UNKNOWN_OR_PARTIAL');
  assert.equal(f.counters().writes,1);
});
test('FW09 final-state uncertainty retains completed operation receipts and forbids replay',async t=>{
  const f=fixture(t,{}, {failFinalGuard:true}),plan=rawPlan([line('a')]);
  const p=await runPlan({plan},{mode:'prepare',bridgeUrl});
  await assert.rejects(runPlan({plan},{mode:'execute',guard:p.guard,bridgeUrl}),e=>e.code==='CONCURRENT_CHANGE'&&e.details.finalStateVerified===false&&e.details.confirmedPlanOperations.length===1&&e.details.executionLedger.replayAllowed===false);
  assert.equal(f.counters().writes,1);
});
test('FW10 registered build mode fills native old fields and exact affected nets without writing',async t=>{
  const f=fixture(t,{components:[{primitiveId:'c1',x:100,y:100,rotation:0,layer:1,primitiveLock:false}],pads:[pad('p1',100,'SIG',{parentPrimitiveId:'c1'}),pad('p10',0,'OTHER',{parentPrimitiveId:'c10'})]});
  const input={intent:'Explicit component placement',target,units:'mm',operations:[{id:'move',type:'component.modify',primitiveId:'c1',set:{x:10,y:10},copperPolicy:'replan'}]};
  const result=await invokeRegisteredTool('pcb_execute_plan',{plan:input,mode:'build',bridgeUrl});
  assert.equal(result.isError,undefined);assert.deepEqual(result.structuredContent.plan.operations[0].affectedNets,['SIG']);
  assert.equal(result.structuredContent.plan.operations[0].expected.x,2.54);assert.equal(f.counters().writes,0);
});
test('FW11 builder preserves caller assertions, includes fillMode and does not invent native geometry',()=>{
  const input={intent:'Update fill',target,units:'mil',operations:[{id:'f',type:'fill.modify',primitiveId:'fill',set:{lineWidth:0.3},expected:{net:'ASSERTED'}}]};
  const data=snapshot({fills:[{primitiveId:'fill',net:'ACTUAL',layer:1,fillMode:0,lineWidth:0.2,complexPolygon:[0,0,'L',10,0,10,10,0,0]}]});
  const result=buildExplicitPlan(input,data);assert.equal(result.plan.operations[0].expected.net,'ASSERTED');assert.equal(result.plan.operations[0].expected.fillMode,0);
  delete data.fills[0].fillMode;assert.throws(()=>buildExplicitPlan(input,data),/required native old-state field/);
});
test('FW12 malformed fields, repeated keepout names and relative paths fail before Bridge access',async()=>{
  let fetches=0;const old=globalThis.fetch;globalThis.fetch=async()=>{fetches++;throw Error('must not connect');};
  try{
    await assert.rejects(runPlan({planPath:'relative-plan.json'},{mode:'prepare',bridgeUrl}),/absolute path/);
    await assert.rejects(runPlan({plan:rawPlan([line('a')],{phase:'ROUTING'})},{mode:'prepare',bridgeUrl}),/Explicit phase/);
    const plan=rawPlan([line('a')]);plan.constraints.circularKeepouts=[{name:'x',center:[100,100],diameter:2},{name:'x',center:[200,100],diameter:2}];
    await assert.rejects(runPlan({plan},{mode:'prepare',bridgeUrl}),/Duplicate circular keepout/);assert.equal(fetches,0);
  }finally{globalThis.fetch=old;}
});
test('FW13 merged collinear native line covers short expanded segments without duplicate writes',async t=>{
  const f=fixture(t,{lines:[nativeLine('merged','SIG',0,0,10.1,0)]});
  const raw=rawPlan([{id:'route',type:'route.create',net:'SIG',layer:'TOP',points:[[0,0],[10,0],[10.1,0],[20,0]],width:2}]);
  const normalized=validatePlan(raw),result=await batchRuntime(f.eda,{target,mode:'reconcile',operations:normalized.operations});
  assert.deepEqual(result.results.map(r=>r.disposition),['APPLIED','APPLIED','PENDING']);
  const remaining=buildRemainingPlan(raw,normalized,result.results);assert.equal(remaining.remainingPlan.operations[0].id,'route#3');assert.equal(f.counters().writes,0);
  f.data.lines[0].net='sig';const different=await batchRuntime(f.eda,{target,mode:'reconcile',operations:normalized.operations});assert.ok(different.results.every(r=>r.disposition==='PENDING'));
});
test('FW14 changed delete identity is conflict rather than permission to delete replacement copper',async t=>{
  const actual=nativeLine('id','SIG',0,0,20,0),f=fixture(t,{lines:[actual]});
  const raw=rawPlan([{id:'delete',type:'line.delete',primitiveId:'id',expected:{...actual,primitiveId:undefined}}]);delete raw.operations[0].expected.primitiveId;
  const normalized=validatePlan(raw);f.data.lines[0].endX=30;
  const result=await batchRuntime(f.eda,{target,mode:'reconcile',operations:normalized.operations});
  assert.equal(result.results[0].disposition,'CONFLICT');assert.equal(buildRemainingPlan(raw,normalized,result.results).remainingPlan,null);assert.equal(f.counters().writes,0);
});
test('FW15 reordered or unverified responses never become a verified contiguous prefix',()=>{
  const operations=[{id:'a'},{id:'b'}];assert.deepEqual(verifiedContiguousPrefix(operations,[{id:'b',verified:true}]),[]);
  assert.equal(verifiedContiguousPrefix(operations,[{id:'a',verified:true},{id:'b',verified:false}]).length,1);
  const ledger=executionLedger({operations},[],['a'],['a']);assert.equal(ledger.operations[0].state,'APPLIED_NEEDS_RECONCILE');assert.equal(ledger.operations[1].state,'NOT_EXECUTED');
});
test('FW16 group metrics preserve exact network case, missing endpoints and trace-versus-path meaning',async()=>{
  const data=snapshot({lines:[nativeLine('line','SPI_CSn',0,0,100,0)],pads:[pad('a',0,'SPI_CSn'),pad('b',100,'SPI_CSn')]});
  const result=await invokeRegisteredTool('pcb_audit_geometry',{snapshot:data,checks:['groupQuality'],groups:[{name:'SPI',nets:['SPI_CSn','SPI_CSN'],pairs:[{fromPadId:'a',toPadId:'b'},{fromPadId:'a',toPadId:'missing'}]}]});
  const q=result.structuredContent.groupQuality,g=q.groups[0];assert.equal(g.totals.straightLengthMm,2.54);assert.equal(g.pairs[0].distanceMm,2.54);assert.equal(g.pairs[1].distanceMm,null);
  assert.deepEqual(g.missingNets,['SPI_CSN']);assert.equal(g.nets[1].straightLengthMm,null);assert.match(q.meaning,/not pad-to-pad routed paths/);assert.equal(getToolRegistry().size,21);
});
test('FW17 group totals separate power vias, plated terminals and reference-layer occupation',()=>{
  const data=snapshot({lines:[{...nativeLine('reftrace','PHASE',0,0,100,0),layer:16}],pads:[pad('terminal',100,'PHASE',{layer:12,hole:['ROUND',2]})],vias:[{primitiveId:'v',net:'PHASE',x:50,y:0,viaType:0,diameter:4,holeDiameter:2}]});
  const g=inspectGroupQuality(data,{groups:[{name:'power',role:'power',nets:['PHASE'],maxViaCount:0,region:{minX:0,maxX:60,minY:-20,maxY:20}}],referenceLayers:[{layer:16,net:'GND'}],detailLimit:0}).groups[0];
  assert.equal(g.totals.viaCount,1);assert.equal(g.totals.drilledPadCount,1);assert.equal(g.referenceLayerOccupation.count,1);assert.equal(g.referenceLayerOccupation.continuity,'NOT_EVALUATED');assert.equal(g.outsideRegion.count,2);assert.equal(g.detailsTruncated,true);
});
test('FW18 explicit pair budget is review evidence, not a fabricated universal length limit',()=>{
  const data=snapshot({pads:[pad('a',0),pad('b',100)]});
  const report=inspectGroupQuality(data,{groups:[{name:'ADC',nets:['SIG'],pairs:[{fromPadId:'a',toPadId:'b',maxDistanceMm:1}]}]});
  assert.ok(report.groups[0].reviewReasons.some(x=>x.code==='PAIR_DISTANCE_BUDGET_EXCEEDED'));assert.equal(report.engineeringRelease,'NOT_EVALUATED');
});
test('FW19 component layer changes cannot share a plan with copper based on stale pads',()=>{
  const component={primitiveId:'c',x:0,y:0,rotation:0,layer:1,primitiveLock:false};
  const plan=validatePlan(rawPlan([{id:'flip',type:'component.modify',primitiveId:'c',expected:{x:0,y:0,rotation:0,layer:1},set:{layer:'BOTTOM'},copperPolicy:'replan',affectedNets:['SIG']},line('route',100)],{phase:'relayout'}));
  const report=preflightGeometry(plan,snapshot({components:[component],pads:[pad('p',0,'SIG',{parentPrimitiveId:'c'})]}));
  assert.ok(report.findings.some(f=>f.code==='LAYER_FLIP_REQUIRES_NEW_PADS'));
});
test('FW20 group missing inventory and duplicate identities stay errors, not zero metrics',()=>{
  const data=snapshot();delete data.vias;assert.throws(()=>inspectGroupQuality(data,{groups:[{name:'g',nets:['SIG']}]}),/complete vias/);
  assert.throws(()=>inspectGroupQuality(snapshot({pads:[pad('p',0),pad('p',10)]}),{groups:[{name:'g',nets:['SIG']}]}),/duplicate/);
});

test('FW21 arc statistics retain exact circular length separately from straight copper',()=>{
  const data=snapshot({arcs:[{primitiveId:'arc',net:'SIG',layer:1,startX:0,startY:0,endX:20,endY:0,arcAngle:180,lineWidth:2,interactiveMode:0}]});
  const report=inspectGroupQuality(data,{groups:[{name:'arc',nets:['SIG']}]}).groups[0];
  assert.equal(report.totals.straightLengthMm,0);assert.ok(Math.abs(report.totals.arcLengthMm-Math.PI*10*0.0254)<1e-12);
});
test('FW22 missing native old-state assertion blocks preflight instead of deferring failure after writes',()=>{
  const value=nativeLine('old','SIG',0,0,20,0);delete value.lineWidth;
  const plan=validatePlan(rawPlan([{id:'modify',type:'line.modify',primitiveId:'old',expected:{net:'SIG',layer:1,startX:0,startY:0,endX:20,endY:0,lineWidth:2},set:{lineWidth:3}}]));
  const report=preflightGeometry(plan,snapshot({lines:[value]}));assert.ok(report.blockingCount>0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBridge } from '../src/bridge.mjs';
import { textBatchRuntime } from '../src/text-runtime.mjs';
import { pcbToolsRuntime } from '../src/pcb-tools-runtime.mjs';
import { constraintRuntime } from '../src/constraint-runtime.mjs';

const target={documentUuid:'lab-pcb',projectUuid:'lab-project',windowId:'lab-window'};
const state={layer:3,x:10,y:20,text:'LAB',fontFamily:'default',fontSize:48,lineWidth:7,alignMode:5,rotation:0,reverse:false,expansion:0,mirror:false,primitiveLock:false};
function base(){
 let document={uuid:target.documentUuid,documentType:3}; let writes=0;
 const project={uuid:target.projectUuid,name:'LAB',data:[{name:'B',pcb:{uuid:target.documentUuid},schematic:{uuid:'lab-sch',page:[]}}]};
 const eda={dmt_SelectControl:{getCurrentDocumentInfo:async()=>document},dmt_Project:{getCurrentProjectInfo:async()=>project}};
 return {eda,switch:()=>{document={uuid:'protected-pcb',documentType:3}},write:()=>{writes++;return true},writes:()=>writes};
}
async function withBridge(windows,fn){
 const original=globalThis.fetch;
 globalThis.fetch=async url=>new Response(JSON.stringify(String(url).endsWith('/health')?{service:'easyeda-bridge',edaConnected:true,edaWindowCount:windows.length,activeWindowId:windows[0]?.windowId}:{windows,count:windows.length,activeWindowId:windows[0]?.windowId}),{status:200});
 try{return await fn()}finally{globalThis.fetch=original}
}
test('I01 multiple windows never inherit the shared active window',async()=>{
 await withBridge([{windowId:'production',connected:true},{windowId:'lab',connected:true}],()=>assert.rejects(resolveBridge({bridgeUrl:'http://127.0.0.1:49620'}),/windowId.*required|Multiple EasyEDA/i));
});
test('I02 stale explicit window fails discovery instead of falling back',async()=>{
 await withBridge([{windowId:'production',connected:true}],()=>assert.rejects(resolveBridge({bridgeUrl:'http://127.0.0.1:49620',windowId:'missing'}),/window.*not.*connected|unknown.*window/i));
});
test('I03 document switch during string preflight prevents create',async()=>{
 const f=base();f.eda.pcb_PrimitiveString={getAll:async()=>{f.switch();return []},create:async()=>{f.write();return null}};
 const r=await textBatchRuntime(f.eda,{target,operations:[{id:'x',kind:'string',type:'string.create',state}]});
 assert.equal(r.ok,false);assert.equal(f.writes(),0);
});
test('I04 real-time DRC false result is an operational failure',async()=>{
 const f=base();f.eda.pcb_Drc={getRealTimeDrcStatus:async()=>false,startRealTimeDrc:async()=>false};
 await assert.rejects(pcbToolsRuntime(f.eda,{target,kind:'realTimeDrc',action:'start'}),/DRC.*false|DRC.*failed/i);
});
test('I05 real-time DRC success return with unchanged state is not verified',async()=>{
 const f=base();f.eda.pcb_Drc={getRealTimeDrcStatus:async()=>false,startRealTimeDrc:async()=>true};
 await assert.rejects(pcbToolsRuntime(f.eda,{target,kind:'realTimeDrc',action:'start'}),/DRC.*readback|DRC.*state/i);
});
test('I06 constraint mutation rechecks target after reading groups',async()=>{
 const f=base();f.eda.pcb_Drc={getAllNetClasses:async()=>{f.switch();return []},createNetClass:async()=>f.write()};
 await assert.rejects(constraintRuntime(f.eda,{target,kind:'manage',operation:{action:'create',groupType:'netClass',name:'LAB',expected:null,definition:{nets:['GND'],color:{r:1,g:2,b:3,alpha:1}}}}),/document/);
 assert.equal(f.writes(),0);
});
test('I07 repour rechecks target after reading existing fills',async()=>{
 const f=base();f.eda.pcb_PrimitivePour={getAll:async()=>[{primitiveId:'p1',rebuildCopperRegion:async()=>f.write()}]};
 f.eda.pcb_PrimitivePoured={getAll:async()=>{f.switch();return []}};
 await assert.rejects(pcbToolsRuntime(f.eda,{target,kind:'rebuildPours',pourIds:['p1']}),/document/);assert.equal(f.writes(),0);
});
test('I08 explicit API permission denial is not converted into a fallback query',async()=>{
 const f=base();let reads=0;
 f.eda.pcb_Document={getPrimitivesInRegion:async()=>{throw Error('Permission denied')}};
 f.eda.pcb_PrimitiveLine={getAll:async()=>{reads++;return []}};
 await assert.rejects(pcbToolsRuntime(f.eda,{target,kind:'pick',mode:'region',units:'mil',region:{left:0,right:10,top:10,bottom:0}}),/Permission denied/);assert.equal(reads,0);
});
test('I09 a differential pair cannot contain the same net on both sides',async()=>{
 const f=base();f.eda.pcb_Drc={getAllDifferentialPairs:async()=>[],createDifferentialPair:async()=>f.write()};
 await assert.rejects(constraintRuntime(f.eda,{target,kind:'manage',operation:{action:'create',groupType:'differentialPair',name:'PAIR',expected:null,definition:{positiveNet:'N',negativeNet:'N'}}}),/different|distinct|same net/i);assert.equal(f.writes(),0);
});

// Opt-in ECO test on an authorized disposable PCB. The source schematic is never edited.
// node test/live-eco-probe.mjs TARGET.json EXISTING_OUTPUT_DIRECTORY --disposable-board
// Requires PCB_TEST_BACKUP_PATH to an already verified native EPRO backup.
// Injects one temporary PCB-side designator difference with the documented component API,
// verifies stale digest rejection, imports the associated source, and restores if needed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {resolveBridge,executeBridgeCode} from '../src/bridge.mjs';
if(process.argv[4]!=='--disposable-board')throw Error('Explicit disposable-board opt-in required');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=JSON.parse(await fs.readFile(process.argv[2],'utf8')),out=path.resolve(process.argv[3]);
const backup=await fs.readFile(process.env.PCB_TEST_BACKUP_PATH??'');assert.ok(backup.subarray(0,4).equals(Buffer.from([80,75,3,4])));
const client=new Client({name:'pcb-live-eco-verification',version:'1.5.0'});
const transport=new StdioClientTransport({command:process.execPath,args:['src/server.mjs'],cwd:root,stderr:'pipe',env:{...process.env,EASYEDA_ALLOWED_PROJECT_UUIDS:JSON.stringify([target.projectUuid])}});
transport.stderr?.on('data',()=>{});
const evidence=[];let original=null,temporary=null;
const persist=()=>fs.writeFile(path.join(out,'eco-results.json'),JSON.stringify(evidence,null,2));
async function call(name,args,label=name,expectedError=false){
 const response=await client.callTool({name,arguments:args},undefined,{timeout:240000});
 const result=response.structuredContent??JSON.parse(response.content.find(x=>x.type==='text').text);
 const passed=expectedError?response.isError===true:response.isError!==true;
 evidence.push({name,label,passed,expectedError,result});await persist();console.log(JSON.stringify({label,passed,error:result.error??null}));
 if(!passed)throw Error(label+': '+(result.error??'Unexpected result'));
 return result;
}
async function fixture(eda,{target,expected,newDesignator}){
 const value=(o,k)=>{const f=o?.['getState_'+k[0].toUpperCase()+k.slice(1)];return typeof f==='function'?f.call(o):o?.[k]};
 const guard=async()=>{const d=await eda.dmt_SelectControl.getCurrentDocumentInfo(),p=await eda.dmt_Project.getCurrentProjectInfo();if(d?.uuid!==target.documentUuid||d?.documentType!==3||p?.uuid!==target.projectUuid)throw Error('ECO fixture exact target changed')};
 const read=async()=>{const all=await eda.pcb_PrimitiveComponent.getAll();const c=all.find(c=>value(c,'primitiveId')===expected.primitiveId);if(!c)throw Error('ECO test component missing');return {all,c}};
 const check=c=>{for(const key of ['primitiveId','uniqueId','designator','x','y','rotation','layer','primitiveLock'])if(value(c,key)!==expected[key])throw Error('ECO fixture old-value mismatch: '+key)};
 await guard();let {all,c}=await read();check(c);if(all.some(o=>value(o,'primitiveId')!==expected.primitiveId&&value(o,'designator')===newDesignator))throw Error('Temporary designator already exists');
 await guard();({all,c}=await read());check(c);
 await eda.pcb_PrimitiveComponent.modify(expected.primitiveId,{designator:newDesignator});await guard();({c}=await read());
 if(value(c,'designator')!==newDesignator)throw Error('PCB-side ECO fixture did not apply');
 return {primitiveId:value(c,'primitiveId'),designator:value(c,'designator'),uniqueId:value(c,'uniqueId')};
}
try{
 await client.connect(transport);
 await call('pcb_capture_snapshot',{target,outputPath:path.join(out,'eco-before.json')});
 const baseline=JSON.parse(await fs.readFile(path.join(out,'eco-before.json'),'utf8'));
 original=baseline.components.find(c=>c.designator==='C25'&&!c.primitiveLock)??baseline.components.find(c=>c.uniqueId&&c.designator&&!c.primitiveLock);
 if(!original)throw Error('No unambiguous linked component for ECO test');
 const before=await call('pcb_prepare_schematic_sync',{target},'ECO:prepare-before-difference');
 temporary='C90001';while(baseline.components.some(c=>c.designator===temporary))temporary='C'+(Number(temporary.slice(1))+1);
 const bridge=await resolveBridge({windowId:target.windowId});
 const injected=await executeBridgeCode(bridge,`return await (${fixture.toString()})(eda,${JSON.stringify({target,expected:original,newDesignator:temporary})});`);
 evidence.push({label:'ECO:inject-one-PCB-side-reference-difference',passed:true,result:injected});await persist();
 const fresh=await call('pcb_prepare_schematic_sync',{target},'ECO:prepare-after-difference');assert.notEqual(fresh.digest,before.digest);
 const stale=await call('pcb_import_schematic_changes',{target,schematicUuid:fresh.association.schematicUuid,expectedBeforeDigest:before.digest},'ECO:reject-valid-source-stale-PCB-digest',true);
 assert.match(stale.error,/digest|changed|stale/i);
 const ready=await call('pcb_prepare_schematic_sync',{target},'ECO:prepare-valid-import');
 const rejected=await call('pcb_import_schematic_changes',{target,schematicUuid:ready.association.schematicUuid,expectedBeforeDigest:ready.digest,expectedAfter:{components:[{uniqueId:original.uniqueId,designator:original.designator}]},save:true},'ECO:reject-native-success-with-unmet-reference-goal',true);assert.match(rejected.error,/postconditions were not met/);
 const current=await call('pcb_read',{target,kind:'components',limit:2000},'ECO:readback-component-identity');
 const found=current.result.items.filter(c=>c.uniqueId===original.uniqueId);
 assert.equal(found.length,1);assert.equal(found[0].designator,temporary);
 evidence.push({label:'ECO:unmet-native-reference-goal-confirmed',passed:true,result:{before:original.designator,injected:temporary,after:found[0].designator,primitiveId:found[0].primitiveId}});await persist();
}catch(e){evidence.push({label:'ECO_ASSERTION_FAILURE',passed:false,error:String(e.stack??e)});await persist();console.error(e)}
finally{
 try{
  if(original&&temporary){const c=await call('pcb_read',{target,kind:'components',limit:2000},'ECO:cleanup-read');const matches=c.result.items.filter(x=>x.uniqueId===original.uniqueId);if(matches.length!==1)throw Error('ECO cleanup identity ambiguous');const now=matches[0];if(now.designator===temporary){const bridge=await resolveBridge({windowId:target.windowId});const result=await executeBridgeCode(bridge,`return await (${fixture.toString()})(eda,${JSON.stringify({target,expected:now,newDesignator:original.designator})});`);evidence.push({label:'ECO:restore-temporary-reference',passed:true,result});await persist();}else if(now.designator!==original.designator)throw Error('Unexpected intervening reference change; not overwritten');}
  if(original){const ready=await call('pcb_prepare_schematic_sync',{target},'ECO:prepare-restored-no-change-goal');await call('pcb_import_schematic_changes',{target,schematicUuid:ready.association.schematicUuid,expectedBeforeDigest:ready.digest,expectedAfter:{components:[{uniqueId:original.uniqueId,designator:original.designator}]},save:true},'ECO:matched-explicit-goal');}
  await call('pcb_save_and_drc',{target,save:true,runDrc:true},'ECO:final-save-and-DRC');
  await call('pcb_capture_snapshot',{target,outputPath:path.join(out,'eco-after.json')},'ECO:final-snapshot');
  await call('pcb_compare_snapshots',{beforePath:path.join(out,'eco-before.json'),afterPath:path.join(out,'eco-after.json'),detailLimit:40},'ECO:before-after-comparison');
 }catch(e){evidence.push({label:'ECO_CLEANUP_FAILURE',passed:false,error:String(e.stack??e)});await persist();console.error(e)}
 await transport.close();if(evidence.some(x=>!x.passed))process.exitCode=1;console.log(JSON.stringify({tests:evidence.length,passed:evidence.filter(x=>x.passed).length,failed:evidence.filter(x=>!x.passed).map(x=>x.label)}));
}

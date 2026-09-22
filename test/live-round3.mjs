// Explicit live contract checks on an authorized disposable PCB.
// node test/live-round3.mjs TARGET.json EXISTING_OUTPUT_DIRECTORY --disposable-board
// Creates local evidence/backup files; the only PCB mutation API used is a guarded,
// expected-no-change schematic import. The before/after comparison must be exact.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
if(process.argv[4]!=='--disposable-board')throw Error('Disposable board opt-in required');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const out=path.resolve(process.argv[3]);
if(!target.projectUuid||!target.documentUuid||!target.windowId)throw Error('Exact target required');
const client=new Client({name:'pcb-live-contract-r3',version:'1.6.0'});
const transport=new StdioClientTransport({command:process.execPath,args:['src/server.mjs'],cwd:root,stderr:'pipe',env:{...process.env,EASYEDA_ALLOWED_PROJECT_UUIDS:JSON.stringify([target.projectUuid])}});
transport.stderr?.on('data',()=>{});
const results=[];
async function call(name,args,label=name,expectError=false){
 const response=await client.callTool({name,arguments:args},undefined,{timeout:240000});
 const data=response.structuredContent??JSON.parse(response.content.find(c=>c.type==='text').text);
 const passed=expectError?response.isError===true:response.isError!==true;
 results.push({name,label,passed,expectedError:expectError,result:data});await fs.writeFile(path.join(out,'live-round3.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify({label,passed,error:data.error??null}));
 if(!passed)throw Error(label+': '+(data.error??'Unexpected result'));
 return data;
}
try{
 await client.connect(transport);
 const schema=await client.listTools();assert.equal(schema.tools.length,24);await fs.writeFile(path.join(out,'tool-schemas.json'),JSON.stringify(schema,null,2));
 await call('pcb_list_targets',{projectUuid:target.projectUuid});
 await call('pcb_status',{target});
 await call('pcb_export_backup',{target,scope:'project',outputPath:path.join(out,'before-native.epro')});
 const before=await call('pcb_capture_snapshot',{target,outputPath:path.join(out,'before.json')});assert.equal(before.coverage.metadataComplete,true);
 const baseline=JSON.parse(await fs.readFile(before.path,'utf8'));
 const valid=baseline.components.filter(c=>typeof c.uniqueId==='string'&&c.uniqueId&&baseline.components.filter(x=>x.uniqueId===c.uniqueId).length===1&&baseline.pads.some(p=>p.componentPrimitiveId===c.primitiveId&&p.padNumber!=null&&typeof p.net==='string'));
 const selected=valid.find(c=>/^CN/.test(c.designator??''))??valid[0];assert.ok(selected);
 const pinmap=await call('pcb_inspect_pinmap',{target,componentIds:[selected.primitiveId]});assert.equal(pinmap.items[0].uniqueId,selected.uniqueId);
 const pad=pinmap.items[0].pads[0];assert.ok(pad);
 await call('pcb_inspect_silkscreen',{target,scope:'all',limit:2},'silkscreen:complete-scan');
 const missing=await call('pcb_inspect_silkscreen',{target,scope:'all',ids:['__missing_r3_label__'],limit:1},'silkscreen:missing-explicit-ID',true);assert.match(missing.error,/missing|not found/);
 const ready=await call('pcb_prepare_schematic_sync',{target});
 const malformed=await call('pcb_import_schematic_changes',{target,schematicUuid:ready.association.schematicUuid,expectedBeforeDigest:ready.digest,expectedAfter:{components:[{uniqueId:selected.uniqueId,present:false,designator:selected.designator}]}},'ECO:contradictory-goal-no-import',true);assert.match(malformed.error,/absence|contradict/);
 const goal={pads:[{componentUniqueId:selected.uniqueId,padNumber:String(pad.padNumber),net:pad.net}]};
 const synced=await call('pcb_import_schematic_changes',{target,schematicUuid:ready.association.schematicUuid,expectedBeforeDigest:ready.digest,expectedAfter:goal,save:true},'ECO:logical-pad-matching-goal');assert.equal(synced.postconditionsVerified,true);assert.equal(synced.postconditions.checks[0].resolution,'logical-component-pad');
 const ready2=await call('pcb_prepare_schematic_sync',{target},'ECO:prepare-mismatch');
 const wrong=await call('pcb_import_schematic_changes',{target,schematicUuid:ready2.association.schematicUuid,expectedBeforeDigest:ready2.digest,expectedAfter:{pads:[{...goal.pads[0],net:'__wrong_expected_net__'}]},save:false},'ECO:logical-pad-wrong-goal',true);assert.match(wrong.error,/postconditions were not met/);
 const validation={schema:'easyeda-pcb-plan/v2',intent:'Read-only plan validation',target,units:'mil',phase:'route',operations:[{id:'line',type:'line.create',net:pad.net,layer:'TOP',start:[10,10],end:[20,10],width:8}]};
 const planPath=path.join(out,'bom-plan.json');await fs.writeFile(planPath,'\uFEFF'+JSON.stringify(validation));
 await call('pcb_validate_plan',{planPath},'plan:BOM-file-validation');
 const after=await call('pcb_capture_snapshot',{target,outputPath:path.join(out,'after.json')});
 const compared=await call('pcb_compare_snapshots',{beforePath:before.path,afterPath:after.path,detailLimit:20});assert.equal(compared.fullSnapshotUnchanged,true);assert.deepEqual(compared.unverifiedData,[]);
 const drc=await call('pcb_save_and_drc',{target,save:true,runDrc:true});assert.equal(drc.drcVerified,true);
 const image=await call('pcb_capture_view',{target,outputPath:path.join(out,'view.png')});assert.equal(image.verifiedTransfer,true);
 console.log(JSON.stringify({records:results.length,passed:results.filter(x=>x.passed).length,fullSnapshotUnchanged:compared.fullSnapshotUnchanged,drcErrorCount:drc.drcErrorCount}));
}catch(e){results.push({label:'LIVE_ASSERTION_FAILURE',passed:false,error:String(e.stack??e)});await fs.writeFile(path.join(out,'live-round3.json'),JSON.stringify(results,null,2));console.error(e);process.exitCode=1;}
finally{await transport.close()}

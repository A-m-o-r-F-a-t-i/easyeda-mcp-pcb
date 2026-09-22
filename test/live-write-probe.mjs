// Opt-in reversible test on a disposable PCB only.
// node test/live-write-probe.mjs TARGET.json EXISTING_OUTPUT_DIRECTORY --disposable-board
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
if(process.argv[4]!=='--disposable-board')throw Error('Explicit disposable-board test opt-in required');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=JSON.parse(await fs.readFile(process.argv[2],'utf8')),out=path.resolve(process.argv[3]);
const baseline=JSON.parse(await fs.readFile(path.join(out,'baseline-snapshot.json'),'utf8'));
if(baseline.document.uuid!==target.documentUuid||baseline.document.parentProjectUuid!==target.projectUuid)throw Error('Snapshot/target mismatch');
const client=new Client({name:'pcb-live-reversible-test',version:'1.5.0'});
const transport=new StdioClientTransport({command:process.execPath,args:['src/server.mjs'],cwd:root,stderr:'pipe',env:{...process.env,EASYEDA_ALLOWED_PROJECT_UUIDS:JSON.stringify([target.projectUuid])}});
transport.stderr?.on('data',()=>{});
const evidence=[],cleanup=[],stamp='__R2_'+Date.now();
const retain=async()=>fs.writeFile(path.join(out,'live-write-results.json'),JSON.stringify(evidence,null,2));
async function call(name,args,label=name,expectError=false){
  const response=await client.callTool({name,arguments:args},undefined,{timeout:240000});
  const result=response.structuredContent??JSON.parse(response.content.find(x=>x.type==='text').text);
  const passed=expectError?response.isError===true:response.isError!==true;
  evidence.push({name,label,passed,expectedError:expectError,isError:response.isError===true,result});await retain();
  console.log(JSON.stringify({label,passed,error:result.error??null,counts:result.resultCounts??null}));
  if(!passed)throw Error(label+': '+(result.error??'unexpected result'));
  return result;
}
const fields={line:['net','layer','startX','startY','endX','endY','lineWidth','primitiveLock'],via:['net','x','y','holeDiameter','diameter','viaType','primitiveLock'],pour:['net','layer','pourName','pourPriority','preserveSilos','lineWidth','primitiveLock'],component:['x','y','rotation','layer','primitiveLock','designator']};
const project=(obj,keys)=>Object.fromEntries(keys.map(k=>[k,obj[k]??(k==='primitiveLock'?false:undefined)]));
const textFields=['layer','x','y','text','fontFamily','fontSize','lineWidth','alignMode','rotation','reverse','expansion','mirror','primitiveLock'];
const plan=operations=>({schema:'easyeda-pcb-plan/v2',intent:'Reversible disposable-board tool regression',target,units:'mil',phase:'relayout',constraints:{minTrackWidth:4,minViaHole:8,minAnnularRing:3,allowedLayers:['TOP','BOTTOM']},operations});
const textPlan=operations=>({schema:'easyeda-pcb-text-plan/v1',intent:'Reversible disposable-board text regression',target,units:'mil',operations});
const execute=async(operations,label)=>call('pcb_execute_plan',{plan:plan(operations)},label);
const textExecute=async(operations,label)=>call('pcb_execute_text_plan',{plan:textPlan(operations)},label);
async function current(kind,id){const r=await call('pcb_read',{target,kind,ids:[id],limit:2},'readback:'+kind+':'+id);return r.result.items[0];}
const x=Math.min(...baseline.components.map(c=>c.x))-800,y=Math.min(...baseline.components.map(c=>c.y))-800;
const nets=[...new Set(baseline.pads.map(p=>p.net).filter(Boolean))],net=nets.includes('GND')?'GND':nets[0];
let fatal=null;
try{
  await client.connect(transport);const tools=await client.listTools();assert.equal(tools.tools.length,24);
  await call('pcb_status',{target});
  if(process.env.PCB_TEST_BACKUP_PATH){const backup=await fs.readFile(process.env.PCB_TEST_BACKUP_PATH);assert.ok(path.isAbsolute(process.env.PCB_TEST_BACKUP_PATH)&&backup.subarray(0,4).equals(Buffer.from([80,75,3,4])));evidence.push({label:'existing-native-backup',passed:true,path:process.env.PCB_TEST_BACKUP_PATH,size:backup.length});await retain();}else await call('pcb_export_backup',{target,outputPath:path.join(out,'prewrite-protocol.epro')});
  const strings=[{id:'top',layer:3,text:stamp+'_TOP',mirror:false},{id:'overlap',layer:3,text:stamp+'_PAIR',mirror:false},{id:'bottom',layer:4,text:stamp+'_BOTTOM',mirror:true}].map(s=>({id:s.id,type:'string.create',state:{layer:s.layer,x,y,text:s.text,fontFamily:'default',fontSize:50,lineWidth:8,alignMode:5,rotation:0,reverse:false,expansion:0,mirror:s.mirror,primitiveLock:false}}));
  await call('pcb_validate_text_plan',{plan:textPlan(strings)});
  const created={results:[]};
  for(const operation of strings){const part=await textExecute([operation],'text:create:'+operation.id);created.results.push(...part.results);for(const r of part.results)for(const id of r.primitiveIds)cleanup.push(async()=>{const s=await current('strings',id);if(s){assert.ok(s.text.startsWith(stamp));await textExecute([{id:'remove-'+id,type:'string.delete',primitiveId:id,expected:project(s,textFields)}],'text:cleanup:'+id)}});}
  const replay=await textExecute(strings,'text:idempotent-replay');assert.equal(replay.resultCounts.already_exists,3);
  const topId=created.results[0].primitiveIds[0];let top=await current('strings',topId);
  const changed=await textExecute([{id:'resize',type:'string.modify',primitiveId:topId,expected:project(top,textFields),set:{fontSize:60}}],'text:resize');assert.equal(changed.results[0].after.fontSize,60);
  await call('pcb_execute_text_plan',{plan:textPlan([{id:'stale',type:'string.modify',primitiveId:topId,expected:project(top,textFields),set:{x:x+20}}])},'text:reject-stale-expected',true);
  const inspected=await call('pcb_inspect_silkscreen',{target,scope:'all',limit:5,detailLimit:50},'text:full-board-overlap-test');assert.ok(inspected.sameLayerBBoxOverlaps.some(pair=>pair.includes(topId)&&pair.includes(created.results[1].primitiveIds[0])));
  const creates=[{id:'line',type:'line.create',net,layer:'TOP',start:[x,y-200],end:[x+100,y-200],width:8},{id:'via',type:'via.create',net,position:[x+200,y-200],holeDiameter:10,diameter:22},{id:'pour',type:'pour.create',net,layer:'TOP',pourName:stamp,points:[[x,y-500],[x+100,y-500],[x+100,y-400],[x,y-400]],priorityPolicy:'native',preserveSilos:true,width:0.2}];
  await call('pcb_validate_plan',{plan:plan(creates)});
  const geometry={results:[]};
  for(const operation of creates){const part=await execute([operation],'geometry:create:'+operation.id);geometry.results.push(...part.results);const kind=operation.type.split('.')[0],readKind={line:'lines',via:'vias',pour:'pours'}[kind];for(const r of part.results)for(const id of r.primitiveIds)cleanup.push(async()=>{const s=await current(readKind,id);if(s)await execute([{id:'delete-'+id,type:kind+'.delete',primitiveId:id,expected:project(s,fields[kind])}],'geometry:cleanup:'+kind)})}
  const gReplay=await execute(creates,'geometry:idempotent-replay');assert.equal(gReplay.resultCounts.already_exists,3);
  const lineId=geometry.results[0].primitiveIds[0],line=await current('lines',lineId);
  await execute([{id:'width',type:'line.modify',primitiveId:lineId,expected:project(line,fields.line),set:{lineWidth:10}}],'geometry:line-width-modify');
  await call('pcb_rebuild_pours',{target,pourIds:geometry.results[2].primitiveIds,allowCollateralRebuild:true,save:true},'pour:temporary-boundary-rebuild');
  const candidate=baseline.components.find(c=>!c.primitiveLock&&Number.isFinite(c.rotation)&&Math.abs(c.rotation)<=360);
  const old=await current('components',candidate.primitiveId),affectedNets=[...new Set(baseline.pads.filter(p=>p.componentPrimitiveId===old.primitiveId).map(p=>p.net).filter(Boolean))];
  const moved={...project(old,fields.component),x:old.x+5};
  cleanup.push(async()=>{const now=await current('components',old.primitiveId);assert.ok(Math.abs(now.x-moved.x)<0.02||Math.abs(now.x-old.x)<0.02);await execute([{id:'restore-component',type:'component.modify',primitiveId:old.primitiveId,expected:project(now,fields.component),set:{x:old.x},copperPolicy:'replan',affectedNets}],'component:restore-position')});
  await execute([{id:'move',type:'component.modify',primitiveId:old.primitiveId,expected:project(old,fields.component),set:{x:old.x+5},copperPolicy:'replan',affectedNets}],'component:guarded-move');
  const padComp=baseline.components.find(c=>c.designator&&baseline.components.filter(x=>x.designator===c.designator).length===1&&baseline.pads.filter(p=>p.componentPrimitiveId===c.primitiveId).length===2);
  const pads=baseline.pads.filter(p=>p.componentPrimitiveId===padComp.primitiveId).map(p=>padComp.designator+':'+p.padNumber);
  for(const groupType of ['netClass','equalLengthGroup','differentialPair','padPairGroup']){
    let name=stamp+'_'+groupType;
    const definition=groupType==='differentialPair'?{positiveNet:nets[0],negativeNet:nets[1]}:groupType==='padPairGroup'?{padPairs:[[pads[0],pads[1]]]}:{nets:[nets[0]],color:{r:35,g:120,b:90,alpha:1}};
    let group=(await call('pcb_manage_constraint_group',{target,save:false,operation:{action:'create',groupType,name,expected:null,definition}},groupType+':create')).after;
    cleanup.push(async()=>{const all=await call('pcb_read_constraints',{target},groupType+':cleanup-read');const key={netClass:'netClasses',equalLengthGroup:'equalLengthGroups',differentialPair:'differentialPairs',padPairGroup:'padPairGroups'}[groupType];const found=all[key].find(g=>g.name===name);if(found)await call('pcb_manage_constraint_group',{target,operation:{action:'delete',groupType,name,expected:found}},groupType+':delete')});
    if(['netClass','equalLengthGroup'].includes(groupType)){
      await call('pcb_manage_constraint_group',{target,save:false,operation:{action:'addMembers',groupType,name,expected:group,members:[nets[1]]}},groupType+':reject-color-loss',true);
      group=(await call('pcb_manage_constraint_group',{target,save:false,operation:{action:'addMembers',groupType,name,expected:group,members:[nets[1]],allowColorReset:true}},groupType+':add-member')).after;
      assert.equal(group.color.alpha,1);assert.ok(group.nets.includes(nets[1]));
    }else if(groupType==='differentialPair')group=(await call('pcb_manage_constraint_group',{target,save:false,operation:{action:'setPositiveNet',groupType,name,expected:group,net:nets[2]}},groupType+':change-positive')).after;
    else {await call('pcb_manage_constraint_group',{target,save:false,operation:{action:'addMembers',groupType,name,expected:group,members:[[pads[1],pads[0]]]}},groupType+':reverse-duplicate-no-op');const second=baseline.components.find(c=>c.primitiveId!==padComp.primitiveId&&c.designator&&baseline.components.filter(x=>x.designator===c.designator).length===1&&baseline.pads.filter(p=>p.componentPrimitiveId===c.primitiveId).length===2);const extra=baseline.pads.filter(p=>p.componentPrimitiveId===second.primitiveId).map(p=>second.designator+':'+p.padNumber);group=(await call('pcb_manage_constraint_group',{target,save:false,operation:{action:'addMembers',groupType,name,expected:group,members:[[extra[0],extra[1]]]}},groupType+':add-distinct-member')).after;group=(await call('pcb_manage_constraint_group',{target,save:false,operation:{action:'removeMembers',groupType,name,expected:group,members:[[extra[1],extra[0]]]}},groupType+':remove-reversed-member')).after;}
    const newName=name+'_RENAMED';group=(await call('pcb_manage_constraint_group',{target,save:false,operation:{action:'rename',groupType,name,newName,expected:group}},groupType+':rename')).after;name=newName;assert.equal(group.name,name);
  }
  for(const action of ['start','stop'])await call('pcb_realtime_drc',{target,action},'realtime:'+action+':known-client-failure',true);
  await call('pcb_import_schematic_changes',{target,schematicUuid:'invalid-source',expectedBeforeDigest:'0'.repeat(64)},'ECO:reject-stale-digest',true);
}catch(e){fatal=String(e.stack??e);evidence.push({label:'ASSERTION_FAILURE',passed:false,error:fatal});await retain();console.error(fatal)}
finally{
  for(const undo of cleanup.reverse())try{await undo()}catch(e){evidence.push({label:'CLEANUP_FAILURE',passed:false,error:String(e.stack??e)});await retain();console.error(e)}
  try{await call('pcb_save_and_drc',{target,save:true,runDrc:true},'final:save-native-DRC');await call('pcb_capture_snapshot',{target,outputPath:path.join(out,'postwrite-snapshot.json')},'final:comparison-snapshot');await call('pcb_compare_snapshots',{beforePath:path.join(out,'baseline-snapshot.json'),afterPath:path.join(out,'postwrite-snapshot.json'),detailLimit:50},'final:full-comparison')}catch(e){evidence.push({label:'FINAL_CHECK_FAILURE',passed:false,error:String(e.stack??e)});await retain();console.error(e)}
  await transport.close();if(evidence.some(x=>!x.passed))process.exitCode=1;console.log(JSON.stringify({tests:evidence.length,passed:evidence.filter(x=>x.passed).length,failed:evidence.filter(x=>!x.passed).map(x=>x.label)}));
}

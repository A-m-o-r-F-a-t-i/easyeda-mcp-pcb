// Explicitly opt-in live test: node test/live-read-probe.mjs TARGET.json EXISTING_OUTPUT_DIRECTORY
// TARGET.json must identify a disposable PCB; this phase performs no PCB mutations.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const out=path.resolve(process.argv[3]);
if(!target.projectUuid||!target.documentUuid||!target.windowId)throw Error('Exact target required');
const client=new Client({name:'pcb-live-read-verification',version:'1.5.0'});
const transport=new StdioClientTransport({command:process.execPath,args:['src/server.mjs'],cwd:root,stderr:'pipe',env:{...process.env,EASYEDA_ALLOWED_PROJECT_UUIDS:JSON.stringify([target.projectUuid])}});
transport.stderr?.on('data',()=>{});
const results=[];
async function call(name,args,label=name,expectedError=false){
  const started=new Date().toISOString();
  try{
    const r=await client.callTool({name,arguments:args},undefined,{timeout:240000});
    const value=r.structuredContent??JSON.parse(r.content.find(x=>x.type==='text').text);
    const passed=expectedError?r.isError===true:r.isError!==true;
    results.push({name,label,started,passed,expectedError,isError:r.isError===true,result:value});
    await fs.writeFile(path.join(out,'live-read-results.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify({label,passed,error:value.error??null,counts:value.counts??null,overlapCount:value.overlapCount??null}));
    return value;
  }catch(e){results.push({name,label,started,passed:false,error:String(e.message)});await fs.writeFile(path.join(out,'live-read-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({label,passed:false,error:String(e.message)}));return null;}
}
try{
  await client.connect(transport);
  const schema=await client.listTools();
  await fs.writeFile(path.join(out,'tool-schemas.json'),JSON.stringify(schema,null,2));
  if(schema.tools.length!==24)throw Error('Expected 24 tools');
  await call('pcb_list_targets',{projectUuid:target.projectUuid});
  await call('pcb_open_target',{target,expectedCurrentDocumentUuid:target.documentUuid});
  await call('pcb_status',{target});
  await call('pcb_capabilities',{target});
  await call('pcb_read_constraints',{target});
  const snapshot=await call('pcb_capture_snapshot',{target,outputPath:path.join(out,'baseline-snapshot.json')});
  const raw=await call('pcb_read',{target,kind:'components',limit:2000});
  const components=raw?.result?.items??[];
  if(components.length){
    const selected=components.filter(x=>/^CN/.test(x.designator??'')).slice(0,5);
    const pinmap=await call('pcb_inspect_pinmap',{target,componentIds:(selected.length?selected:components.slice(0,2)).map(x=>x.primitiveId)});
    const first=pinmap?.items?.[0];const pad=first?.pads?.[0];
    if(pad){
      await call('pcb_read',{target,kind:'pins',ids:[first.componentId]},'pcb_read:real-pins');
      await call('pcb_inspect_pinmap',{target,componentIds:[first.componentId],expected:[{componentId:first.componentId,padNumber:String(pad.padNumber),net:pad.net}]},'pcb_inspect_pinmap:match');
      await call('pcb_inspect_pinmap',{target,componentIds:[first.componentId],expected:[{componentId:first.componentId,padNumber:String(pad.padNumber),net:'__EXPECTED_MISMATCH__'}]},'pcb_inspect_pinmap:mismatch');
      await call('pcb_pick',{target,units:'mil',point:{x:pad.x,y:pad.y}},'pcb_pick:point');
      await call('pcb_pick',{target,units:'mil',region:{left:pad.x-30,right:pad.x+30,top:pad.y+30,bottom:pad.y-30}},'pcb_pick:region');
    }
  }
  await call('pcb_inspect_silkscreen',{target,scope:'all',limit:5,detailLimit:30});
  await call('pcb_audit_geometry',{target,detailLimit:20});
  await call('pcb_prepare_schematic_sync',{target});
  await call('pcb_realtime_drc',{target,action:'status'},'pcb_realtime_drc:status');
  await call('pcb_save_and_drc',{target,save:false,runDrc:true},'pcb_save_and_drc:read-only-check');
  await call('pcb_capture_view',{target,outputPath:path.join(out,'baseline-view.png')});
  if(snapshot?.ok)await call('pcb_compare_snapshots',{beforePath:snapshot.path,afterPath:snapshot.path,detailLimit:0});
  await call('pcb_status',{target:{...target,documentUuid:'not-the-authorized-pcb'}},'pcb_status:wrong-document-rejected',true);
  console.log(JSON.stringify({tests:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).map(x=>x.label)}));
}finally{await transport.close()}

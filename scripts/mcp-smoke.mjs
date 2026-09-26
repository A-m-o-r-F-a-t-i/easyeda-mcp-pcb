import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/server.mjs')],env:{...process.env},stderr:'pipe'}),client=new Client({name:'easyeda-pcb-v4-smoke',version:'1.0.0'});
try{
 await client.connect(transport);
 const listing=await client.listTools();assert.equal(listing.tools.length,17);assert.deepEqual(listing.tools.map(tool=>tool.name),['pcb_list_targets','pcb_open_target','pcb_status','pcb_read','pcb_pick','pcb_edit','pcb_read_constraints','pcb_manage_constraint_group','pcb_compare_associated_netlists','pcb_sync_schematic','pcb_rebuild_pours','pcb_save_and_drc','pcb_audit_geometry','pcb_inspect_silkscreen','pcb_render_svg','pcb_capture_view','pcb_export']);
 const operations=await client.callTool({name:'pcb_read',arguments:{kind:'operations'}});assert.notEqual(operations.isError,true);assert.equal(operations.structuredContent.schema,'easyeda-pcb-edit/v4');assert.equal(operations.structuredContent.units,'mil');
 const edit=listing.tools.find(tool=>tool.name==='pcb_edit').inputSchema;for(const field of ['units','mode','guard','expected','planPath','bridgeUrl'])assert.equal(edit.properties[field],undefined);
 console.log(JSON.stringify({ok:true,version:'4.1.0',toolCount:listing.tools.length,units:'mil'}));
}finally{await client.close();}

import {fileURLToPath} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import {createToolRegistry} from './simple-tools.mjs';

export const VERSION='4.1.0';
const registry=createToolRegistry();

export function getToolRegistry(){return registry;}
export async function invokeRegisteredTool(name,arguments_={}){
 const entry=registry.get(name);if(!entry)throw Error(`Unknown PCB tool: ${name}`);
 return entry.handler(z.object(entry.definition.inputSchema).strict().parse(arguments_));
}
export function createPcbServer(){
 const server=new McpServer({name:'easyeda-pcb',version:VERSION},{instructions:'All PCB coordinates, dimensions, widths, drills, regions, measurements and SVG geometry use mil. Prefer MCP for every common PCB operation. Use pcb_read overview to understand components, footprints, poses and pin/net directions; use pcb_edit for explicit bulk placement, routing, copper, mechanical and text operations. The model owns design choices and analysis timing. There is no automatic layout, path search, public prepare/guard chain, legacy profile or compatibility alias. A unique connected PCB may omit target; otherwise pass the exact PCB document UUID returned by pcb_list_targets. Results report actual partial states. Do not blindly replay unknown writes. Raw APIs are only for a specific missing wrapper or implementation diagnosis.'});
 for(const entry of registry.values())server.registerTool(entry.name,entry.definition,entry.handler);
 return server;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===fileURLToPath(new URL(`file:///${process.argv[1].replaceAll('\\','/')}`))){
 const server=createPcbServer(),transport=new StdioServerTransport();
 await server.connect(transport);
}

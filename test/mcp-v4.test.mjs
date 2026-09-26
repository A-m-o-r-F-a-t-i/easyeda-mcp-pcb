import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {getToolRegistry} from '../src/server.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const removed=['advanced.mjs','component-cleanup-runtime.mjs','component-cleanup.mjs','constraint-runtime.mjs','copper-preflight.mjs','execution-context.mjs','gateway-client.mjs','geometry-transport.mjs','guarded-plan.mjs','inspection.mjs','keepout.mjs','native-board-info.mjs','native-precision.mjs','pad-collision.mjs','pcb-tools-runtime.mjs','plan-workflow.mjs','plan.mjs','portable-sha256.mjs','production-tools.mjs','region-read.mjs','release-check.mjs','route-scene.mjs','runtime.mjs','silkscreen-all.mjs','source-fingerprint.mjs','sync-expectations.mjs','text-plan.mjs','text-runtime.mjs','vector-inspection.mjs','verification.mjs','workflow-receipt.mjs'];

test('obsolete source modules and profile dispatch are physically absent',()=>{
 for(const name of removed)assert.equal(fs.existsSync(path.join(root,'src',name)),false,name);
 const server=fs.readFileSync(path.join(root,'src/server.mjs'),'utf8');assert.doesNotMatch(server,/EASYEDA_PCB_PROFILE|getToolRegistry\s*\([^)]*profile|legacyRegistry|diagnosticsRegistry/);
 assert.equal(fs.readdirSync(path.join(root,'src')).filter(name=>name.endsWith('.mjs')).length,31);
});

test('all source imports resolve inside the one server dependency graph',()=>{
 const directory=path.join(root,'src'),files=fs.readdirSync(directory).filter(name=>name.endsWith('.mjs')),graph=new Map();
 for(const name of files){const text=fs.readFileSync(path.join(directory,name),'utf8'),imports=[...text.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map(match=>match[1]);for(const dependency of imports)assert.ok(files.includes(dependency),`${name} -> ${dependency}`);graph.set(name,imports);}
 const reachable=new Set(),stack=['server.mjs'];while(stack.length){const name=stack.pop();if(reachable.has(name))continue;reachable.add(name);stack.push(...(graph.get(name)??[]));}assert.deepEqual([...reachable].sort(),files.sort());
});

test('package, server and registry use one 4.1.0 identity',()=>{
 const packageJson=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));assert.equal(packageJson.version,'4.1.0');assert.equal(lock.version,'4.1.0');assert.equal(lock.packages[''].version,'4.1.0');assert.equal(getToolRegistry().size,17);
});

test('stdio discovery exposes 17 tools and serves the MIL operation schema offline',async context=>{
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/server.mjs')],env:{...process.env},stderr:'pipe'}),client=new Client({name:'easyeda-pcb-v4-test',version:'1.0.0'});context.after(()=>client.close());await client.connect(transport);
 const listing=await client.listTools(),names=listing.tools.map(item=>item.name);assert.deepEqual(names,[...getToolRegistry().keys()]);assert.equal(names.length,17);
 const result=await client.callTool({name:'pcb_read',arguments:{kind:'operations'}});assert.notEqual(result.isError,true);assert.equal(result.structuredContent.schema,'easyeda-pcb-edit/v4');assert.equal(result.structuredContent.units,'mil');
 const edit=listing.tools.find(item=>item.name==='pcb_edit').inputSchema;assert.ok(edit.properties.operations);for(const field of ['units','mode','guard','expected','planPath','bridgeUrl'])assert.equal(edit.properties[field],undefined,field);
});

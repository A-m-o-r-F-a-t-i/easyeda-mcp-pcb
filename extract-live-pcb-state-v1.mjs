import fs from 'node:fs/promises';
import { readPcb } from './src/bridge.mjs';
const target={windowId:'9314e12e-bd7e-4fb7-8f0c-9827f44ea302',projectUuid:'84918908d43b4a09bb01238fe84dbaa9',documentUuid:'d6e84461142c6b0e',tabId:'d6e84461142c6b0e@84918908d43b4a09bb01238fe84dbaa9'};
const output='E:/PLAYGROUND/AGENTDOCK/artifacts/wsp_3f49454090b1fa5e/tsk_ab3d8de5655bc164/live-pcb-state-postimport.json';
const requests={components:{kind:'components',offset:0,limit:2000},pads:{kind:'pads',offset:0,limit:2000},pins:{kind:'pins',offset:0,limit:2000},attributes:{kind:'attributes',offset:0,limit:2000},strings:{kind:'strings',offset:0,limit:2000},regions:{kind:'regions',offset:0,limit:2000},lines:{kind:'lines',offset:0,limit:2000},arcs:{kind:'arcs',offset:0,limit:2000},layers:{kind:'layers'},nets:{kind:'nets'},netlist:{kind:'netlist'}};
const captured={capturedAt:new Date().toISOString(),target,apiUnits:'mil',reads:{}};
for(const [name,request] of Object.entries(requests)){const response=await readPcb({target,...request});captured.reads[name]=response.result;}
await fs.writeFile(output,JSON.stringify(captured,null,2),'utf8');
const summary=Object.fromEntries(Object.entries(captured.reads).map(([name,value])=>[name,value?.total??value?.items?.length??(Array.isArray(value)?value.length:null)]));
console.log(JSON.stringify({ok:true,output,summary},null,2));

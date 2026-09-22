import test from 'node:test';
import assert from 'node:assert/strict';
import {readRuntime,buildReadCode} from '../src/runtime.mjs';
import {inspectPinmapRuntime} from '../src/verification.mjs';
const target={documentUuid:'pcb',projectUuid:'project',windowId:'window'};
function fixture(rawHole=['ROUND',7.4804,7.4804],hole=['ROUND',74.804],layer=12){
 const pin={primitiveId:'pad',padNumber:'1',net:'V',layer,x:100,y:200,rotation:0,pad:['ELLIPSE',110.2,110.2],hole:rawHole};
 const canonical={...pin,hole,holeOffsetX:0,holeOffsetY:0,holeRotation:90,metallization:true};
 const component={primitiveId:'c',designator:'J1',uniqueId:'source',layer:1,x:0,y:0,rotation:0};
 const eda={sys_Environment:{getEditorCurrentVersion:async()=> '4.1.60'},dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'pcb',documentType:3})},dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'project'})},pcb_PrimitiveComponent:{getAll:async()=>[component],getAllPinsByPrimitiveId:async()=>[pin]},pcb_PrimitivePad:{getAll:async()=>[canonical]},pcb_PrimitiveLine:{getAll:async()=>[]},pcb_PrimitiveVia:{getAll:async()=>[]}};
 return {eda,pin,canonical};
}
const readers={pins:async eda=>(await readRuntime(eda,{kind:'pins',target,ids:['c']}))[0].pads[0],pinmap:async eda=>(await inspectPinmapRuntime(eda,{target,designators:['J1']})).items[0].pads[0]};
for(const [name,read] of Object.entries(readers)){
 test(name+' uses canonical round drill, preserving the raw component field',async()=>{const f=fixture();const p=await read(f.eda);assert.deepEqual(p.hole,['ROUND',74.804]);assert.deepEqual(p.componentPinHoleRaw,['ROUND',7.4804,7.4804]);assert.equal(p.physicalDrill.present,true);assert.equal(p.holeReadback.verified,true);assert.equal(p.holeRotation,90);});
 test(name+' uses canonical slot diameter and total length without scale guessing',async()=>{const f=fixture(['SLOT',2.3622,5.9055],['SLOT',23.622,59.055]);const p=await read(f.eda);assert.deepEqual(p.physicalDrill.hole,['SLOT',23.622,59.055]);});
 test(name+' does not multiply already-correct NPTH values',async()=>{const f=fixture(['ROUND',110.2362],['ROUND',110.2362]);f.canonical.metallization=false;const p=await read(f.eda);assert.deepEqual(p.hole,['ROUND',110.2362]);assert.equal(p.metallization,false);});
 test(name+' distinguishes inactive SMD hole state from an actual drill',async()=>{const f=fixture(['ROUND',6.14,6.14],['ROUND',61.4],2);const p=await read(f.eda);assert.deepEqual(p.hole,['ROUND',61.4]);assert.equal(p.physicalDrill.present,false);assert.equal(p.physicalDrill.hole,null);});
 test(name+' keeps an absent canonical pin drill unverified rather than inventing units',async()=>{const f=fixture();f.eda.pcb_PrimitivePad.getAll=async()=>[];const p=await read(f.eda);assert.equal(p.hole,undefined);assert.equal(p.holeReadback.verified,false);assert.equal(p.physicalDrill.present,null);});
 test(name+' refuses duplicate canonical identities and failed enumeration',async()=>{const f=fixture();f.eda.pcb_PrimitivePad.getAll=async()=>[f.canonical,f.canonical];await assert.rejects(read(f.eda),/duplicate canonical/);f.eda.pcb_PrimitivePad.getAll=async()=>undefined;await assert.rejects(read(f.eda),/enumeration unavailable/);});
 test(name+' refuses coordinate or logical identity disagreement',async()=>{const f=fixture();f.canonical.net='OTHER';await assert.rejects(read(f.eda),/identity\/pose drift/);});
 test(name+' accepts EasyEDA 4.1.60 canonical 0.1 mil pose quantization',async()=>{const f=fixture();f.canonical.x=100.1;f.canonical.y=199.9;const p=await read(f.eda);assert.equal(p.x,100);assert.equal(p.y,200);assert.deepEqual(p.hole,['ROUND',74.804]);});
 test(name+' refuses canonical pose disagreement beyond the 4.1.60 grid tolerance',async()=>{const f=fixture();f.canonical.x=100.2;await assert.rejects(read(f.eda),/identity\/pose drift/);});
 test(name+' refuses malformed canonical hole geometry',async()=>{const f=fixture(['ROUND',1],['SLOT',30,20]);await assert.rejects(read(f.eda),/Unsupported canonical hole/);});
}
test('audit snapshot uses the same canonical hole source',async()=>{const f=fixture();const r=await readRuntime(f.eda,{kind:'auditSnapshot',target});assert.deepEqual(r.pads[0].hole,['ROUND',74.804]);});
test('pin reader stays self contained when serialized through the Bridge',async()=>{const f=fixture();const r=await new Function('eda','return (async()=>{'+buildReadCode({kind:'pins',target,ids:['c']})+'})();')(f.eda);assert.deepEqual(r[0].pads[0].hole,['ROUND',74.804]);});

test('no-hole SMD readback does not rewrite unrelated component coordinate rounding',async()=>{const f=fixture(null,null,1);f.canonical.y=200.1;for(const read of Object.values(readers)){const p=await read(f.eda);assert.equal(p.y,200);assert.equal(p.physicalDrill.present,false);}});

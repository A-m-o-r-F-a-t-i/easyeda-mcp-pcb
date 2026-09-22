import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertAllowedTarget, resolveBridge, executeBridgeCode } from './bridge.mjs';
import { readRuntime } from './runtime.mjs';
import { constraintRuntime } from './constraint-runtime.mjs';

// Dependencies are explicitly serialized into the extension context by the wrapper.
export async function captureSnapshotRuntime(eda, request, read, constraints) {
  const guard = async () => {
    const d = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const p = await eda.dmt_Project.getCurrentProjectInfo();
    if (d?.uuid !== request.target.documentUuid || d?.documentType !== 3 || p?.uuid !== request.target.projectUuid) throw Error('Snapshot target changed');
  };
  const kinds = ['components','pads','lines','polylines','vias','pours','poured','fills','arcs','regions','strings','attributes'];
  const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
  const take = async () => {
    await guard();
    const data = await read(eda, {kind:'snapshot',target:request.target,include:kinds});
    if(!Array.isArray(data.layers)||data.layers.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw Error('Invalid layers: layer data unavailable');
    const standaloneIds=new Set();
    for(const pad of data.pads){if(!pad?.primitiveId||standaloneIds.has(pad.primitiveId))throw Error('Missing or duplicate standalone pad identity');standaloneIds.add(pad.primitiveId);}
    const pads = new Map();
    for (const component of data.components) {
      const [result] = await read(eda,{kind:'pins',target:request.target,ids:[component.primitiveId]});
      for (const pad of result.pads) {
        if (pads.has(pad.primitiveId)) throw Error('Duplicate component pad identity; snapshot cannot safely merge it');
        pads.set(pad.primitiveId,{...pad,componentPrimitiveId:component.primitiveId});
      }
    }
    for (const pad of data.pads) pads.set(pad.primitiveId,{...pads.get(pad.primitiveId),...pad});
    data.pads = [...pads.values()];
    for (const kind of kinds) {
      const seen = new Set();
      for (const item of data[kind]) {
        if (typeof item.primitiveId !== 'string' || !item.primitiveId || seen.has(item.primitiveId)) throw Error('Missing or duplicate snapshot identity: '+kind);
        seen.add(item.primitiveId);
      }
      data[kind].sort((a,b)=>a.primitiveId.localeCompare(b.primitiveId));
    }
    data.netlist = await read(eda,{kind:'netlist',target:request.target});
    let parsedNetlist=data.netlist;
    if(typeof parsedNetlist==='string'){try{parsedNetlist=JSON.parse(parsedNetlist);}catch{throw Error('Invalid netlist JSON during snapshot');}}
    if(!parsedNetlist||typeof parsedNetlist!=='object'||Array.isArray(parsedNetlist))throw Error('Invalid netlist: netlist unavailable during snapshot');
    data.constraints = await constraints(eda,{kind:'read',target:request.target});
    if(!data.constraints||typeof data.constraints!=='object'||Array.isArray(data.constraints))throw Error('Invalid constraints during snapshot');
    const requiredConstraints=['currentRuleConfiguration','allRuleConfigurations','netRules','netByNetRules','regionRules','netClasses','differentialPairs','equalLengthGroups','padPairGroups','realTimeDrc'];
    const unavailableConstraintFields=Object.entries(data.constraints).filter(([,v])=>v && !Array.isArray(v) && typeof v==='object' && ('available' in v) && (!v.available || v.error || v.value==null)).map(([k])=>k);
    const missingConstraintFields=requiredConstraints.filter(k=>!(k in data.constraints));
    const groupFields=['netClasses','differentialPairs','equalLengthGroups','padPairGroups'];
    for(const key of requiredConstraints){
      if(!(key in data.constraints))continue;
      const value=data.constraints[key];
      const valid=groupFields.includes(key)?Array.isArray(value)&&value.every(x=>x&&typeof x==='object'&&!Array.isArray(x)):value&&typeof value==='object'&&!Array.isArray(value)&&value.available===true&&!value.error&&value.value!=null&&(key==='realTimeDrc'?typeof value.value==='boolean':typeof value.value==='object');
      if(!valid&&!unavailableConstraintFields.includes(key))unavailableConstraintFields.push(key);
    }
    data.coverage = {
      complete:true, categories:kinds, componentPads:'all component pins plus standalone pads',
      unavailableConstraintFields,missingConstraintFields,metadataComplete:unavailableConstraintFields.length===0&&missingConstraintFields.length===0,
      atomic:false, nativeSourceBackup:false, fields:'typed API state fields only; not every native document record',
    };
    await guard();
    return data;
  };
  const first = await take(), second = await take();
  if (stable(first) !== stable(second)) throw Error('PCB changed during two-pass snapshot; settle edits and recapture');
  return second;
}

export async function captureSnapshot({target,outputPath,maxBytes=16777216,bridgeUrl}) {
  assertAllowedTarget(target);
  if (!target?.documentUuid || !target?.projectUuid || !target?.windowId) throw Error('Snapshot requires exact project/document/window');
  if (!Number.isInteger(maxBytes) || maxBytes<1024 || maxBytes>33554432) throw Error('Invalid snapshot maxBytes');
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.json') throw Error('Snapshot outputPath must be an absolute .json path');
  const parent=await fs.lstat(path.dirname(outputPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Snapshot parent must be an existing regular directory');
  try { await fs.lstat(outputPath); throw Error('Snapshot destination already exists; no overwrite'); } catch(e) { if(e.code!=='ENOENT') throw e; }
  const bridge=await resolveBridge({bridgeUrl,windowId:target.windowId});
  const code=`return await (${captureSnapshotRuntime.toString()})(eda,${JSON.stringify({target})},${readRuntime.toString()},${constraintRuntime.toString()});`;
  const data=await executeBridgeCode(bridge,code,180000);
  const bytes=Buffer.from(JSON.stringify(data));
  if(bytes.length>maxBytes) throw Error('Snapshot exceeds maxBytes; no file written');
  const handle=await fs.open(outputPath,'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const persisted=await fs.readFile(outputPath);
  if (!persisted.equals(bytes)) throw Error('Snapshot disk readback mismatch');
  return {ok:true,path:outputPath,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),document:data.document,counts:Object.fromEntries(data.coverage.categories.map(k=>[k,data[k].length])),coverage:data.coverage,stableReads:2,verifiedTransfer:true,engineeringRelease:'NOT_EVALUATED'};
}

export async function inspectPinmapRuntime(eda, request) {
  if ((request.componentIds===undefined)===(request.designators===undefined)) throw Error('Provide exactly one of componentIds or designators');
  const selector=request.componentIds??request.designators;
  if(!Array.isArray(selector)||!selector.length||selector.length>500||new Set(selector).size!==selector.length) throw Error('Unique nonempty component selector required, at most 500');
  const state=(o,k)=>{const fn=o?.['getState_'+k[0].toUpperCase()+k.slice(1)];return typeof fn==='function'?fn.call(o):o?.[k];};
  const clientVersion=await eda.sys_Environment?.getEditorCurrentVersion?.()??null;
  const canonicalPoseToleranceMil=clientVersion==='4.1.60'?0.11:1e-6; // 4.1.60 rounds transformed component-pad coordinates to the 0.1 mil grid.

  const canonicalPadMap = async () => {
    if (typeof eda.pcb_PrimitivePad?.getAll !== 'function') return new Map();
    const all = await eda.pcb_PrimitivePad.getAll();
    if (!Array.isArray(all)) throw Error('Canonical pad enumeration unavailable');
    const map = new Map();
    for (const pad of all) {
      const id = state(pad, 'primitiveId');
      if (typeof id !== 'string' || !id || map.has(id)) throw Error('Missing or duplicate canonical pad identity');
      map.set(id, pad);
    }
    return map;
  };
  const reconcilePinHole = (pad, canonical) => {
    const native = canonical.get(pad.primitiveId);
    if (native && state(native,'hole') !== undefined) {
      const keys=pad.hole!=null||state(native,'hole')!=null?['padNumber','net','layer','x','y']:['padNumber','net','layer'];
      for (const key of keys) {
        const value = state(native, key);
        const numericTolerance=key==='x'||key==='y'?canonicalPoseToleranceMil:1e-6;
        if (value !== undefined && pad[key] !== undefined && (typeof value === 'number' ? Math.abs(value-pad[key])>numericTolerance : String(value)!==String(pad[key]))) throw Error('Canonical pad identity/pose drift: '+pad.primitiveId+' '+key);
      }
      const raw = pad.hole;
      for (const key of ['hole','holeOffsetX','holeOffsetY','holeRotation','metallization']) {
        const value=state(native,key); if(value!==undefined)pad[key]=value;
      }
      if (JSON.stringify(raw)!==JSON.stringify(pad.hole)) pad.componentPinHoleRaw=raw;
      if (pad.hole != null) pad.holeReadback={source:'pcb_PrimitivePad.getAll',units:'mil',verified:true};
    } else if (pad.hole != null) {
      pad.componentPinHoleRaw=pad.hole;
      delete pad.hole;
      pad.holeReadback={source:'component-pin-api',units:null,verified:false};
    }
    if (pad.hole !== undefined) {
      const h=pad.hole;
      const valid=h===null || Array.isArray(h) && ((h[0]==='ROUND'&&h.length===2)||(h[0]==='SLOT'&&h.length===3)) && h.slice(1).every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0) && (h[0]!=='SLOT'||h[2]>=h[1]);
      if(!valid)throw Error('Unsupported canonical hole shape: '+pad.primitiveId);
      pad.physicalDrill={present:pad.layer===12&&h!==null,units:'mil',hole:pad.layer===12?h:null};
    } else pad.physicalDrill={present:pad.layer===12?null:false,units:null,hole:null};
    return pad;
  };
  const guard=async()=>{
    const d=await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if(d?.uuid!==request.target.documentUuid||d?.documentType!==3) throw Error('Pinmap document changed');
    if(request.target.projectUuid&&(await eda.dmt_Project.getCurrentProjectInfo())?.uuid!==request.target.projectUuid) throw Error('Pinmap project changed');
  };
  const take=async()=>{
    await guard();
    const all=await eda.pcb_PrimitiveComponent.getAll();
    if(!Array.isArray(all)) throw Error('Component enumeration unavailable');
    const canonical=await canonicalPadMap();
    const output=[];
    for(const value of selector) {
      const key=request.componentIds?'primitiveId':'designator';
      const matches=all.filter(c=>state(c,key)===value);
      if(matches.length!==1) throw Error('Missing or ambiguous component selector: '+value);
      const c=matches[0],id=state(c,'primitiveId');
      const pins=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id);
      if(!Array.isArray(pins)) throw Error('Component pins unavailable: '+id);
      const pinIds=pins.map(p=>state(p,'primitiveId'));
      if(pinIds.some(id=>typeof id!=='string'||!id)||new Set(pinIds).size!==pinIds.length)throw Error('Missing or duplicate physical pin ID');
      const pads=pins.map(p=>reconcilePinHole(Object.fromEntries(['primitiveId','padNumber','net','layer','x','y','rotation','pad','hole'].map(k=>[k,state(p,k)]).filter(([,v])=>v!==undefined)),canonical));
      if(pads.some(p=>p.padNumber==null||String(p.padNumber)===''||typeof p.net!=='string'||!Number.isFinite(p.x)||!Number.isFinite(p.y))) throw Error('Incomplete pin identity/net/position: '+id);
      pads.sort((a,b)=>String(a.padNumber).localeCompare(String(b.padNumber),undefined,{numeric:true})||String(a.primitiveId).localeCompare(String(b.primitiveId)));
      output.push({componentId:id,uniqueId:state(c,'uniqueId'),designator:state(c,'designator'),layer:state(c,'layer'),x:state(c,'x'),y:state(c,'y'),rotation:state(c,'rotation'),pads});
    }
    await guard();
    return output;
  };
  const first=await take(),items=await take();
  if(JSON.stringify(first)!==JSON.stringify(items)) throw Error('Pinmap changed during two reads; do not use stale labels');
  const checks=[];
  for(const expected of request.expected??[]) {
    const component=items.find(c=>c.componentId===expected.componentId);
    const pads=component?.pads.filter(p=>String(p.padNumber)===String(expected.padNumber))??[];
    checks.push({...expected,actualNets:[...new Set(pads.map(p=>p.net))],matched: pads.length>0&&pads.every(p=>p.net===expected.net)});
  }
  return {ok:true,units:'mil',items,componentCount:items.length,padCount:items.reduce((n,c)=>n+c.pads.length,0),checks,mismatchCount:checks.filter(c=>!c.matched).length,allExpectedMatch:checks.length?checks.every(c=>c.matched):null,coverage:{stableReads:2,atomic:false,expectedScope:'only explicitly supplied expected rows',view:'API board coordinates; physical mating/bottom-view order is not inferred'},engineeringRelease:'NOT_EVALUATED'};
}
export async function inspectPinmap(request) {
  assertAllowedTarget(request.target);
  const bridge=await resolveBridge({bridgeUrl:request.bridgeUrl,windowId:request.target?.windowId});
  return executeBridgeCode(bridge,`return await (${inspectPinmapRuntime.toString()})(eda,${JSON.stringify(request)});`,180000);
}

import { LAYERS, planFieldContract, validatePlan } from './plan.mjs';

const categories = { component:'components', pad:'pads', via:'vias', line:'lines', arc:'arcs', fill:'fills', pour:'pours', polyline:'polylines' };
const inverseLayers = Object.fromEntries(Object.entries(LAYERS).map(([name, id]) => [id, name]));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function failure(message, details) { const error=new Error(message); error.code='PLAN_CONSTRUCTION_FAILED'; error.details=details; throw error; }
function simplePoints(source, scale) {
  if(Array.isArray(source?.[0])&&source.length===1)source=source[0];
  if(!Array.isArray(source))failure('Missing native polygon source');
  const numbers=source.filter(x=>x!=='L');
  if(numbers.length<6||numbers.length%2||!numbers.every(Number.isFinite))failure('Only a single simple L polygon can be constructed from native state');
  const points=Array.from({length:numbers.length/2},(_,i)=>numbers.slice(i*2,i*2+2).map(x=>x*scale));
  if(points.length>3&&points[0].every((v,i)=>v===points.at(-1)[i]))points.pop();
  return points;
}
function fieldValue(key,value,scale,lengths) {
  if(lengths.includes(key))return value*scale;
  if(key==='hole'&&Array.isArray(value))return [value[0],...value.slice(1).map(v=>v*scale)];
  if(key==='pad'&&Array.isArray(value)){
    if(value[0]==='POLYGON')return ['POLYGON',[...simplePoints(value[1],scale).flat()]];
    return [value[0],...value.slice(1).map((v,i)=>value[0]==='NGON'&&i===1?v:v*scale)];
  }
  return structuredClone(value);
}

/** Add missing native old values only; never replace caller-supplied assertions or invent paths. */
export function buildExplicitPlan(input,snapshot) {
  if(!plain(input)||!['mil','mm'].includes(input.units)||snapshot?.units!=='mil')failure('Explicit plan units and a mil snapshot are required');
  const plan=structuredClone(input),scale=plan.units==='mm'?0.0254:1,contract=planFieldContract(),completedFields=[];
  if(!Array.isArray(plan.operations)||!plan.operations.length)failure('Provide the intended operations');
  plan.schema??='easyeda-pcb-plan/v2';
  plan.phase??=plan.operations.some(op=>op.type==='component.modify')?'relayout':'route';
  for(const op of plan.operations){
    if(!plain(op))failure('Every operation must be an object');
    const [kind,action]=String(op.type).split('.');
    if(action!=='modify'&&action!=='delete')continue;
    const category=categories[kind];
    if(!category)failure('Construction does not support this operation; supply its complete plan',{operationId:op.id,type:op.type});
    const matches=(snapshot[category]??[]).filter(item=>item.primitiveId===op.primitiveId);
    if(matches.length!==1)failure('Exact primitive identity missing or ambiguous',{operationId:op.id,primitiveId:op.primitiveId});
    const actual=matches[0];op.expected??={};
    if(!plain(op.expected))failure('expected must be an object',{operationId:op.id});
    for(const key of [...contract.required[kind],'primitiveLock']){
      if(Object.hasOwn(op.expected,key))continue;
      const value=actual[key]===undefined?(key==='primitiveLock'?false:undefined):actual[key];
      if(value===undefined)failure('A required native old-state field is unavailable; no default was fabricated',{operationId:op.id,primitiveId:op.primitiveId,field:key});
      op.expected[key]=fieldValue(key,value,scale,contract.lengths);completedFields.push({operationId:op.id,field:`expected.${key}`});
    }
    if(kind==='component'){
      if(action==='modify'&&op.set?.primitiveLock===undefined)op.set={...op.set,primitiveLock:false};
      if(op.affectedNets===undefined){
        const pads=(snapshot.pads??[]).filter(p=>(p.parentPrimitiveId??p.componentPrimitiveId??p.parentComponentPrimitiveId)===op.primitiveId);
        if(!pads.length)failure('Component pads unavailable; affectedNets cannot be constructed',{operationId:op.id});
        op.affectedNets=[...new Set(pads.map(p=>p.net).filter(Boolean))].sort();completedFields.push({operationId:op.id,field:'affectedNets'});
      }
    }
    if(kind==='fill'&&op.expectedPoints===undefined){op.expectedPoints=simplePoints(actual.complexPolygon??actual.polygon,scale);completedFields.push({operationId:op.id,field:'expectedPoints'});}
    if(kind==='polyline'&&op.expectedPoints===undefined&&op.expectedPosition===undefined){
      let source=actual.polygon??actual.complexPolygon;if(source?.length===1&&Array.isArray(source[0]))source=source[0];
      if(source?.[0]==='CIRCLE'){op.expectedPosition=[source[1]*scale,source[2]*scale];op.expectedDiameter=source[3]*2*scale;}
      else op.expectedPoints=simplePoints(source,scale);
      completedFields.push({operationId:op.id,field:'expectedGeometry'});
    }
  }
  // Native missing fields and malformed geometry remain errors; this is not a circuit or route generator.
  validatePlan(plan);
  return {plan,completedFields,wrotePCB:false,readOnly:true,requiresPrepare:true};
}

/** Preserve IDs when an expanded route has only a few unapplied segments remaining. */
export function buildRemainingPlan(raw,normalized,observations) {
  if(!Array.isArray(observations)||observations.length!==normalized.operations.length)throw new Error('Incomplete reconciliation inventory');
  const byId=new Map();
  for(let i=0;i<observations.length;i++){
    const item=observations[i];
    if(item.id!==normalized.operations[i].id||!item.verified||!['APPLIED','PENDING','CONFLICT'].includes(item.disposition)||byId.has(item.id))throw new Error('Unverified or mismatched reconciliation identity');
    byId.set(item.id,item);
  }
  const conflicts=observations.filter(x=>x.disposition==='CONFLICT'),pending=observations.filter(x=>x.disposition==='PENDING');
  if(conflicts.length)return {remainingPlan:null,conflicts,appliedCount:observations.length-pending.length-conflicts.length,pendingCount:pending.length,complete:false,writeAllowed:false};
  const scale=raw.units==='mm'?0.0254:1,operations=[];
  for(const original of raw.operations){
    if(original.type==='route.create'){
      const expanded=normalized.operations.filter(op=>op.id.startsWith(original.id+'#')&&op.kind==='line');
      for(const op of expanded){
        if(byId.get(op.id)?.disposition!=='PENDING')continue;
        const s=op.state;operations.push({id:op.id,type:'line.create',net:s.net,layer:inverseLayers[s.layer],start:[s.startX*scale,s.startY*scale],end:[s.endX*scale,s.endY*scale],width:s.lineWidth*scale,locked:s.primitiveLock});
      }
    }else if(byId.get(original.id)?.disposition==='PENDING')operations.push(structuredClone(original));
  }
  if(operations.length===0)return {remainingPlan:null,conflicts:[],appliedCount:observations.length,pendingCount:0,complete:true,writeAllowed:false};
  const remainingPlan={...structuredClone(raw),operations};
  validatePlan(remainingPlan);
  return {remainingPlan,conflicts:[],appliedCount:observations.length-pending.length,pendingCount:pending.length,complete:false,writeAllowed:false,requiresPrepare:true};
}

export function verifiedContiguousPrefix(operations,results) {
  if(!Array.isArray(results))return [];
  const prefix=[];
  for(let index=0;index<results.length;index++){
    const result=results[index];
    if(result?.verified!==true||result.id!==operations[index]?.id)break;
    prefix.push(result);
  }
  return prefix;
}

export function executionLedger(normalized, confirmed = [], observed = [], attempted = [], saveState = 'NOT_SAVED') {
  const verified = new Map(confirmed.filter(item => item?.verified === true).map(item => [item.id, item]));
  const uncertain = new Set(observed), attemptedIds = new Set(attempted);
  const operations = normalized.operations.map(op => {
    const item = verified.get(op.id);
    const state = item ? 'VERIFIED' : uncertain.has(op.id) ? 'APPLIED_NEEDS_RECONCILE' : attemptedIds.has(op.id) ? 'OUTCOME_UNKNOWN' : 'NOT_EXECUTED';
    return { id: op.id, state, nativeStatus: item?.status ?? null, primitiveIds: item?.primitiveIds ?? (item?.primitiveId ? [item.primitiveId] : []) };
  });
  return { operations, counts: operations.reduce((out, item) => { out[item.state] = (out[item.state] ?? 0) + 1; return out; }, {}), saveState, replayAllowed: false };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {constraintRuntime} from '../src/constraint-runtime.mjs';
const target={documentUuid:'pcb',projectUuid:'project'};
function fixture(){
 const groups=[{name:'G',padPairs:[['p2','p1']]}],sent=[];
 const eda={dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'pcb',documentType:3})},dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'project'})},pcb_PrimitiveComponent:{getAll:async()=>[]},pcb_PrimitivePad:{getAll:async()=>['p1','p2','p3','p4'].map(primitiveId=>({primitiveId}))},pcb_Drc:{getAllPadPairGroups:async()=>structuredClone(groups),addPadPairToPadPairGroup:async(name,pairs)=>{sent.push(pairs);groups[0].padPairs.push(...pairs.map(p=>[...p].reverse()));return true},removePadPairFromPadPairGroup:async(name,pairs)=>{sent.push(pairs);for(const pair of pairs){const index=groups[0].padPairs.findIndex(p=>JSON.stringify(p)===JSON.stringify(pair));if(index<0)return false;groups[0].padPairs.splice(index,1)}return true}}};
 return {eda,groups,sent};
}
test('PP01 native endpoint reordering does not falsely fail successful additions',async()=>{const f=fixture();const result=await constraintRuntime(f.eda,{target,kind:'manage',operation:{action:'addMembers',groupType:'padPairGroup',name:'G',expected:{name:'G',padPairs:[['p2','p1']]},members:[['p2','p1'],['p4','p3']]}});assert.equal(result.verified,true);assert.deepEqual(result.after.padPairs,[['p1','p2'],['p3','p4']]);assert.deepEqual(f.sent,[[['p3','p4']]])});
test('PP02 removals accept reversed input and send the current native stored order',async()=>{const f=fixture();const result=await constraintRuntime(f.eda,{target,kind:'manage',operation:{action:'removeMembers',groupType:'padPairGroup',name:'G',expected:{name:'G',padPairs:[['p1','p2']]},members:[['p1','p2']]}});assert.equal(result.verified,true);assert.deepEqual(result.after.padPairs,[]);assert.deepEqual(f.sent,[[['p2','p1']]])});

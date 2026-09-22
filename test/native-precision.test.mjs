import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyNativeViaPrecision} from '../src/native-precision.mjs';
const via=(holeDiameter,diameter)=>({operations:[{id:'v',kind:'via',type:'via.create',state:{holeDiameter,diameter}}]});
test('nonrepresentable metric via sizes fail before native writes',()=>assert.throws(()=>verifyNativeViaPrecision(via(.3/.0254,.6/.0254),'4.1.60'),/No native write/));
test('integer-mil conservative metric sizes are representable',()=>assert.equal(verifyNativeViaPrecision(via(.3048/.0254,.6096/.0254),'4.1.60').checked,1));
test('unknown clients do not inherit a tested client precision rule',()=>assert.equal(verifyNativeViaPrecision(via(.3/.0254,.6/.0254),'other').known,false));
test('delete retains actual prior dimensions and needs no rounding',()=>assert.equal(verifyNativeViaPrecision({operations:[{id:'v',kind:'via',type:'via.delete'}]},'4.1.60').checked,0));
test('modify validates resulting dimensions without rewriting old values',()=>{
 const n={operations:[{id:'v',kind:'via',type:'via.modify',expected:{holeDiameter:11.8,diameter:23.6},set:{holeDiameter:12,diameter:24}}]},old=structuredClone(n);
 assert.equal(verifyNativeViaPrecision(n,'4.1.60').checked,1);assert.deepEqual(n,old);
});

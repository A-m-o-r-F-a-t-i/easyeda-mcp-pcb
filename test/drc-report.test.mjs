import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeDrcReport} from '../src/drc-report.mjs';
const leaf=id=>({globalIndex:id,errorType:'Clearance Error',ruleName:'Clearance',objs:['a','b']});
test('nested UI categories are not counted as findings',()=>{
 const raw=[{name:'Clearance',list:[{name:'Pads',list:[leaf('1'),leaf('2')]}]},{name:'Connectivity',list:[{name:'Ratlines',list:[leaf('3')]}]}];
 const before=structuredClone(raw),r=summarizeDrcReport(raw);assert.equal(r.total,3);assert.equal(r.topLevelCount,2);assert.equal(r.groupCount,4);assert.deepEqual(r.items[0].categoryPath,['Clearance','Pads']);assert.deepEqual(raw,before);
});
test('empty categories have zero findings and can pass',()=>assert.equal(summarizeDrcReport([{name:'Empty',list:[]}]).total,0));
test('flat native findings remain supported',()=>assert.equal(summarizeDrcReport([leaf('1'),leaf('2')]).total,2));
test('flat and grouped findings may coexist',()=>assert.equal(summarizeDrcReport([leaf('1'),{name:'Group',list:[leaf('2')]}]).total,2));
test('malformed groups and unknown scalar nodes remain errors',()=>{for(const v of [false,null,{},[{}],[true],[{name:'Broken',list:false}],[{name:'Broken',list:null}]])assert.throws(()=>summarizeDrcReport(v),/Invalid|Empty/);});
test('a deeply nested report cannot silently truncate',()=>{let n=leaf('x');for(let i=0;i<40;i++)n={name:'deep',list:[n]};assert.throws(()=>summarizeDrcReport([n]),/depth/);});
test('cyclic and duplicate finding identities are rejected',()=>{const a={name:'a',list:[]};a.list.push(a);assert.throws(()=>summarizeDrcReport([a]),/Cyclic/);assert.throws(()=>summarizeDrcReport([leaf('same'),leaf('same')]),/Duplicate/);});
test('special category and rule strings cannot mutate prototypes',()=>{const r=summarizeDrcReport([{name:'__proto__',list:[{name:'x',ruleName:'constructor'}]}]);assert.equal(r.countsByCategory['__proto__'],1);assert.equal(r.countsByRule.constructor,1);});
test('paged leaves retain their categories and full count',()=>{const raw=[{name:'one',list:Array.from({length:37},(_,i)=>leaf(String(i)))}],r=summarizeDrcReport(raw);assert.equal(r.total,37);assert.equal(r.items.slice(0,5).length,5);assert.deepEqual(r.items[30].categoryPath,['one']);});

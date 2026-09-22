import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeDocumentSource } from '../src/source-fingerprint.mjs';
const make = (time, changes={}) => JSON.stringify({type:'DOCHEAD'})+'||'+JSON.stringify({docType:'PCB',client:time===1?'0123456789abcdef':'fedcba9876543210',uuid:'pcb1',updateTime:time,version:String(time),editVersion:'3.2.186',...changes})+'|\n'+JSON.stringify({type:'LINE',net:'GND',x:10});
const hash=s=>createHash('sha256').update(normalizeDocumentSource(s).canonicalText).digest('hex');
test('export-generated DOCHEAD metadata does not invalidate stable PCB content',()=>{
  assert.notEqual(make(1),make(2));
  assert.equal(hash(make(1)),hash(make(2)));
  assert.equal(normalizeDocumentSource(make(1)).fingerprintKind,'easyeda-pcb-content/v1');
  assert.deepEqual(normalizeDocumentSource(make(1)).omittedFields,['DOCHEAD.client','DOCHEAD.updateTime','DOCHEAD.version']);
});
test('document identity, editor version, unknown metadata and every body byte remain covered',()=>{
  for(const changes of [{uuid:'pcb2'},{editVersion:'3.2.187'},{newImportantField:123}])assert.notEqual(hash(make(1)),hash(make(2,changes)));
  assert.notEqual(hash(make(1)),hash(make(1).replace('"x":10','"x":11')));
});
test('semantic versions and unknown header encodings are never silently omitted',()=>{
  const semantic=make(1,{version:'v3'});
  assert.equal(normalizeDocumentSource(semantic).canonicalText,semantic);
  assert.notEqual(hash(semantic),hash(make(2,{version:'v3'})));
  for(const source of ['plain mock source','{bad||header|','{"type":"DOCHEAD"}||null|'])assert.equal(normalizeDocumentSource(source).canonicalText,source);
});

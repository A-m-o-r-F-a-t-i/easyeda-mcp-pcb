import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadPlanSource} from '../src/bridge.mjs';
import {compareSnapshotSources} from '../src/inspection.mjs';
test('SIZE01 captured snapshots above 8 MiB remain comparable without raising write-plan limits',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pcb-snapshot-size-'));
 try{
  const file=path.join(directory,'large.json');
  const snapshot={document:{uuid:'test-pcb',parentProjectUuid:'test-project'},units:'mil',lines:[],largeNativeMetadata:'x'.repeat(8*1024*1024)};
  await fs.writeFile(file,JSON.stringify(snapshot));
  await assert.rejects(loadPlanSource({planPath:file}),/exceeds/);
  const result=await compareSnapshotSources({beforePath:file,afterPath:file,detailLimit:0});
  assert.equal(result.unchangedWithinComparedScope,true);
 }finally{await fs.rm(directory,{recursive:true,force:true})}
});
test('SIZE02 configurable JSON read limit is itself bounded',async()=>{
 for(const maxBytes of [0,-1,33554433,NaN])await assert.rejects(loadPlanSource({plan:{}},{maxBytes}),/size limit/);
});

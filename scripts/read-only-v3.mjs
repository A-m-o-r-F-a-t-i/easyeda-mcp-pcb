// Read PCB metadata only. No PCB write, save, DRC, layer switch or viewport operation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {collectScene,saveFeedback,artifactDirectory} from '../src/simple-service.mjs';
import {buildOverview} from '../src/component-overview.mjs';
const target=process.argv[2];
if(!target)throw Error('Supply an exact PCB document UUID for this read-only integration probe');
const result=await collectScene({target});
const overview=buildOverview(result.scene);
await fs.mkdir(artifactDirectory(),{recursive:true});
const output=path.join(artifactDirectory(),`v3-readonly-scene-${Date.now()}.json`);
await fs.writeFile(output,JSON.stringify(result.scene),{flag:'wx'});
const view=await saveFeedback(result.scene,{side:'both',pinLabels:false});
console.log(JSON.stringify({target:result.target,scenePath:output,components:overview.totalComponents,pads:overview.totalPads,coverage:overview.coverage,sample:overview.components[0],view:{path:view.path,bytes:view.bytes,omitted:view.metadata.omitted.slice(0,10)}},null,2));

// Reads PCB data and writes local inspection artifacts only. Never edits, saves, runs DRC or changes the viewport.
import fs from 'node:fs/promises';
import path from 'node:path';
import {collectScene,saveFeedback,artifactDirectory} from '../src/simple-service.mjs';
import {buildOverview} from '../src/component-overview.mjs';

const target=process.argv[2];if(!target)throw Error('Supply one exact PCB document UUID');
const result=await collectScene({target}),overview=buildOverview(result.scene);await fs.mkdir(artifactDirectory(),{recursive:true});
const scenePath=path.join(artifactDirectory(),`v4-readonly-scene-${Date.now()}.json`);await fs.writeFile(scenePath,JSON.stringify(result.scene),{flag:'wx'});
const board=await saveFeedback(result.scene,{side:'both',fit:'board',pinLabels:false}),local=await saveFeedback(result.scene,{side:'both',fit:'board',pinLabels:true});
console.log(JSON.stringify({ok:true,target:result.target,units:'mil',scenePath,components:overview.totalComponents,pads:overview.totalPads,coverage:overview.coverage,sample:overview.components[0]??null,board:{path:board.path,bytes:board.bytes,metadata:board.metadata},labels:{path:local.path,bytes:local.bytes,metadata:local.metadata}},null,2));

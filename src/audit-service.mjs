import {auditGeometry} from './audit.mjs';
import {analyzeConnectivity} from './connectivity.mjs';
import {inspectGroupQuality} from './group-quality.mjs';
import {collectScene} from './simple-service.mjs';

export async function auditPcb({target,checks=['geometry'],toleranceMil=0.02,detailLimit=100,net,nativeUnroutedCount,groups,referenceLayers=[],nets,paths=[],sections=[],excludeIds=[],curveToleranceMil=0.02}){
 const allowed=new Set(['geometry','connectivity','topology','groupQuality']);
 if(!Array.isArray(checks)||!checks.length||checks.some(check=>!allowed.has(check)))throw Error('checks must contain geometry, connectivity or groupQuality');
 const {scene,target:exact}=await collectScene({target,geometry:true}),result={ok:true,target:exact,units:'mil',coverage:scene.coverage,checks:{}};
 if(checks.includes('geometry'))result.checks.geometry=auditGeometry(scene,{toleranceMil,detailLimit});
 if(checks.includes('connectivity')||checks.includes('topology')){const report=analyzeConnectivity(scene,{net,nets,toleranceMil,curveToleranceMil,maxDetails:detailLimit,nativeUnroutedCount,paths,sections,excludeIds});if(checks.includes('connectivity'))result.checks.connectivity=report;if(checks.includes('topology'))result.checks.topology=report;}
 if(checks.includes('groupQuality'))result.checks.groupQuality=inspectGroupQuality(scene,{groups,referenceLayers,detailLimit});
 return result;
}

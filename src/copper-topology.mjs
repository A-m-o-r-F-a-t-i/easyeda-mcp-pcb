import {modelCopper,copperTouches,copperLayersMeet,isCopperLayer,measureSection} from './copper-geometry.mjs';

const fail=(code,message,details)=>{throw Object.assign(new Error(message),{code,details});};
const unique=values=>[...new Set(values)];
const summary=o=>({primitiveId:o.primitiveId,nodeId:o.nodeId,kind:o.kind,net:o.net,layer:o.layer,componentId:o.componentId,padNumber:o.padNumber,at:o.at??[(o.bounds.minX+o.bounds.maxX)/2,(o.bounds.minY+o.bounds.maxY)/2],bounds:o.bounds,areaMil2:o.areaMil2,...(o.diameterMil?{diameterMil:o.diameterMil,holeDiameterMil:o.holeDiameterMil}:{}),...(o.widthMil?{widthMil:o.widthMil,lengthMil:o.lengthMil}:{}),...(o.ref?{ref:o.ref}:{})});
function makeGraph(scene,options){
 const model=modelCopper(scene,options),objects=model.objects;
 if(objects.length>30000)fail('RESOURCE_LIMIT','Copper model exceeds 30000 islands; select a smaller network set');
 const contacts=objects.map(()=>[]),byNet=new Map();
 for(const [i,o]of objects.entries()){if(!byNet.has(o.net))byNet.set(o.net,[]);byNet.get(o.net).push(i);o.ref=scene.components?.find(c=>c.primitiveId===o.componentId)?.designator??null;}
 const parent=objects.map((_,i)=>i),root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
 let comparisons=0,contactCount=0;
 const tolerance=options.toleranceMil??0.02,limit=options.maxComparisons??8000000;
 for(const ids of byNet.values()){
  const sorted=[...ids].sort((a,b)=>objects[a].bounds.minX-objects[b].bounds.minX);
  for(let a=0;a<sorted.length;a++)for(let b=a+1;b<sorted.length;b++){
   const i=sorted[a],j=sorted[b],first=objects[i],second=objects[j];
   if(second.bounds.minX>first.bounds.maxX+tolerance)break;
   if(++comparisons>limit)fail('RESOURCE_LIMIT','Contact comparison limit reached; select fewer networks');
   if(!copperLayersMeet(first.layer,second.layer))continue;
   if(copperTouches(first,second,tolerance)){contacts[i].push(j);contacts[j].push(i);parent[root(j)]=root(i);contactCount++;}
  }
 }
 const layers=unique([1,2,...(scene.layers??[]).map(l=>l.id).filter(isCopperLayer),...objects.map(o=>o.layer).filter(isCopperLayer)]).sort((a,b)=>a-b);
 const states=[],stateByObject=objects.map(()=>new Map()),edges=[];
 for(const [i,o]of objects.entries())for(const layer of o.layer==='*'?layers:[o.layer]){const id=states.length;states.push({object:i,layer});stateByObject[i].set(layer,id);edges.push([]);}
 const link=(a,b,cost)=>{edges[a].push({to:b,cost});edges[b].push({to:a,cost});};
 for(const [i,o]of objects.entries()){
  if(o.layer==='*'){const list=[...stateByObject[i].values()];for(let a=0;a<list.length;a++)for(let b=a+1;b<list.length;b++)link(list[a],list[b],1);}
  for(const j of contacts[i])if(j>i)for(const [layer,state]of stateByObject[i]){const other=stateByObject[j].get(layer);if(other!==undefined)link(state,other,0);}
 }
 return {...model,contacts,byNet,root,comparisons,contactCount,layers,states,stateByObject,edges};
}
function endpoint(graph,name,net){
 const matches=graph.objects.map((o,i)=>({o,i})).filter(({o})=>o.kind==='pad'&&o.net===net&&(o.primitiveId===name||o.ref&&`${o.ref}.${o.padNumber}`===name));
 const ids=unique(matches.map(x=>x.o.primitiveId));
 if(ids.length!==1)fail('AMBIGUOUS_PAD','Topology endpoint must identify one modeled pad on the requested net: '+name,{net,candidates:ids});
 return matches.flatMap(({i})=>[...graph.stateByObject[i].values()]);
}
/** Trace existing copper contacts. This never generates a new route. */
function trace(graph,from,to,{excludeIds=new Set(),onlyLayer=null}={}){
 const target=new Set(to),dist=new Float64Array(graph.states.length).fill(Infinity),hops=new Float64Array(graph.states.length).fill(Infinity),previous=new Int32Array(graph.states.length).fill(-1),queued=new Uint8Array(graph.states.length),queue=[];
 const allowed=id=>!excludeIds.has(graph.objects[graph.states[id].object].primitiveId)&&(onlyLayer===null||graph.states[id].layer===onlyLayer);
 for(const id of from)if(allowed(id)){dist[id]=0;hops[id]=0;queue.push(id);queued[id]=1;}
 for(let head=0;head<queue.length;head++){
  const id=queue[head];queued[id]=0;
  for(const edge of graph.edges[id])if(allowed(edge.to)){
   const d=dist[id]+edge.cost,h=hops[id]+1;
   if(d<dist[edge.to]||d===dist[edge.to]&&h<hops[edge.to]){dist[edge.to]=d;hops[edge.to]=h;previous[edge.to]=id;if(!queued[edge.to]){queue.push(edge.to);queued[edge.to]=1;}}
  }
 }
 const best=[...target].filter(id=>Number.isFinite(dist[id])).sort((a,b)=>dist[a]-dist[b]||hops[a]-hops[b])[0];
 if(best===undefined)return null;
 const sequence=[];for(let at=best;at!==-1;at=previous[at])sequence.push(at);sequence.reverse();
 return {layerChanges:dist[best],sequence};
}
function pathReport(graph,request,detailLimit){
 try{
  const from=endpoint(graph,request.from,request.net),to=endpoint(graph,request.to,request.net),route=trace(graph,from,to);
  if(!route)return {...request,status:graph.coverage.complete?'NO_MODELED_PATH':'UNKNOWN_WITH_PARTIAL_COVERAGE',connected:false,layerChanges:null};
  const sequence=route.sequence.map(id=>{const s=graph.states[id],o=graph.objects[s.object];return {primitiveId:o.primitiveId,nodeId:o.nodeId,kind:o.kind,layer:s.layer};});
  const pathIds=new Set(sequence.map(x=>x.primitiveId)),viaObjects=[...new Map(graph.objects.filter(o=>o.kind==='via'&&pathIds.has(o.primitiveId)).map(o=>[o.primitiveId,o])).values()];
  const tested=viaObjects.slice(0,512),mandatory=tested.filter(o=>trace(graph,from,to,{excludeIds:new Set([o.primitiveId])})===null);
  const transitions=[];
  for(let i=1;i<sequence.length;i++)if(sequence[i].layer!==sequence[i-1].layer){const o=graph.objects[graph.states[route.sequence[i]].object];transitions.push({primitiveId:o.primitiveId,kind:o.kind,at:o.at,fromLayer:sequence[i-1].layer,toLayer:sequence[i].layer,...(o.kind==='via'?{diameterMil:o.diameterMil,holeDiameterMil:o.holeDiameterMil}:{})});}
  return {...request,status:graph.coverage.complete?'CONNECTED_WITHIN_COVERAGE':'PATH_FOUND_WITH_PARTIAL_COVERAGE',connected:true,layerChanges:route.layerChanges,sameLayerPaths:graph.layers.filter(layer=>trace(graph,from,to,{onlyLayer:layer})!==null),transitions,viaCount:viaObjects.length,vias:viaObjects.map(summary),mandatoryViaIds:mandatory.map(o=>o.primitiveId),bottleneckAnalysis:{scope:'one-via removal from the modeled existing-copper graph',tested:tested.length,totalOnSelectedPath:viaObjects.length,complete:tested.length===viaObjects.length&&graph.coverage.complete},objects:sequence.slice(0,detailLimit),objectsTruncated:sequence.length>detailLimit,interpretation:'Layer-change minimum is topological, not an electrical current-sharing or shortest physical-length calculation'};
 }catch(e){return {...request,status:'UNRESOLVED',error:{code:e.code??'TOPOLOGY_ENDPOINT_ERROR',message:String(e.message),details:e.details??null}};}
}
export function analyzeCopperTopology(scene,{net,nets,toleranceMil=0.02,curveToleranceMil=0.02,maxDetails=100,maxComparisons=8000000,paths=[],sections=[],excludeIds=[],nativeUnroutedCount}={}){
 if(!Number.isFinite(toleranceMil)||toleranceMil<0||toleranceMil>2||!Number.isFinite(curveToleranceMil)||curveToleranceMil<=0||curveToleranceMil>2)fail('INVALID_REQUEST','Geometry tolerances must be 0..2 mil; curve tolerance must be positive');
 if(!Number.isSafeInteger(maxDetails)||maxDetails<0||maxDetails>5000||!Number.isSafeInteger(maxComparisons)||maxComparisons<1||maxComparisons>20000000)fail('INVALID_REQUEST','Invalid topology result or comparison limit');
 if(paths.length>128||sections.length>256)fail('RESOURCE_LIMIT','Use at most 128 endpoint pairs and 256 sections per report');
 const selected=nets??(net!==undefined?[net]:undefined),graph=makeGraph(scene,{net,nets:selected,toleranceMil,curveToleranceMil,maxComparisons,excludeIds});
 const reports=[];let split=0;
 for(const [name,indices]of [...graph.byNet].sort(([a],[b])=>a.localeCompare(b))){
  const groups=new Map();for(const index of indices){const root=graph.root(index);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(graph.objects[index]);}
  const all=[...groups.values()],padGroups=all.filter(g=>g.some(o=>o.kind==='pad')),orphan=all.filter(g=>!g.some(o=>o.kind==='pad'));
  if(padGroups.length>1)split++;
  reports.push({net:name,modeledComponentCount:all.length,padGroupCount:padGroups.length,copperOnlyIslandCount:orphan.length,padGroups:padGroups.slice(0,maxDetails).map((g,i)=>({island:i,padCount:g.filter(o=>o.kind==='pad').length,primitiveCount:unique(g.map(o=>o.primitiveId)).length,layers:unique(g.map(o=>o.layer)),pads:g.filter(o=>o.kind==='pad').slice(0,maxDetails).map(summary),objectIds:unique(g.map(o=>o.primitiveId)).slice(0,maxDetails)})),copperOnlyIslands:orphan.slice(0,maxDetails).map(g=>({objects:g.slice(0,maxDetails).map(summary),deletionRecommendation:null,interpretation:'No modeled pad contact; review coverage and intended shielding/thermal use before deleting'})),vias:indices.map(i=>graph.objects[i]).filter(o=>o.kind==='via').map(summary).slice(0,maxDetails),groupsTruncated:all.length>maxDetails});
 }
 const partial=!graph.coverage.complete,verdict=partial?'PARTIAL':split?'DISCONNECTED':'CONNECTED_WITHIN_COVERAGE';
 const queriedPaths=paths.map(p=>pathReport(graph,p,maxDetails));
 const queriedSections=sections.map(s=>{try{return {...measureSection(graph.objects,s),curveChordErrorMil:curveToleranceMil,coverageComplete:graph.coverage.complete};}catch(e){return {...s,error:{code:'SECTION_ERROR',message:String(e.message)}};}});
 return {schema:'easyeda-pcb-copper-topology/v1',units:'mil',connectivityVerdict:verdict,nodeCount:graph.objects.length,netCount:graph.byNet.size,contactCount:graph.contactCount,comparisonCount:graph.comparisons,modeledSplitPadNetCount:split,toleranceMil,coverage:{...graph.coverage,contactToleranceMil:toleranceMil,geometryApproximation:'curved boundaries are tessellated with the stated chord-error bound; marginal contacts require native verification'},nativeCrossCheck:Number.isSafeInteger(nativeUnroutedCount)?{nativeUnroutedCount,modeledSplitPadNetCount:split,agreement:partial?'NOT_COMPARABLE_WITH_PARTIAL_COVERAGE':(nativeUnroutedCount===0)===(split===0)?'ZERO_NONZERO_AGREE':'DISAGREEMENT_REQUIRES_REVIEW'}:null,nets:reports.slice(0,maxDetails),paths:queriedPaths,sections:queriedSections,detailsTruncated:reports.length>maxDetails,analysisOnly:true};
}

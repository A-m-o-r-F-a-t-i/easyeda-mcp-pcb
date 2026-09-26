/** Direct read helpers. All public geometry is mil. */
export async function simpleReadRuntime(eda,request,factory){
 const h=factory(eda,request),identity=await h.checkTarget();
 if(request.kind==='status')return {ok:true,target:request.target,...identity,units:'mil',canvasOrigin:await eda.pcb_Document.getCanvasOrigin(),clientVersion:await eda.sys_Environment?.getEditorCurrentVersion?.()??null};
 if(request.kind==='layers')return {ok:true,target:request.target,units:'mil',items:await eda.pcb_Layer.getAllLayers()};
 if(request.kind==='nets'||request.kind==='netlist')return {ok:true,target:request.target,units:'mil',data:await eda.pcb_Net[request.kind==='nets'?'getAllNets':'getNetlist']()};
 const map={components:'component',pads:'pad',lines:'line',arcs:'arc',vias:'via',polylines:'polyline',fills:'fill',pours:'pour',poured:'poured',regions:'region',strings:'string',attributes:'attribute'};
 const kind=map[request.kind];if(!kind)h.fail('UNKNOWN_READ_KIND','Unsupported read kind: '+request.kind);
 const input={kind,...Object.fromEntries(['refs','ids','net','layer','region'].filter(key=>request[key]!==undefined).map(key=>[key,request[key]]))};
 const data=Object.keys(input).length===1?(await h.all(kind)).map(h.serialize):(await h.select(input)).map(value=>h.serialize(value.object));
 await h.checkTarget();const offset=request.offset??0,limit=request.limit??data.length;
 return {ok:true,target:request.target,kind:request.kind,units:'mil',total:data.length,offset,items:data.slice(offset,offset+limit),nextOffset:offset+limit<data.length?offset+limit:null};
}

export async function pickRuntime(eda,request,factory){
 const h=factory(eda,request);await h.checkTarget();
 if(Boolean(request.point)===Boolean(request.region))h.fail('INVALID_PARAMETER','Provide exactly one of point or region');
 const permissionDenied=error=>/permission denied|access denied|unauthori[sz]ed|forbidden|权限拒绝|无权限/i.test(String(error?.message??error));
 if(request.point){
  const [x,y]=h.point(request.point);
  try{
   const hit=await eda.pcb_Document.getPrimitiveAtPoint(x,y),list=Array.isArray(hit)?hit:hit?[hit]:[];
   return {ok:true,target:request.target,units:'mil',mode:'point',executionPath:'native',total:list.length,items:list.map(h.serialize)};
  }catch(error){
   if(permissionDenied(error))throw error;
   const selected=await h.select({region:{left:x,right:x,top:y,bottom:y}});
   return {ok:true,target:request.target,units:'mil',mode:'point',executionPath:'typed-bounds-fallback',nativeError:String(error?.message??error),total:selected.length,items:selected.map(item=>({...h.serialize(item.object),sourceKind:item.kind}))};
  }
 }
 const rectangle=request.region,offset=request.offset??0,limit=request.limit??100;
 try{
  const values=await eda.pcb_Document.getPrimitivesInRegion(rectangle.left,rectangle.right,rectangle.top,rectangle.bottom,rectangle.fullyContained===true),items=(Array.isArray(values)?values:[]).map(h.serialize);
  return {ok:true,target:request.target,units:'mil',mode:'region',executionPath:'native',total:items.length,offset,items:items.slice(offset,offset+limit),nextOffset:offset+limit<items.length?offset+limit:null};
 }catch(error){
  if(permissionDenied(error))throw error;
  const selected=await h.select({region:rectangle});
  const items=selected.map(item=>({...h.serialize(item.object),sourceKind:item.kind}));
  return {ok:true,target:request.target,units:'mil',mode:'region',executionPath:'typed-bounds-fallback',nativeError:String(error?.message??error),total:items.length,offset,items:items.slice(offset,offset+limit),nextOffset:offset+limit<items.length?offset+limit:null};
 }
}

/** Read or modify one native constraint group. */
export async function constraintRuntime(eda,request,factory){
 const h=factory(eda,request);await h.checkTarget();
 const api=eda.pcb_Drc;
 const methods={netClass:{read:'getAllNetClasses',create:'createNetClass',delete:'deleteNetClass',rename:'modifyNetClassName',addMembers:'addNetToNetClass',removeMembers:'removeNetFromNetClass'},differentialPair:{read:'getAllDifferentialPairs',create:'createDifferentialPair',delete:'deleteDifferentialPair',rename:'modifyDifferentialPairName',setPositiveNet:'modifyDifferentialPairPositiveNet',setNegativeNet:'modifyDifferentialPairNegativeNet'},equalLengthGroup:{read:'getAllEqualLengthNetGroups',create:'createEqualLengthNetGroup',delete:'deleteEqualLengthNetGroup',rename:'modifyEqualLengthNetGroupName',addMembers:'addNetToEqualLengthNetGroup',removeMembers:'removeNetFromEqualLengthNetGroup'},padPairGroup:{read:'getAllPadPairGroups',create:'createPadPairGroup',delete:'deletePadPairGroup',rename:'modifyPadPairGroupName',addMembers:'addPadPairToPadPairGroup',removeMembers:'removePadPairFromPadPairGroup'}};
 const list=value=>Array.isArray(value)?value:Object.values(value??{});
 const safe=async method=>typeof api?.[method]!=='function'?{available:false,value:null}:(async()=>{try{return {available:true,value:await api[method]()};}catch(error){return {available:true,value:null,error:String(error?.message??error)};}})();
 const readGroups=async type=>{const method=methods[type].read;if(typeof api?.[method]!=='function')h.fail('API_UNAVAILABLE','Constraint group API unavailable: '+type);return list(await api[method]());};
 if(request.action==='read')return {ok:true,target:request.target,currentRuleConfiguration:await safe('getCurrentRuleConfiguration'),allRuleConfigurations:await safe('getAllRuleConfigurations'),netRules:await safe('getNetRules'),netByNetRules:await safe('getNetByNetRules'),regionRules:await safe('getRegionRules'),netClasses:await readGroups('netClass'),differentialPairs:await readGroups('differentialPair'),equalLengthGroups:await readGroups('equalLengthGroup'),padPairGroups:await readGroups('padPairGroup'),realTimeDrc:await safe('getRealTimeDrcStatus')};
 const op=request.operation,m=methods[op.groupType],method=m?.[op.action];if(!method||typeof api?.[method]!=='function')h.fail('API_UNAVAILABLE','Constraint operation unavailable');
 const pairs=items=>(items??[]).map(pair=>pair.map(value=>{const dot=value.lastIndexOf('.');return dot>0?value.slice(0,dot)+':'+value.slice(dot+1):value;}));
 let args=[op.name];
 if(op.action==='create'){
  if(op.groupType==='differentialPair')args.push(op.positiveNet,op.negativeNet);
  else if(op.groupType==='padPairGroup')args.push(pairs(op.padPairs));
  else args.push(op.nets??[],op.color??null);
 }else if(op.action==='rename')args.push(op.newName);
 else if(op.action==='setPositiveNet'||op.action==='setNegativeNet')args.push(op.net);
 else if(op.action==='addMembers'||op.action==='removeMembers')args.push(op.groupType==='padPairGroup'?pairs(op.padPairs):op.nets??[]);
 const before=await readGroups(op.groupType);await h.checkTarget();const acknowledged=await api[method](...args);if(acknowledged!==true)h.fail('NATIVE_UNCONFIRMED','Constraint operation was not acknowledged');
 const after=await readGroups(op.groupType);await h.checkTarget();
 const finalName=op.newName??op.name;
 return {ok:true,target:request.target,nativeAcknowledged:true,before:before.find(item=>item.name===op.name)??null,after:op.action==='delete'?null:after.find(item=>item.name===finalName)??null};
}

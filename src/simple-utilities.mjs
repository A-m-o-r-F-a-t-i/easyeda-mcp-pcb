/** Direct read/utility calls, sharing the same target and object adapters as edits. */
export async function simpleReadRuntime(eda,request,factory){
 const h=factory(eda,request),identity=await h.checkTarget();
 if(request.kind==='status')return {ok:true,target:request.target,...identity,apiUnits:'mil',defaultInputUnits:'mil',canvasOrigin:await eda.pcb_Document.getCanvasOrigin(),clientVersion:await eda.sys_Environment?.getEditorCurrentVersion?.()??null};
 if(request.kind==='layers')return {ok:true,target:request.target,items:await eda.pcb_Layer.getAllLayers()};
 if(request.kind==='nets'||request.kind==='netlist')return {ok:true,target:request.target,data:await eda.pcb_Net[request.kind==='nets'?'getAllNets':'getNetlist']()};
 const map={components:'component',pads:'pad',lines:'line',arcs:'arc',vias:'via',polylines:'polyline',fills:'fill',pours:'pour',poured:'poured',regions:'region',strings:'string',attributes:'attribute'};
 const kind=map[request.kind];if(!kind)h.fail('UNKNOWN_READ_KIND','Unsupported read kind: '+request.kind);
 const input={kind,...Object.fromEntries(['refs','ids','net','layer','region'].filter(k=>request[k]!==undefined).map(k=>[k,request[k]]))};
 const data=Object.keys(input).length===1?(await h.all(kind)).map(h.serialize):(await h.select(input)).map(x=>h.serialize(x.object));
 await h.checkTarget();const offset=request.offset??0,limit=request.limit??data.length;
 return {ok:true,target:request.target,kind:request.kind,units:'mil',total:data.length,offset,items:data.slice(offset,offset+limit),nextOffset:offset+limit<data.length?offset+limit:null};
}
export async function simpleConstraintRuntime(eda,request,factory){
 const h=factory(eda,request);await h.checkTarget();
 const op=request.operation;
 const methods={netClass:{read:'getAllNetClasses',create:'createNetClass',delete:'deleteNetClass',rename:'modifyNetClassName',addMembers:'addNetToNetClass',removeMembers:'removeNetFromNetClass'},differentialPair:{read:'getAllDifferentialPairs',create:'createDifferentialPair',delete:'deleteDifferentialPair',rename:'modifyDifferentialPairName',setPositiveNet:'modifyDifferentialPairPositiveNet',setNegativeNet:'modifyDifferentialPairNegativeNet'},equalLengthGroup:{read:'getAllEqualLengthNetGroups',create:'createEqualLengthNetGroup',delete:'deleteEqualLengthNetGroup',rename:'modifyEqualLengthNetGroupName',addMembers:'addNetToEqualLengthNetGroup',removeMembers:'removeNetFromEqualLengthNetGroup'},padPairGroup:{read:'getAllPadPairGroups',create:'createPadPairGroup',delete:'deletePadPairGroup',rename:'modifyPadPairGroupName',addMembers:'addPadPairToPadPairGroup',removeMembers:'removePadPairFromPadPairGroup'}};
 const m=methods[op.groupType],api=eda.pcb_Drc,method=m?.[op.action];if(!method||typeof api?.[method]!=='function')h.fail('API_UNAVAILABLE','The specified constraint operation is unavailable');
 const list=async()=>{const value=await api[m.read]();return Array.isArray(value)?value:Object.values(value??{});};
 const before=await list();
 const pairs=items=>(items??[]).map(pair=>pair.map(v=>{const i=v.lastIndexOf('.');return i>0?v.slice(0,i)+':'+v.slice(i+1):v;}));
 let args=[op.name];
 if(op.action==='create'){
  if(op.groupType==='differentialPair')args.push(op.positiveNet,op.negativeNet);
  else if(op.groupType==='padPairGroup')args.push(pairs(op.padPairs));
  else args.push(op.nets??[],op.color??null);
 }else if(op.action==='rename')args.push(op.newName);
 else if(op.action==='setPositiveNet'||op.action==='setNegativeNet')args.push(op.net);
 else if(op.action==='addMembers'||op.action==='removeMembers')args.push(op.groupType==='padPairGroup'?pairs(op.padPairs):op.nets??[]);
 await h.checkTarget();const result=await api[method](...args);const after=await list();await h.checkTarget();
 return {ok:result===true,target:request.target,nativeAcknowledged:result===true,before:before.find(x=>x.name===op.name)??null,after:after.find(x=>x.name===(op.newName??op.name))??null,...(result!==true?{error:{code:'NATIVE_UNCONFIRMED',message:'Constraint operation was not acknowledged'}}:{})};
}

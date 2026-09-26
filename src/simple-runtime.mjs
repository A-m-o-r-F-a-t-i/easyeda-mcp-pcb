/** MCP-owned native editing wrapper. No design gates, placement optimizer or path search. */
export async function simpleEditRuntime(eda, job, factory) {
  const h=factory(eda,job),{state,id,serialize,api,point,length,layer,checkTarget,fail}=h;
  const storage=globalThis.__easyedaPcbExecutions??=new Map();
  const key=job.executionId;
  if(job.inspect){const prior=storage.get(key);return prior?{ok:true,found:true,...prior}:{ok:true,found:false};}
  let journal=storage.get(key);
  if(!journal){journal={target:job.target,results:[],nextIndex:job.offset??0,running:false,failedRefs:[],startedAt:Date.now()};storage.set(key,journal);while(storage.size>24){const first=storage.keys().next().value;if(first===key||storage.get(first).running)break;storage.delete(first);}}
  if(JSON.stringify(journal.target)!==JSON.stringify(job.target))fail('TARGET_CHANGED','Execution journal belongs to another target');
  if(journal.running)fail('EXECUTION_RUNNING','This edit is already executing');
  if(journal.nextIndex!==(job.offset??0))fail('EXECUTION_OFFSET','This batch offset has already been consumed',{nextIndex:journal.nextIndex});
  journal.running=true;
  const started=Date.now(),response=[];
  let pendingWrite=false;
  const subresults=[];
  const acknowledge=async(kind,verb,fn,primitiveId)=>{
    await checkTarget();pendingWrite=true;
    const returned=await fn();
    if(returned===false){pendingWrite=false;fail('NATIVE_REJECTED',`Native ${kind}.${verb} returned false`);}
    if(returned==null)fail('NATIVE_UNCONFIRMED',`Native ${kind}.${verb} did not acknowledge a result`);
    pendingWrite=false;
    if(kind==='component')h.rememberComponent(returned,verb,primitiveId);
    const ids=Array.isArray(returned)?returned.map(id).filter(Boolean):id(returned)?[id(returned)]:primitiveId?[primitiveId]:[];
    let actual=returned&&typeof returned==='object'&&!Array.isArray(returned)?serialize(returned):null;
    if(!actual&&primitiveId&&verb!=='delete')actual=serialize(await h.one(kind,primitiveId));
    const r={kind,action:verb,primitiveIds:ids,status:'applied',...(actual?{actual}:{}),nativeAcknowledged:true};
    subresults.push(r);
    await checkTarget();
    return r;
  };
  const modify=async(kind,o,set)=>acknowledge(kind,'modify',()=>api(kind).modify(id(o),set),id(o));
  const failedDependency=op=>[op.ref,...(op.netEndpoints??[]),op.from,op.to,op.toward].filter(x=>typeof x==='string').some(ref=>journal.failedRefs.some(f=>ref===f||ref.startsWith(f+'.')));
  const execute=async op=>{
    if(failedDependency(op)&&op.op!=='place_one')fail('DEPENDENCY_FAILED','A component required by this action was not successfully placed');
    if(op.op==='place_one'){
      const c=await h.component(op.ref),set=await h.patch(Object.fromEntries(Object.entries(op).filter(([k])=>['at','angle','side','locked'].includes(k))),'component');
      if(!Object.keys(set).length)fail('INVALID_PARAMETER','Placement needs at least one changed property');
      const r=await modify('component',c,set);journal.failedRefs=journal.failedRefs.filter(x=>x!==op.ref);
      r.pads=(await h.pins(r.primitiveIds[0]??id(c))).map(serialize);return;
    }
    if(op.op==='orient'){
      const c=await h.component(op.ref),all=await h.pins(c),numbers=[...new Set(op.pads)];
      const selected=numbers.map(number=>{const matches=all.filter(p=>String(state(p,'padNumber'))===number);if(matches.length!==1)fail('AMBIGUOUS_PAD','Orientation pad must resolve uniquely: '+op.ref+'.'+number);return matches[0];});
      const cx=state(c,'x'),cy=state(c,'y'),center=op.at?point(op.at):[cx,cy];
      const face=selected.reduce((a,p)=>[a[0]+state(p,'x')/selected.length,a[1]+state(p,'y')/selected.length],[0,0]);
      const destination=await h.endpoint(op.toward),v=[face[0]-cx,face[1]-cy],aim=[destination.at[0]-center[0],destination.at[1]-center[1]];
      if(Math.hypot(...v)<1e-8||Math.hypot(...aim)<1e-8)fail('UNDEFINED_ORIENTATION','Selected pad centroid and target must define nonzero directions');
      if(typeof op.toward==='string'&&op.toward.startsWith(op.ref+'.'))fail('SELF_TARGET','Orient toward an external endpoint or an explicit board point');
      const degrees=((state(c,'rotation')??0)+(Math.atan2(aim[1],aim[0])-Math.atan2(v[1],v[0]))*180/Math.PI+720)%360;
      const r=await modify('component',c,{rotation:degrees,...(op.at?{x:center[0],y:center[1]}:{})});
      r.orientation={padNumbers:numbers,toward:destination.at,angle:degrees,sameSide:true};
      r.pads=(await h.pins(r.primitiveIds[0]??id(c))).map(serialize);return;
    }
    if(op.op==='axis_place'){const c=await h.component(op.ref);await modify('component',c,{[op.axis]:length(op.value)});return;}
    if(op.op==='line'||op.op==='arc'){
      const a=await h.endpoint(op.from),b=await h.endpoint(op.to),mapped=[];
      for(const p of op.netEndpoints??[])mapped.push((await h.endpoint(p)).net);
      const nets=[...new Set([a.net,b.net,...mapped].filter(x=>typeof x==='string'&&x.length))];
      if(op.net===undefined&&nets.length!==1)fail('NETWORK_REQUIRED','Endpoint networks cannot uniquely supply the route net',{nets});
      const net=op.net??nets[0],l=await layer(op.layer),w=length(op.width);
      if(op.op==='line')await acknowledge('line','create',()=>api('line').create(net,l,...a.at,...b.at,w,op.locked??false));
      else await acknowledge('arc','create',()=>api('arc').create(net,l,...a.at,...b.at,op.angle,w,1,op.locked??false));
      return;
    }
    if(op.op==='via'){const [x,y]=point(op.at);await acknowledge('via','create',()=>api('via').create(op.net,x,y,length(op.holeDiameter),length(op.diameter),0,null,null,op.locked??false));return;}
    if(op.op==='pad'||op.op==='hole'){
      const [x,y]=point(op.at),isHole=op.op==='hole',drill=isHole?{diameter:op.diameter,...(op.length!==undefined?{length:op.length}:{})}:op.hole;
      const pad=isHole?[drill.length===undefined?'ELLIPSE':'OVAL',length(drill.diameter),length(drill.length??drill.diameter)]:h.padShape(op.padShape);
      const l=isHole?12:await layer(op.layer),offset=point(drill?.offset??[0,0]);
      await acknowledge('pad','create',()=>api('pad').create(l,isHole?'':op.number,x,y,op.angle??0,pad,isHole?undefined:op.net||undefined,h.hole(drill),...offset,drill?.angle??0,isHole?false:op.metallization??true,0,undefined,null,null,op.locked??false));return;
    }
    if(['outline','fill','pour','region'].includes(op.op)){
      const p=h.polygon(op.geometry),l=op.op==='outline'?11:await layer(op.layer),w=op.width===undefined?0.2:length(op.width);
      if(op.op==='outline')await acknowledge('polyline','create',()=>api('polyline').create('',l,p,w,op.locked??false));
      else if(op.op==='fill')await acknowledge('fill','create',()=>api('fill').create(l,p,op.net||undefined,0,w,op.locked??false));
      else if(op.op==='region')await acknowledge('region','create',()=>api('region').create(l,p,op.ruleTypes,op.name,w,op.locked??false));
      else await acknowledge('pour','create',()=>api('pour').create(op.net,l,p,'solid',op.preserveSilos??false,op.name??`MCP_${job.executionId.slice(0,8)}_${op.index}`,op.priority,w,op.locked??false));
      return;
    }
    if(op.op==='text_one'){
      const [x,y]=point(op.at),l=await layer(op.layer??'top_silkscreen');
      await acknowledge('string','create',()=>api('string').create(l,x,y,op.text,op.fontFamily,op.fontSize===undefined?undefined:length(op.fontSize),op.width===undefined?undefined:length(op.width),undefined,op.angle??0,undefined,undefined,op.mirror??false,false));return;
    }
    if(op.op==='modify'||op.op==='delete'){
      for(const {kind,object}of await h.select(op.select)){
        if(op.op==='delete')await acknowledge(kind,'delete',()=>api(kind).delete(id(object)),id(object));
        else await modify(kind,object,await h.patch(op.set,kind));
      }
      return;
    }
    if(op.op==='transform'){
      const shift=point(op.translate??[0,0]),center=point(op.center??[0,0]),angle=op.angle??0,a=angle*Math.PI/180;
      const xy=(x,y)=>[center[0]+(x-center[0])*Math.cos(a)-(y-center[1])*Math.sin(a)+shift[0],center[1]+(x-center[0])*Math.sin(a)+(y-center[1])*Math.cos(a)+shift[1]];
      for(const {kind,object}of await h.select(op.select)){
        const set={};
        if(Number.isFinite(state(object,'x'))&&Number.isFinite(state(object,'y'))){[set.x,set.y]=xy(state(object,'x'),state(object,'y'));if(state(object,'rotation')!==undefined)set.rotation=state(object,'rotation')+angle;}
        else if(kind==='line'||kind==='arc'){[set.startX,set.startY]=xy(state(object,'startX'),state(object,'startY'));[set.endX,set.endY]=xy(state(object,'endX'),state(object,'endY'));}
        else fail('UNSUPPORTED_TRANSFORM','This transform requires a positioned object or line/arc; use explicit geometry modification for '+kind);
        await modify(kind,object,set);
      }
      return;
    }
    if(op.op==='cleanup'){
      const selected=await h.select({kind:'component',...(op.refs?{refs:op.refs}:{all:true})});
      if(op.unlock)for(const {object}of selected)if(state(object,'primitiveLock'))await modify('component',object,{primitiveLock:false});
      if(op.hideDesignators){const parents=new Set(selected.map(x=>id(x.object)));for(const a of await h.all('attribute'))if(state(a,'key')==='Designator'&&parents.has(state(a,'parentPrimitiveId')??state(a,'parentId'))&&(state(a,'keyVisible')||state(a,'valueVisible')))await modify('attribute',a,{keyVisible:false,valueVisible:false});}
      return;
    }
    if(op.op==='stackup'){
      await checkTarget();pendingWrite=true;const value=await eda.pcb_Layer.setTheNumberOfCopperLayers(op.copperLayers);pendingWrite=false;if(value!==true)fail('NATIVE_REJECTED','Copper layer update was not acknowledged');subresults.push({kind:'stackup',action:'modify',status:'applied',actual:await eda.pcb_Layer.getAllLayers()});return;
    }
    if(op.op==='add_component'){
      const r=await acknowledge('component','create',()=>api('component').create(op.library,op.side==='bottom'?2:1,...point(op.at),op.angle??0,false));
      if(op.ref){const c=await h.one('component',r.primitiveIds[0]);if(!c)fail('READ_FAILED','New component could not be resolved for designator update');await modify('component',c,{designator:op.ref});}return;
    }
    fail('UNKNOWN_OPERATION','Unknown editing action: '+op.op);
  };
  try{
    await checkTarget();
    for(const op of job.operations){
      if(op.index!==journal.nextIndex)fail('EXECUTION_OFFSET','Non-contiguous operation index');
      subresults.length=0;pendingWrite=false;
      journal.current={index:op.index,sourceIndex:op.sourceIndex,itemIndex:op.itemIndex,op:op.op,subresults};
      let result;
      try{await execute(op);result={index:op.index,sourceIndex:op.sourceIndex,itemIndex:op.itemIndex,op:op.op,status:'applied',changes:[...subresults]};}
      catch(e){
        if(op.ref)journal.failedRefs.push(op.ref);
        result={index:op.index,sourceIndex:op.sourceIndex,itemIndex:op.itemIndex,op:op.op,status:pendingWrite?'unknown':e.code==='DEPENDENCY_FAILED'?'not_executed':subresults.length?'partial':'failed',changes:[...subresults],error:{code:e.code??'NATIVE_ERROR',message:String(e.message??e),details:e.details??null}};
      }
      journal.results.push(result);response.push(result);journal.nextIndex++;delete journal.current;
      if(result.status==='unknown'||result.error?.code==='TARGET_CHANGED')break;
      if(Date.now()-started>10000)break;
    }
  }finally{journal.running=false;}
  return {ok:response.every(x=>x.status==='applied'),target:job.target,units:'mil',executionId:key,results:response,nextIndex:journal.nextIndex,running:false};
}

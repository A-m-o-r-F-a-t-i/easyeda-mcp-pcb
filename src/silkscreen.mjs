import {assertAllowedTarget,executeBridgeCode,resolveBridge} from './bridge.mjs';

export async function silkscreenRuntime(eda,request){
 const guard=async()=>{const document=await eda.dmt_SelectControl.getCurrentDocumentInfo(),project=await eda.dmt_Project.getCurrentProjectInfo();if(document?.uuid!==request.target.documentUuid||document?.documentType!==3||project?.uuid!==request.target.projectUuid)throw Error('PCB target changed during silkscreen inspection');};
 const state=(object,key)=>{const getter=object?.['getState_'+key[0].toUpperCase()+key.slice(1)];return typeof getter==='function'?getter.call(object):object?.[key];};
 const fields=['primitiveId','parentPrimitiveId','layer','x','y','text','key','value','keyVisible','valueVisible','fontFamily','fontSize','lineWidth','rotation','mirror','alignMode','primitiveLock'];
 await guard();const all=[];
 for(const [kind,api] of [['string',eda.pcb_PrimitiveString],['attribute',eda.pcb_PrimitiveAttribute]]){
  const values=await api.getAll();if(!Array.isArray(values))throw Error(`Invalid ${kind} enumeration`);
  for(const object of values){const value=Object.fromEntries(fields.map(key=>[key,state(object,key)]).filter(([,item])=>item!==undefined));if(![3,4].includes(value.layer))continue;all.push({kind,...value,visibility:kind==='string'?'text-object':value.keyVisible===true||value.valueVisible===true?'visible-attribute':value.keyVisible===false&&value.valueVisible===false?'hidden-attribute':'unknown-attribute'});}
 }
 all.sort((a,b)=>String(a.primitiveId).localeCompare(String(b.primitiveId)));
 const selected=request.ids?all.filter(item=>request.ids.includes(item.primitiveId)):all,offset=request.offset??0,limit=request.limit??100,items=[];
 for(const value of selected.slice(offset,offset+limit)){
  await guard();let bounds=null,boundsError=null;
  try{const native=await eda.pcb_Primitive?.getPrimitivesBBox?.([value.primitiveId]);if(native&&['minX','maxX','minY','maxY'].every(key=>Number.isFinite(native[key])))bounds=native;else boundsError='No valid native graphics bounds';}catch(error){boundsError=String(error?.message??error);}
  const warnings=[];
  if(value.visibility!=='hidden-attribute'){
   if(!Number.isFinite(value.fontSize))warnings.push('FONT_SIZE_UNKNOWN');else if(value.fontSize<(request.minimumFontSizeMil??47.25))warnings.push('FONT_BELOW_TARGET');
   if(!Number.isFinite(value.lineWidth))warnings.push('STROKE_WIDTH_UNKNOWN');else if(value.lineWidth<(request.minimumStrokeWidthMil??7.1))warnings.push('STROKE_BELOW_TARGET');
   if(!bounds)warnings.push('GRAPHICS_BOUNDS_UNKNOWN');
  }
  items.push({...value,fontSizeMil:Number.isFinite(value.fontSize)?value.fontSize:null,strokeWidthMil:Number.isFinite(value.lineWidth)?value.lineWidth:null,bounds,boundsError,warnings});
 }
 const overlaps=[];for(let a=0;a<items.length;a++)for(let b=a+1;b<items.length;b++){const x=items[a],y=items[b],u=x.bounds,v=y.bounds;if(u&&v&&x.layer===y.layer&&x.visibility!=='hidden-attribute'&&y.visibility!=='hidden-attribute'&&Math.min(u.maxX,v.maxX)>Math.max(u.minX,v.minX)&&Math.min(u.maxY,v.maxY)>Math.max(u.minY,v.minY))overlaps.push([x.primitiveId,y.primitiveId]);}
 await guard();return {ok:true,target:request.target,units:'mil',total:selected.length,offset,items,nextOffset:offset+limit<selected.length?offset+limit:null,missingIds:request.ids?.filter(id=>!all.some(item=>item.primitiveId===id))??[],sameLayerBBoxOverlaps:overlaps,coverage:{overlaps:'returned page only',nativeBounds:true,atomic:false},limitations:['Nominal font size is not measured glyph height.','BBox intersections are candidates, not proven glyph collisions.','Component-body occlusion and manufacturing rendering are not evaluated.']};
}

export async function inspectSilkscreen(request){assertAllowedTarget(request.target);const bridge=await resolveBridge({windowId:request.target.windowId});return executeBridgeCode(bridge,`return await (${silkscreenRuntime.toString()})(eda,${JSON.stringify(request)});`);}

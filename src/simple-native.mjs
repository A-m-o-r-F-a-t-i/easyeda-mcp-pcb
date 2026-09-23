/** Serialized with the MCP-owned adapter; this factory has no host dependencies. */
export function createNativeHelpers(eda, request) {
  const factor=request.units==='mil'?1:1/0.0254;
  const modules={component:'pcb_PrimitiveComponent',pad:'pcb_PrimitivePad',via:'pcb_PrimitiveVia',line:'pcb_PrimitiveLine',arc:'pcb_PrimitiveArc',polyline:'pcb_PrimitivePolyline',fill:'pcb_PrimitiveFill',pour:'pcb_PrimitivePour',poured:'pcb_PrimitivePoured',region:'pcb_PrimitiveRegion',string:'pcb_PrimitiveString',attribute:'pcb_PrimitiveAttribute'};
  const fields=['primitiveType','primitiveId','parentId','parentPrimitiveId','componentPrimitiveId','parentComponentPrimitiveId','component','footprint','otherProperty','designator','name','uniqueId','layer','x','y','rotation','primitiveLock','padNumber','padType','net','pad','hole','holeOffsetX','holeOffsetY','holeRotation','metallization','startX','startY','endX','endY','arcAngle','interactiveMode','lineWidth','diameter','holeDiameter','viaType','polygon','complexPolygon','pourName','pourPriority','preserveSilos','pourPrimitiveId','pourFills','fillMode','ruleType','regionName','text','fontFamily','fontSize','alignMode','reverse','expansion','mirror','key','value','keyVisible','valueVisible','manufacturer','manufacturerId','supplier','supplierId'];
  const fail=(code,message,details)=>{const e=new Error(message);e.code=code;e.details=details;throw e;};
  const state=(o,key)=>{const getter=o?.['getState_'+key[0].toUpperCase()+key.slice(1)];return typeof getter==='function'?getter.call(o):o?.[key];};
  const native=v=>v&&typeof v.getSource==='function'?native(v.getSource()):Array.isArray(v)?v.map(native):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,x])=>typeof x!=='function').map(([k,x])=>[k,native(x)])):v;
  const serialize=o=>{const result={};for(const key of fields){try{const v=state(o,key);if(v!==undefined)result[key]=native(v);}catch(e){(result.unavailableFields??=[]).push({field:key,message:String(e.message)});}}return result;};
  const id=o=>state(o,'primitiveId');
  const api=kind=>{const value=eda[modules[kind]];if(!value)fail('API_UNAVAILABLE','Native API unavailable for '+kind);return value;};
  const checkTarget=async()=>{const d=await eda.dmt_SelectControl.getCurrentDocumentInfo(),p=await eda.dmt_Project.getCurrentProjectInfo();if(d?.documentType!==3||d.uuid!==request.target.documentUuid||p?.uuid!==request.target.projectUuid)fail('TARGET_CHANGED','The active PCB no longer matches this request');return {document:d,project:p};};
  const length=v=>{if(!Number.isFinite(v))fail('INVALID_PARAMETER','A finite length is required');return v*factor;};
  const point=p=>{if(!Array.isArray(p)||p.length!==2)fail('INVALID_PARAMETER','Expected [x,y]');return p.map(length);};
  const layerMap={top:1,bottom:2,top_silkscreen:3,bottom_silkscreen:4,board_outline:11,multi:12,...Object.fromEntries(Array.from({length:30},(_,i)=>['inner_'+(i+1),i+15]))};
  let layers=null;
  const layer=async v=>{if(Number.isInteger(v))return v;const key=String(v??'').toLowerCase().replace(/[ -]/g,'_');if(key in layerMap)return layerMap[key];layers??=await eda.pcb_Layer.getAllLayers();const matches=layers.filter(x=>String(x.name??'').toLowerCase()===String(v).toLowerCase());if(matches.length!==1)fail('UNKNOWN_LAYER','Layer is absent or ambiguous: '+v,{candidates:layers.map(x=>({id:x.id,name:x.name}))});return matches[0].id;};
  const all=async kind=>{const values=await api(kind).getAll();if(!Array.isArray(values))fail('READ_FAILED','Native enumeration did not return an array: '+kind);return values;};
  const one=async(kind,primitiveId)=>{const values=await api(kind).get(primitiveId);if(Array.isArray(values))return values.find(x=>id(x)===primitiveId);return values;};
  let componentList=null;
  const pinCache=new Map();
  const components=async()=>componentList??(componentList=await all('component'));
  const rememberComponent=(object,action,oldId)=>{const currentId=id(object)??oldId;pinCache.delete(currentId);if(oldId)pinCache.delete(oldId);if(!componentList)return;if(action==='delete'){componentList=componentList.filter(x=>id(x)!==oldId);return;}if(!id(object)){componentList=null;return;}const at=componentList.findIndex(x=>id(x)===(oldId??currentId));if(at<0)componentList.push(object);else componentList[at]=object;};
  const component=async ref=>{const matches=(await components()).filter(x=>id(x)===ref||state(x,'designator')===ref);if(matches.length!==1)fail('AMBIGUOUS_COMPONENT','Component must resolve uniquely: '+ref,{candidates:matches.map(serialize)});const current=await one('component',id(matches[0]));if(!current||!(id(current)===ref||state(current,'designator')===ref))fail('OBJECT_CHANGED','Component identifier changed during this request: '+ref);return current;};
  const pins=async c=>{const cid=typeof c==='string'?c:id(c);if(pinCache.has(cid))return pinCache.get(cid);const values=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(cid);if(!Array.isArray(values))fail('PINS_UNAVAILABLE','Component pads could not be read');pinCache.set(cid,values);return values;};
  const endpoint=async value=>{
    if(Array.isArray(value))return {at:point(value),net:null};
    const dot=String(value).lastIndexOf('.');let found;
    if(dot>0){const c=await component(value.slice(0,dot));found=(await pins(c)).filter(p=>String(state(p,'padNumber'))===value.slice(dot+1));}
    else{const p=await one('pad',value);found=p?[p]:[];if(!found.length)for(const c of await components())for(const pad of await pins(c))if(id(pad)===value)found.push(pad);}
    if(found.length!==1)fail('AMBIGUOUS_PAD','Pad endpoint must resolve uniquely: '+value,{candidates:found.map(serialize)});
    return {at:[state(found[0],'x'),state(found[0],'y')],net:state(found[0],'net')??'',primitiveId:id(found[0])};
  };
  const polygonSource=geometry=>{
    if(geometry.type==='circle'){const [x,y]=point(geometry.center);return ['CIRCLE',x,y,length(geometry.diameter)/2];}
    let points;
    if(geometry.type==='rectangle'){const [x,y]=point(geometry.at),[w,h]=point(geometry.size);points=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];}
    else if(geometry.type==='polygon')points=geometry.points.map(point);
    else if(geometry.type==='path'){
      const s=geometry.source;if(s[0]==='CIRCLE')return ['CIRCLE',...s.slice(1).map(length)];
      if(s[0]==='R')return s.map((v,i)=>typeof v==='number'&&i!==6?length(v):v);
      let angleNext=false;return s.map(v=>{if(v==='ARC'){angleNext=true;return v;}if(typeof v==='string')return v;if(angleNext){angleNext=false;return v;}return length(v);});
    }else fail('INVALID_PARAMETER','Unknown geometry type');
    if(points.length<3)fail('INVALID_PARAMETER','Polygon needs at least three points');return [...points[0],'L',...points.slice(1).flat(),...points[0]];
  };
  const polygon=geometry=>{const result=eda.pcb_MathPolygon.createPolygon(polygonSource(geometry));if(!result)fail('NATIVE_GEOMETRY_REJECTED','Native polygon factory rejected the supplied geometry');return result;};
  const padShape=s=>{
    const type=s.type.toUpperCase();
    if(type==='POLYGON')return ['POLYGON',polygonSource({type:'polygon',points:s.points})];
    if(type==='NGON')return ['NGON',length(s.diameter),s.sides];
    const [w,h]=point(s.size);return type==='RECT'?[type,w,h,length(s.round??0)]:[type,w,h];
  };
  const hole=h=>!h?null:h.length!==undefined?['SLOT',length(h.diameter),length(h.length)]:['ROUND',length(h.diameter)];
  const select=async s=>{
    if(!s||(!s.all&&!s.ids&&!s.refs&&s.net===undefined&&s.layer===undefined&&!s.region))fail('MISSING_SELECTOR','Specify IDs, refs, net, layer, region or all:true');
    const kinds=s.kind?[s.kind]:s.refs?['component']:Object.keys(modules).filter(x=>x!=='poured');
    const result=[],requestedLayer=s.layer===undefined?undefined:await layer(s.layer);
    const area=s.region?{x0:length(Math.min(s.region.left,s.region.right)),x1:length(Math.max(s.region.left,s.region.right)),y0:length(Math.min(s.region.top,s.region.bottom)),y1:length(Math.max(s.region.top,s.region.bottom))}:null;
    for(const kind of kinds){
      if(!eda[modules[kind]])continue;
      for(const o of await all(kind)){
        if(s.ids&&!s.ids.includes(id(o)))continue;
        if(s.refs&&!s.refs.includes(state(o,'designator'))&&!s.refs.includes(id(o)))continue;
        if(s.net!==undefined&&state(o,'net')!==s.net)continue;
        if(requestedLayer!==undefined&&state(o,'layer')!==requestedLayer)continue;
        if(area){const bounds=await eda.pcb_Primitive?.getPrimitivesBBox?.([id(o)]);let xs,ys;if(bounds){xs=[bounds.minX??bounds.left,bounds.maxX??bounds.right];ys=[bounds.minY??bounds.bottom,bounds.maxY??bounds.top];}else{xs=['x','startX','endX'].map(k=>state(o,k)).filter(Number.isFinite);ys=['y','startY','endY'].map(k=>state(o,k)).filter(Number.isFinite);}if(!xs.length||!ys.length||!xs.every(Number.isFinite)||!ys.every(Number.isFinite))fail('BOUNDS_UNAVAILABLE','Cannot apply rectangle selector to '+id(o));if(Math.max(...xs)<area.x0||Math.min(...xs)>area.x1||Math.max(...ys)<area.y0||Math.min(...ys)>area.y1)continue;}
        result.push({kind,object:o});
      }
    }
    for(const ref of s.refs??[])if(result.filter(x=>id(x.object)===ref||state(x.object,'designator')===ref).length!==1)fail('AMBIGUOUS_COMPONENT','Selected ref is missing or ambiguous: '+ref);
    for(const wanted of s.ids??[])if(!result.some(x=>id(x.object)===wanted))fail('OBJECT_NOT_FOUND','Selected object is missing: '+wanted);
    return result;
  };
  const patch=async(set,kind)=>{
    const out={};
    for(const [key,v]of Object.entries(set)){
      if(key==='at'){[out.x,out.y]=point(v);}
      else if(key==='start'){[out.startX,out.startY]=point(v);}
      else if(key==='end'){[out.endX,out.endY]=point(v);}
      else if(key==='angle')out[kind==='arc'?'arcAngle':'rotation']=v;
      else if(key==='side'||key==='layer')out.layer=await layer(v);
      else if(key==='locked')out.primitiveLock=v;
      else if(['width','fontSize','diameter','holeDiameter'].includes(key))out[key==='width'?'lineWidth':key]=length(v);
      else if(key==='geometry')out[kind==='polyline'?'polygon':'complexPolygon']=polygon(v);
      else if(key==='padShape')out.pad=padShape(v);
      else if(key==='hole'){out.hole=hole(v);if(v?.offset)[out.holeOffsetX,out.holeOffsetY]=point(v.offset);if(v?.angle!==undefined)out.holeRotation=v.angle;}
      else if(key==='name')out[kind==='pour'?'pourName':kind==='region'?'regionName':'name']=v;
      else if(key==='priority')out.pourPriority=v;
      else if(key==='ruleTypes')out.ruleType=v;
      else out[key]=v;
    }
    return out;
  };
  return {factor,modules,fail,state,native,serialize,id,api,checkTarget,length,point,layer,all,one,components,component,pins,rememberComponent,endpoint,polygonSource,polygon,padShape,hole,select,patch};
}

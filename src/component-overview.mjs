import { parseComplexPolygon } from './vector-inspection.mjs';

/** One inventory read. Optional geometry failures are disclosed, never silently empty. */
export async function collectSceneRuntime(eda, request, factory) {
 const h=factory(eda,{...request,units:'mil'}),identity=await h.checkTarget();
 const data={document:identity.document,project:identity.project,units:'mil',components:[],pads:[],layers:[],coverage:{passes:1,atomic:false,missing:[],warnings:[]}};
 data.clientVersion=await eda.sys_Environment?.getEditorCurrentVersion?.()??null;
 data.canvasOrigin=await eda.pcb_Document?.getCanvasOrigin?.()??null;
 data.layers=await eda.pcb_Layer.getAllLayers();
 const list=await h.components(),canonical=new Map();
 try{for(const p of await h.all('pad'))canonical.set(h.id(p),h.serialize(p));}catch(e){data.coverage.missing.push({category:'canonicalPads',error:String(e.message)});}
 const seen=new Set();
 for(const c of list){
  const item=h.serialize(c),cid=h.id(c);item.graphics={};
  try{item.nativeBounds=await eda.pcb_Primitive?.getPrimitivesBBox?.([cid])??null;}catch(e){item.nativeBounds=null;data.coverage.warnings.push({id:cid,field:'nativeBounds',error:String(e.message)});}
  if(eda.pcb_Primitive?.getPrimitiveBoardLine){
   for(const [name,layers]of [['body',[48]],['assembly',[item.layer===2?10:9]],['silkscreen',[item.layer===2?4:3]]]){
    try{const source=await eda.pcb_Primitive.getPrimitiveBoardLine(cid,layers);item.graphics[name]=source==null?null:h.native(source);}
    catch(e){item.graphics[name]=null;data.coverage.warnings.push({id:cid,field:'graphics.'+name,error:String(e.message)});}
   }
  }
  data.components.push(item);
  try{
   for(const p of await h.pins(c)){
    const pin=h.serialize(p),native=canonical.get(pin.primitiveId);
    const pad={...pin,parentPrimitiveId:cid};
    if(native){for(const key of ['hole','holeOffsetX','holeOffsetY','holeRotation','metallization'])if(native[key]!==undefined)pad[key]=native[key];pad.holeSource='canonical native pad';}
    else if(pad.hole!=null){pad.componentHoleRaw=pad.hole;delete pad.hole;pad.holeSource='unknown units in component-only hole';}
    if(data.clientVersion==='4.1.60'&&pad.hole?.[0]==='ROUND'&&pad.hole.length===3&&pad.hole[1]===pad.hole[2]){pad.nativeHoleRaw=pad.hole;pad.hole=['ROUND',pad.hole[1]];}
    if(pad.pad?.[0]==='POLYGON'){
      pad.padGeometryFrame=data.clientVersion==='4.1.60'?'board':'unknown';
      try{pad.nativeBounds=await eda.pcb_Primitive?.getPrimitivesBBox?.([pad.primitiveId])??null;}catch{pad.nativeBounds=null;}
    }
    pad.physicalDrill={present:pad.layer===12?(pad.hole===undefined?null:pad.hole!==null):false,units:'mil'};
    data.pads.push(pad);seen.add(pad.primitiveId);
   }
  }catch(e){data.coverage.missing.push({category:'componentPads',id:cid,error:String(e.message)});}
 }
 for(const [id,pad]of canonical)if(!seen.has(id))data.pads.push({...pad,...(pad.pad?.[0]==='POLYGON'?{padGeometryFrame:data.clientVersion==='4.1.60'?'board':'unknown'}:{}),physicalDrill:{present:pad.layer===12&&pad.hole!=null,units:'mil'}});
 const kinds=request.geometry===false?['polyline','region']:['line','arc','via','polyline','fill','pour','poured','region','string','attribute'];
 const plural={polyline:'polylines',line:'lines',arc:'arcs',via:'vias',fill:'fills',pour:'pours',poured:'poured',region:'regions',string:'strings',attribute:'attributes'};
 for(const kind of kinds){
  try{data[plural[kind]]=(await h.all(kind)).map(h.serialize);}
  catch(e){data[plural[kind]]=[];data.coverage.missing.push({category:plural[kind],error:String(e.message)});}
 }
 // 4.1.60 native filled contours are expressed in 10 mil units; only scale this known representation.
 for(const p of data.poured??[]){
  p.fillGeometry={verified:false,units:null};
  if(data.clientVersion==='4.1.60'&&Array.isArray(p.pourFills)){
   const scalePath=s=>{if(!Array.isArray(s))throw Error('Missing native poured path');if(s.every(Array.isArray))return s.map(scalePath);let angle=false;return s.map(v=>{if(v==='ARC'){angle=true;return v;}if(typeof v==='string')return v;if(angle){angle=false;return v;}if(!Number.isFinite(v))throw Error('Nonfinite poured coordinate');return v*10;});};
   try{p.pourFillsMil=p.pourFills.map(f=>({...f,path:{complexPolygon:scalePath(f.path?.complexPolygon??f.path)},lineWidth:f.lineWidth*10}));p.fillGeometry={verified:true,units:'mil',coordinateScaleToMil:10};}catch(e){data.coverage.warnings.push({id:p.primitiveId,field:'poured',error:String(e.message)});}
  }
 }
 await h.checkTarget();data.coverage.complete=data.coverage.missing.length===0;
 return data;
}

const round=x=>Number.isFinite(x)?Number(x.toFixed(6)):null;
const rotate=([x,y],degrees)=>{const a=degrees*Math.PI/180;return [x*Math.cos(a)-y*Math.sin(a),x*Math.sin(a)+y*Math.cos(a)];};
const merge=boxes=>{const b=boxes.filter(Boolean);return b.length?{minX:Math.min(...b.map(x=>x.minX)),minY:Math.min(...b.map(x=>x.minY)),maxX:Math.max(...b.map(x=>x.maxX)),maxY:Math.max(...b.map(x=>x.maxY))}:null;};
const asBounds=(b,scale)=>b&&['minX','minY','maxX','maxY'].every(k=>Number.isFinite(b[k]))?{...Object.fromEntries(Object.entries(b).filter(([k])=>['minX','minY','maxX','maxY'].includes(k)).map(([k,v])=>[k,round(v*scale)])),width:round((b.maxX-b.minX)*scale),height:round((b.maxY-b.minY)*scale)}:null;
export function padBounds(p){
 if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Array.isArray(p.pad))return null;
 let local;
 if(p.pad[0]==='POLYGON'){
  local=merge(parseComplexPolygon(p.pad[1]).map(x=>x.bounds));
  if(p.padGeometryFrame==='board')return local;
  if(p.padGeometryFrame!=='local')return null;
 }
 else{let w=p.pad[1],h=p.pad[0]==='NGON'?w:p.pad[2]??w;if(![w,h].every(Number.isFinite))return null;local={minX:-w/2,maxX:w/2,minY:-h/2,maxY:h/2};}
 if(!local)return null;
 const corners=[[local.minX,local.minY],[local.minX,local.maxY],[local.maxX,local.minY],[local.maxX,local.maxY]].map(x=>rotate(x,p.rotation??0)).map(([x,y])=>[x+p.x,y+p.y]);
 return {minX:Math.min(...corners.map(x=>x[0])),maxX:Math.max(...corners.map(x=>x[0])),minY:Math.min(...corners.map(x=>x[1])),maxY:Math.max(...corners.map(x=>x[1]))};
}
const graphBounds=s=>s?merge(parseComplexPolygon(s).map(x=>x.bounds)):null;
export function buildOverview(scene,{units='mm',refs,angles=[0,90,180,270],orientationCoordinates=false,region}={}){
 const scale=units==='mm'?0.0254:1,byParent=new Map(),nets=new Map();
 for(const p of scene.pads){const parent=p.parentPrimitiveId??p.componentPrimitiveId??p.parentComponentPrimitiveId;const arr=byParent.get(parent)??[];arr.push(p);byParent.set(parent,arr);}
 const allComponents=scene.components.map(c=>{
  const pads=(byParent.get(c.primitiveId)??[]).map(p=>{
   const local=rotate([p.x-c.x,p.y-c.y],-(c.rotation??0));
   const row={id:p.primitiveId,number:String(p.padNumber??''),net:p.net??'',at:[round(p.x*scale),round(p.y*scale)],poseLocal:local.map(x=>round(x*scale)),angle:p.rotation??null,layer:p.layer,shape:p.pad??null,shapeUnits:'mil',bounds:asBounds(padBounds(p),scale),hole:p.hole??null,holeUnits:p.holeSource?.startsWith('unknown')?null:'mil',physicalDrill:p.physicalDrill??null};
   if(row.net){const connections=nets.get(row.net)??[];connections.push({ref:c.designator??c.primitiveId,pin:row.number,padId:row.id,at:row.at});nets.set(row.net,connections);}return row;
  });
  const orientations=[...new Set([c.rotation??0,...angles])].map(angle=>{
   const sides={top:[],right:[],bottom:[],left:[],center:[]};
   const transformed=pads.map(p=>{const offset=rotate(p.poseLocal,angle);const side=Math.hypot(...offset)<1e-7?'center':Math.abs(offset[0])>=Math.abs(offset[1])?(offset[0]>=0?'right':'left'):(offset[1]>=0?'top':'bottom');const row={pin:p.number,net:p.net,padId:p.id,offset:offset.map(round)};sides[side].push(row);return row;});
   for(const [side,rows]of Object.entries(sides)){rows.sort((a,b)=>(side==='left'||side==='right')?b.offset[1]-a.offset[1]:a.offset[0]-b.offset[0]);sides[side]=rows.map(p=>({pin:p.pin,net:p.net}));}
   return {angle,side:c.layer===2?'bottom':'top',sides,...(orientationCoordinates?{pads:transformed}:{})};
  });
  return {ref:c.designator??null,id:c.primitiveId,name:c.name??null,footprint:c.footprint??null,device:c.component??null,value:c.otherProperty?.Value??c.otherProperty?.value??c.name??null,at:[round(c.x*scale),round(c.y*scale)],angle:c.rotation??0,side:c.layer===2?'bottom':'top',locked:c.primitiveLock??false,dimensions:{body:asBounds(graphBounds(c.graphics?.body),scale),assembly:asBounds(graphBounds(c.graphics?.assembly),scale),silkscreen:asBounds(graphBounds(c.graphics?.silkscreen),scale),nativeGraphics:asBounds(c.nativeBounds,scale),padEnvelope:asBounds(merge((byParent.get(c.primitiveId)??[]).map(padBounds)),scale)},pads,orientations};
 });
 let components=allComponents;
 if(refs){for(const ref of refs)if(allComponents.filter(c=>c.ref===ref||c.id===ref).length!==1)throw Error('Component selector missing or ambiguous: '+ref);components=allComponents.filter(c=>refs.includes(c.ref)||refs.includes(c.id));}
 if(region)components=components.filter(c=>{const b=c.dimensions.padEnvelope??c.dimensions.nativeGraphics;return b?b.maxX>=Math.min(region.left,region.right)&&b.minX<=Math.max(region.left,region.right)&&b.maxY>=Math.min(region.top,region.bottom)&&b.minY<=Math.max(region.top,region.bottom):c.at[0]>=Math.min(region.left,region.right)&&c.at[0]<=Math.max(region.left,region.right)&&c.at[1]>=Math.min(region.top,region.bottom)&&c.at[1]<=Math.max(region.top,region.bottom);});
 for(const p of scene.pads.filter(p=>!(p.parentPrimitiveId??p.componentPrimitiveId??p.parentComponentPrimitiveId)))if(p.net){const arr=nets.get(p.net)??[];arr.push({ref:null,pin:p.padNumber??'',padId:p.primitiveId,at:[round(p.x*scale),round(p.y*scale)]});nets.set(p.net,arr);}
 return {schema:'easyeda-pcb-overview/v3',target:{documentUuid:scene.document.uuid,projectUuid:scene.project?.uuid},units,coordinateSystem:{frame:'native board XY, +Y upward',view:'top observation',poseLocal:'inverse current rotation of actual board-pad offsets; retains the current side/mirror',orientationPrediction:'same-side rotations only; after a native flip read actual pads, do not mirror a second time'},totalComponents:allComponents.length,returnedComponents:components.length,totalPads:scene.pads.length,layers:scene.layers,components,nets:[...nets].map(([net,endpoints])=>({net,endpoints})),mechanical:{units:'mil',outline:(scene.polylines??[]).filter(x=>x.layer===11),regions:scene.regions??[],holes:scene.pads.filter(x=>x.layer===12&&x.metallization===false)},coverage:{...scene.coverage,dimensionSources:{body:'native layer 48 graphical outline; unknown if absent',assembly:'native layer 9/10 graphical outline',silkscreen:'native layer 3/4 graphical outline',nativeGraphics:'native BBox, not a mechanical body',padEnvelope:'rotated pad shape envelope'},sideGrouping:'direction from component origin, not a physical courtyard assertion'}};
}

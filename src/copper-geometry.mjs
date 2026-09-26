import polygonClipping from 'polygon-clipping';
import {describeArc} from './arc-geometry.mjs';

const EPS=1e-8;
const fail=message=>{throw new Error(message);};
const number=(v,name)=>Number.isFinite(v)?v:fail('Nonfinite '+name);
const positive=(v,name)=>number(v,name)>0?v:fail('Nonpositive '+name);
export const isCopperLayer=l=>l===1||l===2||Number.isInteger(l)&&l>=15&&l<=44;
export const copperLayersMeet=(a,b)=>a==='*'||b==='*'||a===b;
const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const length=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const transform=(points,x=0,y=0,degrees=0)=>{const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return points.map(([u,v])=>[x+u*c-v*s,y+u*s+v*c]);};
export function polygonBounds(polygon){const p=polygon.flat();return {minX:Math.min(...p.map(p=>p[0])),maxX:Math.max(...p.map(p=>p[0])),minY:Math.min(...p.map(p=>p[1])),maxY:Math.max(...p.map(p=>p[1]))};}
export const boxesMeet=(a,b,t=0)=>a.minX<=b.maxX+t&&b.minX<=a.maxX+t&&a.minY<=b.maxY+t&&b.minY<=a.maxY+t;
const ringArea=ring=>ring.reduce((v,p,i)=>v+cross(p,ring[(i+1)%ring.length]),0)/2;
export const polygonArea=polygon=>Math.max(0,Math.abs(ringArea(polygon[0]))-polygon.slice(1).reduce((a,r)=>a+Math.abs(ringArea(r)),0));
function steps(radius,span,tolerance){const a=2*Math.acos(Math.max(-1,Math.min(1,1-tolerance/positive(radius,'radius'))));const n=Math.max(4,Math.ceil(Math.abs(span)/Math.max(a,1e-9)));if(n>4096)fail('Curve tessellation exceeds 4096 segments; use a coarser explicit tolerance');return n;}
function ellipse(rx,ry,tolerance){positive(rx,'ellipse radius');positive(ry,'ellipse radius');const n=Math.max(16,steps(Math.max(rx,ry),Math.PI*2,tolerance));return Array.from({length:n},(_,i)=>[rx*Math.cos(i*2*Math.PI/n),ry*Math.sin(i*2*Math.PI/n)]);}
function roundedRectangle(w,h,r,tolerance){
 positive(w,'rectangle width');positive(h,'rectangle height');r=Math.min(Math.max(0,number(r,'corner radius')),w/2,h/2);
 if(!r)return [[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]];
 const out=[],n=steps(r,Math.PI/2,tolerance),corners=[[w/2-r,h/2-r,0],[-w/2+r,h/2-r,Math.PI/2],[-w/2+r,-h/2+r,Math.PI],[w/2-r,-h/2+r,Math.PI*1.5]];
 for(const [x,y,a]of corners)for(let i=0;i<=n;i++)out.push([x+r*Math.cos(a+i*Math.PI/2/n),y+r*Math.sin(a+i*Math.PI/2/n)]);return out;
}
export function capsule(a,b,width,tolerance){
 const r=positive(width,'stroke width')/2;
 if(length(a,b)<EPS)return transform(ellipse(r,r,tolerance),...a);
 const angle=Math.atan2(b[1]-a[1],b[0]-a[0]),n=steps(r,Math.PI,tolerance),points=[];
 for(const [center,start]of [[b,angle-Math.PI/2],[a,angle+Math.PI/2]])for(let i=0;i<=n;i++)points.push([center[0]+r*Math.cos(start+i*Math.PI/n),center[1]+r*Math.sin(start+i*Math.PI/n)]);
 return points;
}
export function arcPoints(source,tolerance){const arc=describeArc(source),n=steps(arc.radius,arc.sweep,tolerance);return Array.from({length:n+1},(_,i)=>i===0?[arc.startX,arc.startY]:i===n?[arc.endX,arc.endY]:[arc.centerX+arc.radius*Math.cos(arc.startAngle+i*arc.sweep/n),arc.centerY+arc.radius*Math.sin(arc.startAngle+i*arc.sweep/n)]);}
function arrays(source){
 if(!Array.isArray(source))fail('Native polygon source is not an array');
 if(!source.length)return [];
 if(source.every(v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)))return [source.flat()];
 if(source.every(Array.isArray))return source.flatMap(arrays);
 return [source];
}
/** Canonical MIL contours; inner contours use even-odd fill. */
export function nativeContours(source,tolerance=0.02){
 source=source?.complexPolygon??source;
 return arrays(source).map(values=>{
  if(values[0]==='CIRCLE'){if(values.length!==4)fail('Malformed CIRCLE');return transform(ellipse(values[3],values[3],tolerance),number(values[1],'circle x'),number(values[2],'circle y'));}
  if(values[0]==='R'){if(values.length<5)fail('Malformed rectangle');return transform(roundedRectangle(values[3],values[4],values[5]??0,tolerance),number(values[1],'rectangle x'),number(values[2],'rectangle y'),values[6]??0);}
  if(values.length<6)fail('Polygon contour is incomplete');
  const out=[[number(values[0],'polygon x'),number(values[1],'polygon y')]];let i=2;
  while(i<values.length){
   const command=values[i];
   if(command==='L'){i++;continue;}
   if(command==='ARC'){
    const from=out.at(-1),angle=number(values[i+1],'arc sweep'),to=[number(values[i+2],'arc x'),number(values[i+3],'arc y')];
    if(Math.abs(angle)<EPS)out.push(to);else out.push(...arcPoints({startX:from[0],startY:from[1],endX:to[0],endY:to[1],arcAngle:angle},tolerance).slice(1));i+=4;continue;
   }
   if(typeof command==='string')fail('Unsupported polygon command: '+command);
   out.push([number(command,'polygon x'),number(values[i+1],'polygon y')]);i+=2;
  }
  if(length(out[0],out.at(-1))<EPS)out.pop();
  if(out.length<3)fail('Degenerate polygon contour');return out;
 });
}
export function nativePolygon(source,tolerance=0.02){const rings=nativeContours(source,tolerance);return rings.length?polygonClipping.xor(...rings.map(r=>[r])):[];}
function stroke(points,width,tolerance,closed=false){
 if(closed)points=[...points,points[0]];
 const pieces=[];for(let i=1;i<points.length;i++)pieces.push([capsule(points[i-1],points[i],width,tolerance)]);
 return pieces.length?polygonClipping.union(...pieces):[];
}
function drillGeometry(p,tolerance){
 const d=p.hole;if(!d)return null;
 if(!Array.isArray(d)||!['ROUND','SLOT'].includes(d[0]))fail('Unknown drill shape');
 const w=positive(d[1],'drill width'),h=d[0]==='SLOT'?positive(d[2],'slot length'):w;
 if(d[0]==='ROUND'&&d.length!==2)fail('Round drill coordinates are not canonical');
 const ring=d[0]==='SLOT'?roundedRectangle(w,h,Math.min(w,h)/2,tolerance):ellipse(w/2,h/2,tolerance);
 const local=transform(ring,number(p.holeOffsetX??0,'drill offset x'),number(p.holeOffsetY??0,'drill offset y'),number(p.holeRotation??0,'drill rotation'));
 return [[transform(local,number(p.x,'pad x'),number(p.y,'pad y'),number(p.rotation??0,'pad angle'))]];
}
function padGeometry(p,tolerance){
 const s=p.pad;if(!Array.isArray(s))fail('Pad shape is unavailable');let ring;
 if(s[0]==='POLYGON'){
  const geometry=nativePolygon(s[1],tolerance);if(p.padGeometryFrame==='board')return geometry;
  if(p.padGeometryFrame!=='local')fail('Custom pad coordinate frame is unknown');
  return geometry.map(poly=>poly.map(r=>transform(r,p.x,p.y,p.rotation??0)));
 }
 if(s[0]==='RECT'||s[0]==='OVAL')ring=roundedRectangle(s[1],s[2],s[0]==='OVAL'?Math.min(s[1],s[2])/2:s[3]??0,tolerance);
 else if(s[0]==='ELLIPSE')ring=ellipse(s[1]/2,s[2]/2,tolerance);
 else if(s[0]==='NGON'){positive(s[1],'polygon diameter');if(!Number.isSafeInteger(s[2])||s[2]<3)fail('Invalid regular polygon');ring=Array.from({length:s[2]},(_,i)=>[s[1]/2*Math.cos(i*2*Math.PI/s[2]-Math.PI/2),s[1]/2*Math.sin(i*2*Math.PI/s[2]-Math.PI/2)]);}
 else fail('Unsupported pad shape: '+s[0]);
 return [[transform(ring,number(p.x,'pad x'),number(p.y,'pad y'),number(p.rotation??0,'pad angle'))]];
}
/** Extract physical copper only. Unknown geometry is reported, never replaced by a bounding box. */
export function modelCopper(snapshot,{net,nets,curveToleranceMil=0.02,excludeIds=[]}={}){
 if(snapshot?.units!=='mil')fail('Copper analysis requires a MIL scene');
 positive(curveToleranceMil,'curve tolerance');
 const selected=nets?new Set(nets):net!==undefined?new Set([net]):null,excludedIds=new Set(excludeIds),objects=[],unsupported=[],excluded=[],drills=[];
 const relevant=o=>Boolean(o.net)&&(!selected||selected.has(o.net));
 const missing=(snapshot.coverage?.missing??[]).map(x=>({...x,reason:'Native inventory incomplete'}));
 const error=(raw,kind,e)=>{if(relevant(raw))unsupported.push({primitiveId:raw.primitiveId,net:raw.net,kind,reason:String(e.message??e)});};
 for(const category of ['pads','vias','lines','arcs','fills','poured'])if(!Array.isArray(snapshot[category]))missing.push({category,reason:'Not enumerated'});
 for(const p of snapshot.pads??[])if(p.layer===12&&p.hole){try{const geometry=drillGeometry(p,curveToleranceMil);if(geometry)drills.push({id:p.primitiveId,geometry,bounds:polygonBounds(geometry[0])});}catch(e){missing.push({category:'drill',primitiveId:p.primitiveId,reason:String(e.message)});}}
 for(const v of snapshot.vias??[])if(v.viaType===0){try{const d=positive(v.holeDiameter,'via drill');if(d>=positive(v.diameter,'via diameter'))fail('Via drill is not smaller than its annulus');const geometry=[[transform(ellipse(d/2,d/2,curveToleranceMil),v.x,v.y)]];drills.push({id:v.primitiveId,geometry,bounds:polygonBounds(geometry[0])});}catch(e){error(v,'via',e);}}
 function add(raw,kind,layer,geometry,detail={}){
  if(!relevant(raw)||excludedIds.has(raw.primitiveId))return;
  if(typeof raw.primitiveId!=='string'||!raw.primitiveId)fail('Missing primitive identity');
  if(!geometry.length){error(raw,kind,new Error('Empty copper geometry'));return;}
  const bounds=polygonBounds(geometry.flat(1)),cuts=drills.filter(d=>!excludedIds.has(d.id)&&boxesMeet(bounds,d.bounds));
  if(cuts.length)geometry=polygonClipping.difference(geometry,...cuts.map(d=>d.geometry));
  for(const polygon of geometry){
   const bounds=polygonBounds(polygon),componentId=raw.parentPrimitiveId??raw.parentComponentPrimitiveId??raw.componentPrimitiveId??null;
   objects.push({primitiveId:raw.primitiveId,nodeId:`${raw.primitiveId}:${objects.length}`,kind,net:raw.net,layer,componentId,padNumber:raw.padNumber===undefined?null:String(raw.padNumber),geometry:polygon,bounds,areaMil2:polygonArea(polygon),...detail});
  }
 }
 for(const l of snapshot.lines??[])if(isCopperLayer(l.layer)&&relevant(l))try{add(l,'track',l.layer,[[capsule([l.startX,l.startY],[l.endX,l.endY],l.lineWidth,curveToleranceMil)]],{widthMil:l.lineWidth,lengthMil:Math.hypot(l.endX-l.startX,l.endY-l.startY)});}catch(e){error(l,'track',e);}
 for(const a of snapshot.arcs??[])if(isCopperLayer(a.layer)&&relevant(a))try{const descriptor=describeArc(a);add(a,'arc',a.layer,stroke(arcPoints(a,curveToleranceMil),a.lineWidth,curveToleranceMil),{widthMil:a.lineWidth,lengthMil:descriptor.radius*Math.abs(descriptor.sweep)});}catch(e){error(a,'arc',e);}
 for(const v of snapshot.vias??[])if(relevant(v))try{if(v.viaType!==0)fail('Blind/buried/unknown via layer span');positive(v.holeDiameter,'via drill');if(v.diameter<=v.holeDiameter)fail('Invalid via annulus');add(v,'via','*',[[transform(ellipse(v.diameter/2,v.diameter/2,curveToleranceMil),number(v.x,'via x'),number(v.y,'via y'))]],{at:[v.x,v.y],diameterMil:v.diameter,holeDiameterMil:v.holeDiameter});}catch(e){error(v,'via',e);}
 for(const p of snapshot.pads??[]){
  if(p.layer===12&&p.metallization===false){excluded.push({primitiveId:p.primitiveId,reason:'Non-plated hole'});continue;}
  if(!isCopperLayer(p.layer)&&p.layer!==12||!relevant(p))continue;
  try{if(p.layer===12&&(p.metallization!==true||!p.hole))fail('Multilayer pad lacks a verified plated drill');add(p,'pad',p.layer===12?'*':p.layer,padGeometry(p,curveToleranceMil),{at:[p.x,p.y]});}catch(e){error(p,'pad',e);}
 }
 for(const f of snapshot.fills??[])if(isCopperLayer(f.layer)&&relevant(f))try{
  if(f.fillMode!==undefined&&f.fillMode!==0&&f.fillMode!=='solid')fail('Non-solid native fill');
  let geometry=nativePolygon(f.polygon??f.complexPolygon,curveToleranceMil);
  if(f.lineWidth>0){const borders=nativeContours(f.polygon??f.complexPolygon,curveToleranceMil).map(r=>stroke(r,f.lineWidth,curveToleranceMil,true));geometry=polygonClipping.union(geometry,...borders);}
  add(f,'fill',f.layer,geometry);
 }catch(e){error(f,'fill',e);}
 const represented=new Set();
 for(const p of snapshot.poured??[]){
  const parent=(snapshot.pours??[]).find(x=>x.primitiveId===(p.pourPrimitiveId??p.primitiveId)),raw={...p,net:parent?.net??p.net,layer:parent?.layer??p.layer};represented.add(p.pourPrimitiveId??p.primitiveId);
  if(!relevant(raw)||excludedIds.has(raw.primitiveId))continue;
  try{
   if(!parent||p.fillGeometry?.verified!==true||p.fillGeometry?.units!=='mil')fail('Actual poured coordinates are not verified canonical MIL');
   if(!Array.isArray(p.pourFillsMil))fail('Actual poured geometry is missing');
   const pieces=[];
   for(const item of p.pourFillsMil){if(item.fill!==true)fail('Unsupported non-solid poured stroke');pieces.push(nativePolygon(item.path?.complexPolygon??item.path,curveToleranceMil));}
   if(pieces.length)add(raw,'poured',raw.layer,polygonClipping.union(...pieces));
  }catch(e){error(raw,'poured',e);}
 }
 for(const p of snapshot.pours??[])if(relevant(p)&&!represented.has(p.primitiveId)&&!excludedIds.has(p.primitiveId))error(p,'pour',new Error('Boundary has no enumerated actual fill'));
 for(const p of snapshot.polylines??[])if(isCopperLayer(p.layer)&&relevant(p))error(p,'polyline',new Error('Copper polyline stroke is not modeled'));
 return {objects,coverage:{complete:unsupported.length===0&&missing.length===0,curveChordErrorMil:curveToleranceMil,drillSubtraction:true,pourBoundariesConductive:false,unsupported,missing,excluded,scope:selected?[...selected]:'all provided nets',excludedIds:[...excludedIds],model:'planar copper contact with through-hole layer links; no electrical or thermal rating'}};
}
function pointSegment(p,a,b){const d=sub(b,a),n=d[0]*d[0]+d[1]*d[1];if(!n)return length(p,a);const t=Math.max(0,Math.min(1,((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1])/n));return length(p,[a[0]+t*d[0],a[1]+t*d[1]]);}
function ringContains(point,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if(pointSegment(point,a,b)<EPS)return 0;if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside?1:-1;}
export function containsPoint(point,polygon){if(ringContains(point,polygon[0])<0)return false;return !polygon.slice(1).some(r=>ringContains(point,r)>0);}
export function polygonEdges(polygon){const edges=[];for(const ring of polygon)for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];if(length(a,b)>EPS)edges.push({a,b,bounds:{minX:Math.min(a[0],b[0]),maxX:Math.max(a[0],b[0]),minY:Math.min(a[1],b[1]),maxY:Math.max(a[1],b[1])}});}return edges;}
function segmentDistance(a,b,c,d){const u=cross(sub(b,a),sub(c,a)),v=cross(sub(b,a),sub(d,a)),w=cross(sub(d,c),sub(a,c)),x=cross(sub(d,c),sub(b,c));if(u*v<0&&w*x<0)return 0;return Math.min(pointSegment(a,c,d),pointSegment(b,c,d),pointSegment(c,a,b),pointSegment(d,a,b));}
export function copperTouches(a,b,tolerance){
 if(!boxesMeet(a.bounds,b.bounds,tolerance))return false;
 if(containsPoint(a.geometry[0][0],b.geometry)||containsPoint(b.geometry[0][0],a.geometry))return true;
 a.edges??=polygonEdges(a.geometry);b.edges??=polygonEdges(b.geometry);
 for(const x of a.edges)for(const y of b.edges)if(boxesMeet(x.bounds,y.bounds,tolerance)&&segmentDistance(x.a,x.b,y.a,y.b)<=tolerance)return true;
 return false;
}
export function measureSection(objects,{net,layer,from,to}){
 if(!isCopperLayer(layer)||!Array.isArray(from)||!Array.isArray(to)||![...from,...to].every(Number.isFinite)||length(from,to)<EPS)fail('Section needs a copper layer and two distinct MIL points');
 const d=sub(to,from),span=length(from,to),polygons=objects.filter(o=>o.net===net&&copperLayersMeet(o.layer,layer)).map(o=>o.geometry),cuts=[0,1];
 for(const polygon of polygons)for(const {a,b}of polygonEdges(polygon)){const v=sub(b,a),den=cross(d,v);if(Math.abs(den)<EPS)continue;const t=cross(sub(a,from),v)/den,u=cross(sub(a,from),d)/den;if(t>0&&t<1&&u>=0&&u<=1)cuts.push(t);}
 cuts.sort((a,b)=>a-b);const unique=cuts.filter((x,i)=>!i||x-cuts[i-1]>EPS),intervals=[];
 for(let i=1;i<unique.length;i++){const a=unique[i-1],b=unique[i],t=(a+b)/2,p=[from[0]+t*d[0],from[1]+t*d[1]];if(polygons.some(g=>containsPoint(p,g))){const last=intervals.at(-1);if(last&&Math.abs(last.end-a)<EPS)last.end=b;else intervals.push({start:a,end:b});}}
 return {net,layer,from,to,intervals:intervals.map(({start,end})=>({from:[from[0]+start*d[0],from[1]+start*d[1]],to:[from[0]+end*d[0],from[1]+end*d[1]],lengthMil:(end-start)*span})),totalCopperLengthMil:intervals.reduce((n,x)=>n+(x.end-x.start)*span,0),scope:'explicit cross-section only; not a global minimum neck search'};
}

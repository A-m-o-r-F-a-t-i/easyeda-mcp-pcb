/** Deterministic geometry construction from caller-specified paths; no placement or routing search. */
const EPS=1e-9;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
const subtract=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const finitePoint=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function onSegment(p,a,b){return Math.abs(cross(subtract(b,a),subtract(p,a)))<EPS&&p[0]>=Math.min(a[0],b[0])-EPS&&p[0]<=Math.max(a[0],b[0])+EPS&&p[1]>=Math.min(a[1],b[1])-EPS&&p[1]<=Math.max(a[1],b[1])+EPS;}
function intersects(a,b,c,d){
 const u=cross(subtract(b,a),subtract(c,a)),v=cross(subtract(b,a),subtract(d,a)),w=cross(subtract(d,c),subtract(a,c)),x=cross(subtract(d,c),subtract(b,c));
 return u*v<0&&w*x<0||Math.abs(u)<EPS&&onSegment(c,a,b)||Math.abs(v)<EPS&&onSegment(d,a,b)||Math.abs(w)<EPS&&onSegment(a,c,d)||Math.abs(x)<EPS&&onSegment(b,c,d);
}
export function validateSimpleRing(points){
 if(!Array.isArray(points)||points.length<3||!points.every(finitePoint))fail('INVALID_GEOMETRY','A polygon needs at least three finite points');
 for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
  if(j===i+1||i===0&&j===points.length-1)continue;
  if(intersects(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length]))fail('SELF_INTERSECTION','The explicit copper corridor intersects itself; provide separate explicit polygons or adjust the path');
 }
 const area=points.reduce((sum,p,i)=>sum+cross(p,points[(i+1)%points.length]),0)/2;
 if(Math.abs(area)<EPS)fail('DEGENERATE_GEOMETRY','Polygon area is zero');
 return area;
}
export function copperCorridor(points,width,{miterLimit=2}={}){
 if(!Array.isArray(points)||!points.every(finitePoint)||!Number.isFinite(width)||width<=0||!Number.isFinite(miterLimit)||miterLimit<1)fail('INVALID_GEOMETRY','Copper path needs finite points, positive MIL width and miterLimit >= 1');
 const clean=points.filter((p,i)=>i===0||distance(p,points[i-1])>EPS).map(p=>[...p]);
 if(clean.length<2)fail('DEGENERATE_GEOMETRY','Copper path needs two distinct points');
 const half=width/2,segments=clean.slice(1).map((p,i)=>{const d=subtract(p,clean[i]),len=Math.hypot(...d);return {d:d.map(v=>v/len),n:[-d[1]/len,d[0]/len]};});
 const offset=(p,n,sign)=>[p[0]+n[0]*half*sign,p[1]+n[1]*half*sign];
 const side=sign=>{
  const out=[offset(clean[0],segments[0].n,sign)];
  for(let i=1;i<clean.length-1;i++){
   const a=segments[i-1],b=segments[i],den=cross(a.d,b.d),dot=a.d[0]*b.d[0]+a.d[1]*b.d[1];
   if(dot<-1+EPS)fail('REVERSED_PATH','A copper corridor cannot double back along the previous segment');
   const p=offset(clean[i],a.n,sign),q=offset(clean[i],b.n,sign);
   if(Math.abs(den)<EPS){out.push(q);continue;}
   const t=cross(subtract(q,p),b.d)/den,meeting=[p[0]+t*a.d[0],p[1]+t*a.d[1]];
   if(distance(meeting,clean[i])<=half*miterLimit+EPS)out.push(meeting);else out.push(p,q);
  }
  out.push(offset(clean.at(-1),segments.at(-1).n,sign));return out;
 };
 const ring=[...side(1),...side(-1).reverse()].filter((p,i,a)=>i===0||distance(p,a[i-1])>EPS);
 validateSimpleRing(ring);return ring;
}
export function viaArray({origin,rows,columns,pitch,angle=0,diameter,holeDiameter}){
 if(!finitePoint(origin)||!finitePoint(pitch)||!Number.isSafeInteger(rows)||rows<1||!Number.isSafeInteger(columns)||columns<1||!Number.isFinite(angle))fail('INVALID_GEOMETRY','Via array needs finite origin/pitch/angle and positive integer rows/columns');
 if(!Number.isFinite(diameter)||!Number.isFinite(holeDiameter)||holeDiameter<=0||diameter<=holeDiameter)fail('INVALID_DRILL','Via outer diameter must exceed its positive drill diameter');
 if(rows>1&&pitch[1]===0||columns>1&&pitch[0]===0)fail('DUPLICATE_POSITIONS','Nontrivial array dimensions require nonzero pitch');
 if(!Number.isSafeInteger(rows*columns)||rows*columns>100000)fail('RESOURCE_LIMIT','A single via array is limited to 100000 explicitly specified positions');
 const rad=angle*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad),out=[];
 for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){const x=col*pitch[0],y=row*pitch[1];out.push([origin[0]+x*c-y*s,origin[1]+x*s+y*c]);}
 return out;
}

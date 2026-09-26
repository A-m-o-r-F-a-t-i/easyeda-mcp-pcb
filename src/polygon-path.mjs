import {describeArc,arcBounds} from './arc-geometry.mjs';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const fmt=value=>Number(value.toFixed(4)).toString();
const emptyBounds=()=>({minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});
const addPoint=(bounds,x,y)=>{if(finite(x)&&finite(y)){bounds.minX=Math.min(bounds.minX,x);bounds.minY=Math.min(bounds.minY,y);bounds.maxX=Math.max(bounds.maxX,x);bounds.maxY=Math.max(bounds.maxY,y);}return bounds;};
const validBounds=bounds=>bounds&&[bounds.minX,bounds.minY,bounds.maxX,bounds.maxY].every(finite)&&bounds.maxX>bounds.minX&&bounds.maxY>bounds.minY;
function sourceArrays(source){if(!Array.isArray(source))return [];if(source.length&&source.every(Array.isArray))return source.flatMap(sourceArrays);return [source];}

/** Convert native EasyEDA polygon tokens to SVG paths without changing their MIL coordinates. */
export function parseComplexPolygon(source){
 const outputs=[];
 for(const tokens of sourceArrays(source)){
  if(!tokens.length)continue;
  if(tokens[0]==='R'&&tokens.length>=5&&[tokens[1],tokens[2],tokens[3],tokens[4]].every(finite)){
   const cx=tokens[1],cy=tokens[2],width=Math.abs(tokens[3]),height=Math.abs(tokens[4]),rotation=finite(tokens[6])?tokens[6]:0,bounds={minX:cx-width/2,minY:cy-height/2,maxX:cx+width/2,maxY:cy+height/2};
   if(rotation){const a=rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a),points=[[-width/2,-height/2],[width/2,-height/2],[width/2,height/2],[-width/2,height/2]].map(([x,y])=>[cx+x*c-y*s,cy+x*s+y*c]);Object.assign(bounds,{minX:Math.min(...points.map(p=>p[0])),maxX:Math.max(...points.map(p=>p[0])),minY:Math.min(...points.map(p=>p[1])),maxY:Math.max(...points.map(p=>p[1]))});}
   outputs.push({d:`M ${fmt(cx-width/2)} ${fmt(cy-height/2)} h ${fmt(width)} v ${fmt(height)} h ${fmt(-width)} Z`,bounds,transform:rotation?` transform="rotate(${fmt(rotation)} ${fmt(cx)} ${fmt(cy)})"`:''});continue;
  }
  if(tokens[0]==='CIRCLE'&&tokens.length===4&&[tokens[1],tokens[2],tokens[3]].every(finite)&&tokens[3]>0){
   const cx=tokens[1],cy=tokens[2],radius=Math.abs(tokens[3]),bounds={minX:cx-radius,minY:cy-radius,maxX:cx+radius,maxY:cy+radius};
   outputs.push({d:`M ${fmt(cx-radius)} ${fmt(cy)} A ${fmt(radius)} ${fmt(radius)} 0 1 0 ${fmt(cx+radius)} ${fmt(cy)} A ${fmt(radius)} ${fmt(radius)} 0 1 0 ${fmt(cx-radius)} ${fmt(cy)} Z`,bounds,transform:''});continue;
  }
  if(tokens.length<2||!finite(tokens[0])||!finite(tokens[1]))continue;
  let index=2,x=tokens[0],y=tokens[1],d=`M ${fmt(x)} ${fmt(y)}`;const bounds=emptyBounds();addPoint(bounds,x,y);
  while(index<tokens.length){
   const token=tokens[index];
   if(typeof token==='string'){
    const command=token.toUpperCase();if(command==='L'){index++;continue;}
    if(command==='ARC'){
     const angle=Number(tokens[index+1]),nextX=Number(tokens[index+2]),nextY=Number(tokens[index+3]);if(![angle,nextX,nextY].every(finite))break;
     const chord=Math.hypot(nextX-x,nextY-y),sine=Math.sin(Math.abs(angle)*Math.PI/360),radius=chord>0&&Math.abs(sine)>1e-9?Math.abs(chord/(2*sine)):chord/2;
     d+=` A ${fmt(radius)} ${fmt(radius)} 0 ${Math.abs(angle)>180?1:0} ${angle>=0?1:0} ${fmt(nextX)} ${fmt(nextY)}`;if(Math.abs(angle)>1e-9&&chord>1e-9){const arc=arcBounds(describeArc({startX:x,startY:y,endX:nextX,endY:nextY,arcAngle:angle}));addPoint(bounds,arc.minX,arc.minY);addPoint(bounds,arc.maxX,arc.maxY);}addPoint(bounds,nextX,nextY);x=nextX;y=nextY;index+=4;continue;
    }
    index++;continue;
   }
   const nextX=Number(tokens[index]),nextY=Number(tokens[index+1]);if(![nextX,nextY].every(finite))break;d+=` L ${fmt(nextX)} ${fmt(nextY)}`;addPoint(bounds,nextX,nextY);x=nextX;y=nextY;index+=2;
  }
  if(validBounds(bounds))outputs.push({d:`${d} Z`,bounds,transform:''});
 }
 return outputs;
}

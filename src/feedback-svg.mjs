import { parseComplexPolygon } from './vector-inspection.mjs';
import { describeArc, arcSvgPath, arcBounds } from './arc-geometry.mjs';
import { padBounds } from './component-overview.mjs';
const f=n=>Number(n.toFixed(4));
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const finiteBox=b=>b&&['minX','maxX','minY','maxY'].every(k=>Number.isFinite(b[k]));
const merge=boxes=>{const b=boxes.filter(finiteBox);return b.length?{minX:Math.min(...b.map(x=>x.minX)),maxX:Math.max(...b.map(x=>x.maxX)),minY:Math.min(...b.map(x=>x.minY)),maxY:Math.max(...b.map(x=>x.maxY))}:null;};
const intersects=(a,b)=>!b||finiteBox(a)&&a.maxX>=b.minX&&a.minX<=b.maxX&&a.maxY>=b.minY&&a.minY<=b.maxY;
export function renderFeedbackSvg(scene,options={}){
 const side=options.side??'top',mx=side==='bottom'?-1:1,region=options.region??null;
 const layers=options.layers?new Set(options.layers):null;
 const visible=l=>layers?layers.has(l):side==='both'||l===11||l===12||l===47||l===48||(side==='bottom'?[2,4,6,8,10]:[1,3,5,7,9]).includes(l);
 const colors={1:'#d73a49',2:'#3178c6',3:'#d7dde5',4:'#d7dde5',9:'#b4bdca',10:'#b4bdca',11:'#f2bd50',12:'#b2a2db',48:'#b4bdca'};
 const selectedNets=new Set(options.nets??[]),style=o=>`stroke="${colors[o.layer]??'#a8b4c5'}"${selectedNets.size&&o.net&&!selectedNets.has(o.net)?' opacity="0.25"':''}`;
 const tag=o=>`data-primitive-id="${esc(o.primitiveId)}" data-net="${esc(o.net)}" data-layer="${esc(o.layer)}"`;
 const shapes=[],allBounds=[],labels=[],omitted=[];
 const add=(o,b,svg)=>{if(!finiteBox(b))return;allBounds.push(b);if(visible(o.layer)&&intersects(b,region))shapes.push(`<g ${tag(o)} ${style(o)}><title>${esc([o.primitiveId,o.net].filter(Boolean).join(' / '))}</title>${svg}</g>`);};
 const path=(o,source,fill='none')=>{const paths=parseComplexPolygon(source);if(!paths.length){omitted.push({id:o.primitiveId,reason:'unavailable or unsupported polygon source'});return;}for(const p of paths)add(o,p.bounds,`<path d="${p.d}"${p.transform??''} fill="${fill}" fill-opacity="0.15" stroke-width="${f(o.lineWidth??1)}"/>`);};
 for(const o of scene.pours??[])path(o,o.complexPolygon);
 for(const o of scene.poured??[]){
  const parent=(scene.pours??[]).find(p=>p.primitiveId===(o.pourPrimitiveId??o.primitiveId));
  if(!parent||o.fillGeometry?.verified!==true){omitted.push({id:o.primitiveId,reason:'actual fill coordinates not available in canonical mil'});continue;}
  for(const fill of o.pourFillsMil??[])path({...o,layer:parent.layer,net:parent.net},fill.path?.complexPolygon,colors[parent.layer]??'#8b98a7');
 }
 for(const kind of ['fills','regions','polylines'])for(const o of scene[kind]??[])path(o,o.polygon??o.complexPolygon,kind==='fills'?(colors[o.layer]??'#8b98a7'):'none');
 for(const o of scene.lines??[]){const r=(o.lineWidth??1)/2,b={minX:Math.min(o.startX,o.endX)-r,maxX:Math.max(o.startX,o.endX)+r,minY:Math.min(o.startY,o.endY)-r,maxY:Math.max(o.startY,o.endY)+r};add(o,b,`<line x1="${f(o.startX)}" y1="${f(o.startY)}" x2="${f(o.endX)}" y2="${f(o.endY)}" stroke-width="${f(o.lineWidth??1)}" stroke-linecap="round"/>`);}
 for(const o of scene.arcs??[]){try{const arc=describeArc(o);add(o,arcBounds(arc,(o.lineWidth??1)/2),`<path d="${arcSvgPath(arc,n=>String(f(n)))}" fill="none" stroke-width="${f(o.lineWidth??1)}"/>`);}catch(e){omitted.push({id:o.primitiveId,reason:String(e.message)});}}
 for(const c of scene.components??[]){
  const source=c.graphics?.body??c.graphics?.assembly??c.graphics?.silkscreen;
  if(source)path({...c,layer:c.layer,lineWidth:1},source);
  else if(finiteBox(c.nativeBounds)){const b=c.nativeBounds;add(c,b,`<rect x="${f(b.minX)}" y="${f(b.minY)}" width="${f(b.maxX-b.minX)}" height="${f(b.maxY-b.minY)}" fill="none" stroke-dasharray="5 4" stroke-width="1"/>`);}
  if(visible(c.layer)&&intersects(c.nativeBounds??{minX:c.x,maxX:c.x,minY:c.y,maxY:c.y},region))labels.push({x:mx*c.x,y:-c.y,text:c.designator??c.primitiveId,id:c.primitiveId,kind:'component'});
 }
 const byId=new Map(scene.components.map(c=>[c.primitiveId,c]));
 const pinLabels=[];
 for(const p of scene.pads){
  const b=padBounds(p);if(!b){omitted.push({id:p.primitiveId,reason:'pad shape unavailable'});continue;}
  let element='',s=p.pad,type=s[0],w=s[1],height=s[2]??w;
  if(type==='ELLIPSE')element=`<ellipse rx="${f(w/2)}" ry="${f(height/2)}"/>`;
  else if(type==='OVAL'||type==='RECT')element=`<rect x="${f(-w/2)}" y="${f(-height/2)}" width="${f(w)}" height="${f(height)}" rx="${f(type==='OVAL'?Math.min(w,height)/2:s[3]??0)}"/>`;
  else if(type==='NGON')element=`<polygon points="${Array.from({length:s[2]},(_,i)=>{const a=i*2*Math.PI/s[2]-Math.PI/2;return `${f(w/2*Math.cos(a))},${f(w/2*Math.sin(a))}`;}).join(' ')}"/>`;
  else if(type==='POLYGON')element=parseComplexPolygon(s[1]).map(x=>`<path d="${x.d}"/>`).join('');
  add(p,b,`<g${type==='POLYGON'&&p.padGeometryFrame==='board'?'':` transform="translate(${f(p.x)} ${f(p.y)}) rotate(${f(p.rotation??0)})"`} fill="${colors[p.layer]??'#b2a2db'}" stroke-width="0.7">${element}</g>`);
  if(p.layer===12&&p.physicalDrill?.present!==false&&p.hole){const hw=p.hole[1],hh=p.hole[2]??hw;add(p,b,`<g transform="translate(${f(p.x)} ${f(p.y)}) rotate(${f(p.rotation??0)}) translate(${f(p.holeOffsetX??0)} ${f(p.holeOffsetY??0)}) rotate(${f(p.holeRotation??0)})" fill="#15181e" stroke="#8b96a8" stroke-width="0.6">${p.hole[0]==='SLOT'?`<rect x="${f(-hw/2)}" y="${f(-hh/2)}" width="${f(hw)}" height="${f(hh)}" rx="${f(hw/2)}"/>`:`<circle r="${f(hw/2)}"/>`}</g>`);}
  if(options.pinLabels!==false&&visible(p.layer)&&intersects(b,region)){
   const c=byId.get(p.parentPrimitiveId??p.componentPrimitiveId??p.parentComponentPrimitiveId);
   pinLabels.push({x:mx*p.x,y:-p.y,id:p.primitiveId,net:p.net??'',text:`${c?.designator??'PAD'}.${p.padNumber??''} / ${p.net||'NC'}`});
  }
 }
 for(const v of scene.vias??[]){const r=v.diameter/2;add({...v,layer:12},{minX:v.x-r,maxX:v.x+r,minY:v.y-r,maxY:v.y+r},`<circle cx="${f(v.x)}" cy="${f(v.y)}" r="${f(r)}" fill="#b2a2db" stroke-width="0.7"/><circle cx="${f(v.x)}" cy="${f(v.y)}" r="${f(v.holeDiameter/2)}" fill="#15181e" stroke-width="0.6"/>`);}
 const outlineBounds=merge((scene.polylines??[]).filter(o=>o.layer===11).flatMap(o=>parseComplexPolygon(o.polygon??o.complexPolygon).map(p=>p.bounds)));
 const bounds=region??(options.fit==='all'?null:outlineBounds)??merge(allBounds);if(!bounds)throw Error('No geometry is available for this view');
 const within=p=>p.x>=Math.min(mx*bounds.minX,mx*bounds.maxX)&&p.x<=Math.max(mx*bounds.minX,mx*bounds.maxX)&&p.y>=-bounds.maxY&&p.y<=-bounds.minY;
 for(let i=labels.length-1;i>=0;i--)if(!within(labels[i]))labels.splice(i,1);
 for(let i=pinLabels.length-1;i>=0;i--)if(!within(pinLabels[i]))pinLabels.splice(i,1);
 const margin=options.marginMil??40,font=options.fontMil??18;
 const x0=(mx===1?bounds.minX:-bounds.maxX)-margin,x1=(mx===1?bounds.maxX:-bounds.minX)+margin,y0=-bounds.maxY-margin,y1=-bounds.minY+margin;
 const legendX=x1+font*2,rowHeight=font*1.5;
 pinLabels.sort((a,b)=>a.y-b.y||a.x-b.x||a.text.localeCompare(b.text));
 const dense=pinLabels.length>24,columns=dense?Math.min(4,Math.ceil(pinLabels.length/18)):1,rows=Math.ceil(pinLabels.length/columns),columnWidth=Math.max(250,...pinLabels.map(x=>(x.text.length+5)*font*0.6));
 const width=dense?Math.max(x1-x0,columns*columnWidth+font*2):x1-x0+(pinLabels.length?columnWidth+font*3:0);
 const height=dense?y1-y0+(rows+2)*rowHeight:Math.max(y1-y0,pinLabels.length*rowHeight+2*font);
 const text=labels.map(l=>`<text data-primitive-id="${esc(l.id)}" x="${f(l.x)}" y="${f(l.y)}" font-size="${font}" text-anchor="middle" fill="#f5f5f5" stroke="#15181e" stroke-width="2" paint-order="stroke">${esc(l.text)}</text>`);
 for(let i=0;i<pinLabels.length;i++){
  const p=pinLabels[i];
  if(dense){const x=x0+font+Math.floor(i/rows)*columnWidth,y=y1+rowHeight+(i%rows)*rowHeight;
   text.push(`<g data-primitive-id="${esc(p.id)}" data-net="${esc(p.net)}"><text x="${f(p.x)}" y="${f(p.y)}" font-size="${f(font*0.55)}" text-anchor="middle" fill="#fff" stroke="#15181e" stroke-width="1" paint-order="stroke">${i+1}</text><text x="${f(x)}" y="${f(y)}" font-size="${font}" fill="#e6ebf2">${i+1}: ${esc(p.text)}</text></g>`);
  }else{const y=y0+font+i*rowHeight;text.push(`<g data-primitive-id="${esc(p.id)}" data-net="${esc(p.net)}"><path d="M ${f(p.x)} ${f(p.y)} L ${f(legendX-font)} ${f(y)}" stroke="#a6afbe" stroke-opacity="0.55" stroke-width="0.6" fill="none"/><circle cx="${f(p.x)}" cy="${f(p.y)}" r="2" fill="#f2bd50"/><text x="${f(legendX)}" y="${f(y)}" font-size="${font}" fill="#e6ebf2">${esc(p.text)}</text></g>`);}
 }
 for(const s of scene.strings??[])if(visible(s.layer)&&Number.isFinite(s.x)&&Number.isFinite(s.y)&&within({x:mx*s.x,y:-s.y}))text.push(`<text data-primitive-id="${esc(s.primitiveId)}" x="${f(mx*s.x)}" y="${f(-s.y)}" font-size="${f(s.fontSize??font)}" transform="rotate(${f(-(s.rotation??0)*mx)} ${f(mx*s.x)} ${f(-s.y)})" fill="#cbd3df">${esc(s.text)}</text>`);
 const metadata={schema:'easyeda-pcb-feedback-svg/v3',document:scene.document,sourceUnits:'mil',side,fit:region?'region':options.fit==='all'?'all':'board',observation:side==='bottom'?'bottom view mirrored once about board Y axis':'top view',pinLabelCount:pinLabels.length,pinLabelLayout:dense?'indexed-grid':'leaders',legendColumns:columns,componentLabelCount:labels.length,componentsOutsideView:scene.components.filter(c=>!within({x:mx*c.x,y:-c.y})).map(c=>c.designator??c.primitiveId),coverage:scene.coverage,omitted,notes:['Dashed component boxes are native graphical BBoxes, not physical bodies.','Labels and leader lines are inspection overlays; they are not written to PCB silkscreen.']};
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="${Math.round(1600*height/width)}" viewBox="${f(x0)} ${f(y0)} ${f(width)} ${f(height)}"><title>PCB ${esc(side)} view</title><metadata>${esc(JSON.stringify(metadata))}</metadata><rect x="${f(x0)}" y="${f(y0)}" width="${f(width)}" height="${f(height)}" fill="#15181e"/><defs><clipPath id="board-view"><rect x="${f(mx===1?bounds.minX:-bounds.maxX)}" y="${f(-bounds.maxY)}" width="${f(bounds.maxX-bounds.minX)}" height="${f(bounds.maxY-bounds.minY)}"/></clipPath></defs><g clip-path="url(#board-view)"><g transform="scale(${mx},-1)">${shapes.join('')}</g></g><g font-family="Arial,Microsoft YaHei,sans-serif" dominant-baseline="middle">${text.join('')}</g></svg>`;
 return {svg,metadata,viewBox:{x:x0,y:y0,width,height},boardBounds:bounds};
}

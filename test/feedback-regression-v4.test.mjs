import test from 'node:test';
import assert from 'node:assert/strict';
import {parseComplexPolygon} from '../src/polygon-path.mjs';
import {renderFeedbackSvg} from '../src/feedback-svg.mjs';

test('two semicircular native arcs retain the complete circle bounds',()=>{
 const paths=parseComplexPolygon([-20,0,'ARC',180,20,0,'ARC',180,-20,0]);
 assert.equal(paths.length,1);const b=paths[0].bounds;
 for(const [key,value] of Object.entries({minX:-20,maxX:20,minY:-20,maxY:20}))assert.ok(Math.abs(b[key]-value)<1e-7,key);
});
test('rotated native rectangle bounds include all transformed corners',()=>{
 const [p]=parseComplexPolygon(['R',0,0,100,20,0,45]);
 const radius=60*Math.SQRT1_2;assert.ok(Math.abs(p.bounds.maxX-radius)<1e-7);assert.ok(Math.abs(p.bounds.maxY-radius)<1e-7);
});
test('compound copper inspection paths preserve holes with even-odd fill',()=>{
 const scene={units:'mil',components:[],pads:[],lines:[],arcs:[],vias:[],pours:[],poured:[],polylines:[],regions:[],strings:[],fills:[{primitiveId:'ring',net:'GND',layer:2,lineWidth:0,complexPolygon:[[-20,0,'ARC',180,20,0,'ARC',180,-20,0],[-10,0,'ARC',180,10,0,'ARC',180,-10,0]]}]};
 const result=renderFeedbackSvg(scene,{side:'bottom',pinLabels:false});
 assert.deepEqual(result.metadata.omitted,[]);assert.match(result.svg,/fill-rule="evenodd"/);assert.match(result.svg,/M -20 0[\s\S]*M -10 0/);
});

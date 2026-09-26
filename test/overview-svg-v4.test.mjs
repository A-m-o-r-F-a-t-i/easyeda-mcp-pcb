import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOverview,padBounds} from '../src/component-overview.mjs';
import {renderFeedbackSvg} from '../src/feedback-svg.mjs';
import {createMockEda,readScene,runEdit} from './fixture.mjs';

test('overview returns complete MIL component, footprint, pad and orientation data',async()=>{
 const environment=createMockEda(),scene=await readScene(environment),overview=buildOverview(scene,{angles:[30],orientationCoordinates:true});
 assert.equal(overview.schema,'easyeda-pcb-overview/v4');assert.equal(overview.units,'mil');assert.equal(overview.totalComponents,2);assert.equal(overview.totalPads,4);assert.equal(overview.components[0].footprint.name,'SOIC-2');assert.equal(overview.components[0].value,'TEST');assert.equal(overview.components[0].dimensions.body.width,40);assert.equal(overview.components[0].dimensions.assembly,null);assert.equal(overview.components[0].orientations[0].sides.left[0].net,'SIG');assert.equal(overview.components[0].orientations.find(item=>item.angle===30).pads.length,2);assert.equal(overview.nets.length,2);assert.equal(overview.coverage.atomic,false);
});

test('bottom-side orientation derives from actual pads without a second mirror',async()=>{
 const environment=createMockEda();await runEdit(environment,[{op:'place',items:[{ref:'U1',at:[400,320],side:'bottom',angle:90}]}]);const overview=buildOverview(await readScene(environment),{angles:[90],orientationCoordinates:true}),component=overview.components[0],current=component.orientations.find(item=>item.angle===90);
 assert.equal(component.side,'bottom');assert.equal(current.side,'bottom');assert.ok(current.pads[0].offset[1]>0);assert.equal(current.pads[0].net,'SIG');
});

test('world-coordinate polygon pads are not translated or rotated twice',()=>{
 const pad={primitiveId:'world-pad',padNumber:'1',net:'SIG',layer:1,x:110,y:210,rotation:90,pad:['POLYGON',[100,200,'L',120,200,120,220,100,220,100,200]],padGeometryFrame:'board'};
 assert.deepEqual(padBounds(pad),{minX:100,maxX:120,minY:200,maxY:220});assert.equal(padBounds({...pad,padGeometryFrame:'unknown'}),null);
 const rendered=renderFeedbackSvg({document:{uuid:'test'},components:[],pads:[pad],polylines:[{primitiveId:'outline',layer:11,polygon:[0,0,'L',300,0,300,300,0,300,0,0]}],coverage:{passes:1}},{side:'top',pinLabels:true});
 assert.match(rendered.svg,/PAD.1 \/ SIG/);assert.doesNotMatch(rendered.svg,/translate\(110 210\)/);assert.equal(rendered.metadata.schema,'easyeda-pcb-feedback-svg/v4');
});

test('bottom SVG mirrors board geometry exactly once and keeps annotation text readable',async()=>{
 const environment=createMockEda();await runEdit(environment,[{op:'place',items:[{ref:'U1',at:[400,320],side:'bottom'}]}]);const rendered=renderFeedbackSvg(await readScene(environment),{side:'bottom',pinLabels:true});
 assert.equal(rendered.metadata.observation,'bottom view mirrored once about board Y axis');assert.match(rendered.svg,/scale\(-1,-1\)/);assert.doesNotMatch(rendered.svg,/<g[^>]*scale\(-1,-1\)[^>]*>.*scale\(-1,-1\)/s);assert.match(rendered.svg,/U1\.1 \/ SIG/);assert.match(rendered.svg,/data-primitive-id=/);
});

test('dense pin labels use compact columns and board fit reports staging objects',()=>{
 const pads=Array.from({length:84},(_,index)=>({primitiveId:`p${index}`,padNumber:String(index),net:`N${index}`,layer:1,x:20+(index%12)*20,y:20+Math.floor(index/12)*20,pad:['ELLIPSE',10,10]}));
 const scene={document:{uuid:'test'},components:[{primitiveId:'off',designator:'OFF',x:10000,y:10000,layer:1}],pads,polylines:[{primitiveId:'outline',layer:11,polygon:[0,0,'L',300,0,300,200,0,200,0,0]}],coverage:{passes:1}};
 const rendered=renderFeedbackSvg(scene,{pinLabels:true});assert.equal(rendered.metadata.pinLabelLayout,'indexed-grid');assert.equal(rendered.metadata.legendColumns,4);assert.ok(rendered.viewBox.height<1200);assert.deepEqual(rendered.metadata.componentsOutsideView,['OFF']);assert.ok(rendered.boardBounds.maxX<10000);
});

test('missing native body and assembly geometry remain unknown rather than fabricated',()=>{
 const scene={document:{uuid:'test'},project:{uuid:'p'},layers:[],components:[{primitiveId:'c',designator:'U1',x:0,y:0,rotation:0,layer:1,graphics:{body:null,assembly:null,silkscreen:null},nativeBounds:null}],pads:[],polylines:[],regions:[],coverage:{complete:true}};
 const component=buildOverview(scene).components[0];assert.equal(component.dimensions.body,null);assert.equal(component.dimensions.assembly,null);assert.equal(component.dimensions.nativeGraphics,null);assert.equal(component.dimensions.padEnvelope,null);
});

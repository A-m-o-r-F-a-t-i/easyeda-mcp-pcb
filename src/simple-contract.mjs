import * as z from 'zod/v4';

/** The public contract contains editing intent, never execution credentials. */
export const point = z.tuple([z.number().finite(), z.number().finite()]);
export const layer = z.union([z.string().min(1), z.number().int()]).describe('Layer name (top, bottom, top_silkscreen, inner_1, multi, board_outline) or native layer ID');
export const target = z.union([z.string().min(1).describe('Exact PCB document UUID'), z.object({documentUuid:z.string().min(1), projectUuid:z.string().min(1).optional(), windowId:z.string().min(1).optional(), tabId:z.string().min(1).optional()}).strict()]).optional();
export const region = z.object({left:z.number().finite(), right:z.number().finite(), top:z.number().finite(), bottom:z.number().finite()}).strict();
export const selector = z.object({kind:z.enum(['component','pad','via','line','arc','polyline','fill','pour','region','string','attribute']).optional(), refs:z.array(z.string().min(1)).optional(), ids:z.array(z.string().min(1)).optional(), net:z.string().optional(), layer:layer.optional(), region:region.optional(), all:z.boolean().optional()}).strict().describe('Explicit IDs/designators, net, layer, rectangle, or all:true; filters are intersected');
const endpoint = z.union([point,z.string().min(1).describe('Designator.padNumber, e.g. U1.12; or an exact pad ID')]);
export const shape = z.discriminatedUnion('type',[
  z.object({type:z.literal('circle'),center:point,diameter:z.number().positive()}).strict(),
  z.object({type:z.literal('rectangle'),at:point,size:point}).strict(),
  z.object({type:z.literal('polygon'),points:z.array(point).min(3)}).strict(),
  z.object({type:z.literal('path'),source:z.array(z.union([z.number().finite(),z.enum(['L','ARC','CIRCLE','R'])])).min(4)}).strict().describe('Native polygon path; coordinates/radii are in request units; ARC angles are degrees')
]);
const padShape = z.object({type:z.enum(['ellipse','oval','rect','ngon','polygon']),size:point.optional(),round:z.number().nonnegative().optional(),diameter:z.number().positive().optional(),sides:z.number().int().min(3).optional(),points:z.array(point).min(3).optional()}).strict();
const drill = z.object({diameter:z.number().positive(),length:z.number().positive().optional(),offset:point.optional(),angle:z.number().finite().optional()}).strict();
const pose = {at:point.optional(),angle:z.number().finite().optional(),side:z.enum(['top','bottom']).optional(),locked:z.boolean().optional()};
const placeItem=z.object({ref:z.string().min(1),...pose}).strict();
const routeItem=z.object({from:endpoint.optional(),to:endpoint.optional(),through:z.array(point).optional(),points:z.array(point).min(2).optional(),net:z.string().optional(),layer:layer.optional(),width:z.number().positive().optional(),locked:z.boolean().optional()}).strict().refine(x=>Boolean(x.points)!==Boolean(x.from!==undefined&&x.to!==undefined),'Supply points OR from and to');
const patch=z.object({at:point.optional(),angle:z.number().finite().optional(),side:z.enum(['top','bottom']).optional(),layer:layer.optional(),locked:z.boolean().optional(),net:z.string().optional(),width:z.number().positive().optional(),start:point.optional(),end:point.optional(),diameter:z.number().positive().optional(),holeDiameter:z.number().positive().optional(),text:z.string().optional(),fontSize:z.number().positive().optional(),fontFamily:z.string().optional(),mirror:z.boolean().optional(),keyVisible:z.boolean().optional(),valueVisible:z.boolean().optional(),value:z.union([z.string(),z.number(),z.boolean()]).optional(),name:z.string().optional(),priority:z.number().finite().optional(),preserveSilos:z.boolean().optional(),geometry:shape.optional(),ruleTypes:z.array(z.number().int()).optional(),padShape:padShape.optional(),hole:drill.nullable().optional(),metallization:z.boolean().optional(),padNumber:z.string().optional()}).strict().refine(x=>Object.keys(x).length>0,'A modification needs at least one field');
const operations=[
 z.object({op:z.literal('place'),items:z.array(placeItem).min(1)}).strict(),
 z.object({op:z.literal('transform'),select:selector,translate:point.optional(),center:point.optional(),angle:z.number().finite().optional()}).strict(),
 z.object({op:z.literal('align'),refs:z.array(z.string().min(1)).min(1),axis:z.enum(['x','y']),value:z.number().finite()}).strict(),
 z.object({op:z.literal('distribute'),refs:z.array(z.string().min(1)).min(1),axis:z.enum(['x','y']),start:z.number().finite(),spacing:z.number().finite()}).strict(),
 z.object({op:z.literal('radial'),refs:z.array(z.string().min(1)).min(1),center:point,radius:z.number().nonnegative(),startAngle:z.number().finite(),stepAngle:z.number().finite(),orientationOffset:z.number().finite().optional()}).strict(),
 z.object({op:z.literal('route'),net:z.string().optional(),layer:layer.optional(),width:z.number().positive().optional(),items:z.array(routeItem).min(1)}).strict(),
 z.object({op:z.literal('arc'),from:endpoint,to:endpoint,angle:z.number().finite(),net:z.string().optional(),layer,width:z.number().positive(),locked:z.boolean().optional()}).strict(),
 z.object({op:z.literal('via'),positions:z.array(point).min(1),net:z.string(),diameter:z.number().positive(),holeDiameter:z.number().positive(),locked:z.boolean().optional()}).strict(),
 z.object({op:z.literal('pad'),at:point,number:z.string().default(''),net:z.string().default(''),layer,padShape,hole:drill.nullable().optional(),angle:z.number().finite().optional(),metallization:z.boolean().optional(),locked:z.boolean().optional()}).strict(),
 z.object({op:z.literal('hole'),positions:z.array(point).min(1),diameter:z.number().positive(),length:z.number().positive().optional(),angle:z.number().finite().optional()}).strict(),
 ...['fill','pour','outline'].map(op=>z.object({op:z.literal(op),geometry:shape,layer:layer.optional(),net:z.string().optional(),width:z.number().positive().optional(),name:z.string().optional(),priority:z.number().finite().optional(),preserveSilos:z.boolean().optional(),locked:z.boolean().optional()}).strict()),
 z.object({op:z.literal('region'),geometry:shape,layer,ruleTypes:z.array(z.number().int()).min(1).describe('Native EPCB_PrimitiveRegionRuleType enum values; pcb_read kind=operations lists them'),name:z.string().optional(),width:z.number().positive().optional(),locked:z.boolean().optional()}).strict(),
 z.object({op:z.literal('text'),items:z.array(z.object({at:point,text:z.string(),angle:z.number().finite().optional(),layer:layer.optional(),fontSize:z.number().positive().optional(),width:z.number().positive().optional(),fontFamily:z.string().optional(),mirror:z.boolean().optional()}).strict()).min(1),layer:layer.optional(),fontSize:z.number().positive().optional(),width:z.number().positive().optional()}).strict(),
 z.object({op:z.literal('modify'),select:selector,set:patch}).strict(),
 z.object({op:z.literal('delete'),select:selector}).strict(),
 z.object({op:z.literal('cleanup'),refs:z.array(z.string().min(1)).optional(),unlock:z.boolean().default(true),hideDesignators:z.boolean().default(true)}).strict(),
 z.object({op:z.literal('stackup'),copperLayers:z.number().int().min(2).max(32)}).strict(),
 z.object({op:z.literal('add_component'),library:z.object({libraryUuid:z.string().min(1),uuid:z.string().min(1),libraryType:z.string().optional()}).strict(),at:point,side:z.enum(['top','bottom']).default('top'),angle:z.number().finite().optional(),ref:z.string().optional()}).strict()
];
export const operation=z.union(operations);
export const editSchema={target,units:z.enum(['mm','mil']).default('mm'),operations:z.array(operation).min(1).optional(),planPath:z.string().min(1).optional().describe('Optional JSON file containing this same request; use operations for normal work'),save:z.boolean().default(true),view:z.enum(['auto','local','board','none']).default('auto'),bridgeUrl:z.string().url().optional()};
export const catalog=()=>({schema:'easyeda-pcb-edit/v3',units:'mm by default',operations:z.toJSONSchema(operation),notes:['MCP-first: these are simplified native operations, not an automatic layout or router.','Coordinates and paths are supplied by the caller. No collision/angle/design gate is inserted.','Unset fields retain their current values. Batch size is an implementation detail.','Partial results report applied, failed, unknown and not executed actions without automatic replay.']});

/** Flatten repeated actions while preserving the supplied order and pin endpoints. */
export function expandOperations(input){
 const out=[];
 const push=(action,source,item)=>out.push({...action,sourceIndex:source,itemIndex:item,index:out.length});
 input.forEach((op,source)=>{
  if(op.op==='place')op.items.forEach((item,i)=>push({op:'place_one',...item},source,i));
  else if(op.op==='route')op.items.forEach((item,i)=>{
   const points=item.points??[item.from,...(item.through??[]),item.to];
   const common={net:item.net??op.net,layer:item.layer??op.layer,width:item.width??op.width,locked:item.locked,netEndpoints:[item.from,item.to].filter(x=>typeof x==='string')};
   if(common.layer===undefined||common.width===undefined)throw Error(`operations[${source}].items[${i}]: route layer and width required`);
   if(common.net===undefined&&!common.netEndpoints.length)throw Error(`operations[${source}].items[${i}]: explicit coordinate route requires net`);
   for(let j=1;j<points.length;j++)push({op:'line',...common,from:points[j-1],to:points[j]},source,i);
  });
  else if(op.op==='via'||op.op==='hole')op.positions.forEach((at,i)=>{const {positions,...rest}=op;push({...rest,at},source,i);});
  else if(op.op==='text')op.items.forEach((item,i)=>push({op:'text_one',layer:item.layer??op.layer,fontSize:item.fontSize??op.fontSize,width:item.width??op.width,...item},source,i));
  else if(op.op==='align'||op.op==='distribute')op.refs.forEach((ref,i)=>push({op:'axis_place',ref,axis:op.axis,value:op.op==='align'?op.value:op.start+i*op.spacing},source,i));
  else if(op.op==='radial')op.refs.forEach((ref,i)=>{const degrees=op.startAngle+i*op.stepAngle,a=degrees*Math.PI/180;push({op:'place_one',ref,at:[op.center[0]+op.radius*Math.cos(a),op.center[1]+op.radius*Math.sin(a)],...(op.orientationOffset!==undefined?{angle:degrees+op.orientationOffset}:{})},source,i);});
  else push(op,source,0);
 });
 return out;
}

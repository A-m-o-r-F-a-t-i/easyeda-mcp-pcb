import * as z from 'zod/v4';
import {editSchema,expandOperations} from '../src/simple-contract.mjs';
import {createNativeHelpers} from '../src/simple-native.mjs';
import {simpleEditRuntime} from '../src/simple-runtime.mjs';
import {collectSceneRuntime} from '../src/component-overview.mjs';

export const target={documentUuid:'pcb-test',projectUuid:'project-test',windowId:'window-test',tabId:'pcb-test@project-test'};
let executionCounter=0;
const primitiveNames={component:'Component',pad:'Pad',line:'Line',arc:'Arc',via:'Via',polyline:'Polyline',fill:'Fill',pour:'Pour',poured:'Poured',region:'Region',string:'String',attribute:'Attribute'};
const signatures={line:['net','layer','startX','startY','endX','endY','lineWidth','primitiveLock'],arc:['net','layer','startX','startY','endX','endY','arcAngle','lineWidth','interactiveMode','primitiveLock'],via:['net','x','y','holeDiameter','diameter','viaType','a','b','primitiveLock'],pad:['layer','padNumber','x','y','rotation','pad','net','hole','holeOffsetX','holeOffsetY','holeRotation','metallization','padType','a','b','c','primitiveLock'],polyline:['net','layer','polygon','lineWidth','primitiveLock'],fill:['layer','complexPolygon','net','fillMode','lineWidth','primitiveLock'],pour:['net','layer','complexPolygon','fillMode','preserveSilos','pourName','pourPriority','lineWidth','primitiveLock'],region:['layer','complexPolygon','ruleType','regionName','lineWidth','primitiveLock'],string:['layer','x','y','text','fontFamily','fontSize','lineWidth','alignMode','rotation','reverse','expansion','mirror','primitiveLock'],component:['component','layer','x','y','rotation','primitiveLock']};

export function createMockEda(componentCount=2){
 const stores=Object.fromEntries(Object.keys(primitiveNames).map(kind=>[kind,new Map()])),calls=[];let nextId=0;
 const groups={netClass:[],differentialPair:[],equalLengthGroup:[],padPairGroup:[]};
 const add=(kind,data)=>{const object={primitiveId:`${kind}-${nextId++}`,...data};stores[kind].set(object.primitiveId,object);return object;};
 const find=id=>{for(const store of Object.values(stores))if(store.has(id))return store.get(id);return null;};
 const componentPins=async componentId=>{
  const component=stores.component.get(componentId);if(!component)return [];
  const radians=(component.rotation??0)*Math.PI/180,mirror=component.layer===2?-1:1;
  return [-1,1].map((direction,index)=>{const localX=direction*20*mirror;return {primitiveId:`${componentId}-p${index}`,parentPrimitiveId:componentId,componentPrimitiveId:componentId,padNumber:String(index+1),net:index?'GND':'SIG',layer:component.layer,x:component.x+localX*Math.cos(radians),y:component.y+localX*Math.sin(radians),rotation:component.rotation??0,pad:['RECT',12,8,0],hole:null,metallization:true,primitiveLock:false};});
 };
 const allPins=async()=>(await Promise.all([...stores.component.keys()].map(componentPins))).flat();
 const eda={
  dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:target.documentUuid,documentType:3,tabId:target.tabId,name:'TEST_PCB'})},
  dmt_Project:{getCurrentProjectInfo:async()=>({uuid:target.projectUuid,name:'TEST_PROJECT',friendlyName:'TEST_PROJECT',data:[{name:'Board1',pcb:{uuid:target.documentUuid,name:'PCB1'},schematic:{uuid:'schematic-test',name:'SCH1'}}]})},
  dmt_EditorControl:{openDocument:async uuid=>`${uuid}@${target.projectUuid}`},
  sys_Environment:{getEditorCurrentVersion:async()=>'4.1.60'},
  pcb_Document:{getCanvasOrigin:async()=>({offsetX:0,offsetY:0}),save:async()=>true,getPrimitiveAtPoint:async(x,y)=>[...Object.values(stores).flatMap(store=>[...store.values()])].filter(object=>object.x===x&&object.y===y),getPrimitivesInRegion:async(left,right,top,bottom)=>[...Object.values(stores).flatMap(store=>[...store.values()])].filter(object=>Number.isFinite(object.x)&&object.x>=Math.min(left,right)&&object.x<=Math.max(left,right)&&object.y>=Math.min(top,bottom)&&object.y<=Math.max(top,bottom)),importChanges:async()=>true},
  pcb_Layer:{getAllLayers:async()=>[{id:1,name:'Top',layerStatus:1},{id:2,name:'Bottom',layerStatus:1},{id:3,name:'Top Silk',layerStatus:1},{id:4,name:'Bottom Silk',layerStatus:1},{id:11,name:'Board Outline',layerStatus:1},{id:12,name:'Multi',layerStatus:1}],setTheNumberOfCopperLayers:async count=>count>=2},
  pcb_MathPolygon:{createPolygon:source=>({getSource:()=>source})},
  pcb_Primitive:{
   getPrimitivesBBox:async ids=>{const object=find(ids[0]);if(!object)return undefined;if(object.pad?.[0]==='POLYGON')return {minX:100,minY:200,maxX:120,maxY:220};if(Number.isFinite(object.x)&&Number.isFinite(object.y))return {minX:object.x-30,minY:object.y-20,maxX:object.x+30,maxY:object.y+20};if(Number.isFinite(object.startX))return {minX:Math.min(object.startX,object.endX),minY:Math.min(object.startY,object.endY),maxX:Math.max(object.startX,object.endX),maxY:Math.max(object.startY,object.endY)};return undefined;},
   getPrimitiveBoardLine:(id,layers)=>{const component=stores.component.get(id);return component&&layers[0]===48?{getSource:()=>['CIRCLE',component.x,component.y,20]}:undefined;}
  },
  pcb_Net:{getAllNets:async()=>['SIG','GND','5V'],getNetlist:async()=>({SIG:['U1.1','U2.1'],GND:['U1.2','U2.2']})},
  pcb_Drc:{
   getCurrentRuleConfiguration:async()=>({name:'Default'}),getAllRuleConfigurations:async()=>[{name:'Default'}],getNetRules:async()=>[],getNetByNetRules:async()=>[],getRegionRules:async()=>[],getRealTimeDrcStatus:async()=>false,
   getAllNetClasses:async()=>groups.netClass,getAllDifferentialPairs:async()=>groups.differentialPair,getAllEqualLengthNetGroups:async()=>groups.equalLengthGroup,getAllPadPairGroups:async()=>groups.padPairGroup,
   createNetClass:async(name,nets,color)=>{groups.netClass.push({name,nets,color});return true;},deleteNetClass:async name=>{groups.netClass=groups.netClass.filter(item=>item.name!==name);return true;},modifyNetClassName:async(name,newName)=>{const item=groups.netClass.find(value=>value.name===name);if(item)item.name=newName;return Boolean(item);},addNetToNetClass:async(name,nets)=>{const item=groups.netClass.find(value=>value.name===name);if(item)item.nets=[...new Set([...(item.nets??[]),...nets])];return Boolean(item);},removeNetFromNetClass:async(name,nets)=>{const item=groups.netClass.find(value=>value.name===name);if(item)item.nets=(item.nets??[]).filter(net=>!nets.includes(net));return Boolean(item);},
   createDifferentialPair:async(name,positiveNet,negativeNet)=>{groups.differentialPair.push({name,positiveNet,negativeNet});return true;},deleteDifferentialPair:async name=>{groups.differentialPair=groups.differentialPair.filter(item=>item.name!==name);return true;},modifyDifferentialPairName:async(name,newName)=>{const item=groups.differentialPair.find(value=>value.name===name);if(item)item.name=newName;return Boolean(item);},modifyDifferentialPairPositiveNet:async(name,net)=>{const item=groups.differentialPair.find(value=>value.name===name);if(item)item.positiveNet=net;return Boolean(item);},modifyDifferentialPairNegativeNet:async(name,net)=>{const item=groups.differentialPair.find(value=>value.name===name);if(item)item.negativeNet=net;return Boolean(item);},
   createEqualLengthNetGroup:async(name,nets,color)=>{groups.equalLengthGroup.push({name,nets,color});return true;},deleteEqualLengthNetGroup:async name=>{groups.equalLengthGroup=groups.equalLengthGroup.filter(item=>item.name!==name);return true;},modifyEqualLengthNetGroupName:async(name,newName)=>{const item=groups.equalLengthGroup.find(value=>value.name===name);if(item)item.name=newName;return Boolean(item);},addNetToEqualLengthNetGroup:async(name,nets)=>{const item=groups.equalLengthGroup.find(value=>value.name===name);if(item)item.nets=[...new Set([...(item.nets??[]),...nets])];return Boolean(item);},removeNetFromEqualLengthNetGroup:async(name,nets)=>{const item=groups.equalLengthGroup.find(value=>value.name===name);if(item)item.nets=(item.nets??[]).filter(net=>!nets.includes(net));return Boolean(item);},
   createPadPairGroup:async(name,padPairs)=>{groups.padPairGroup.push({name,padPairs});return true;},deletePadPairGroup:async name=>{groups.padPairGroup=groups.padPairGroup.filter(item=>item.name!==name);return true;},modifyPadPairGroupName:async(name,newName)=>{const item=groups.padPairGroup.find(value=>value.name===name);if(item)item.name=newName;return Boolean(item);},addPadPairToPadPairGroup:async(name,pairs)=>{const item=groups.padPairGroup.find(value=>value.name===name);if(item)item.padPairs=[...(item.padPairs??[]),...pairs];return Boolean(item);},removePadPairFromPadPairGroup:async(name,pairs)=>{const item=groups.padPairGroup.find(value=>value.name===name);if(item)item.padPairs=(item.padPairs??[]).filter(pair=>!pairs.some(remove=>JSON.stringify(remove)===JSON.stringify(pair)));return Boolean(item);}
  }
 };
 for(const [kind,Name]of Object.entries(primitiveNames))eda[`pcb_Primitive${Name}`]={
  get:async primitiveId=>stores[kind].get(primitiveId),
  getAll:async()=>kind==='pad'?[...stores.pad.values(),...await allPins()]:[...stores[kind].values()],
  create:async(...args)=>{calls.push({kind,action:'create',args});return add(kind,Object.fromEntries((signatures[kind]??[]).map((key,index)=>[key,args[index]])));},
  modify:async(primitiveId,set)=>{calls.push({kind,action:'modify',primitiveId,set});const object=stores[kind].get(primitiveId);if(!object)return undefined;Object.assign(object,set);return object;},
  delete:async primitiveId=>{calls.push({kind,action:'delete',primitiveId});return stores[kind].delete(primitiveId);}
 };
 eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId=componentPins;
 for(let index=0;index<componentCount;index++){
  const component=add('component',{designator:`U${index+1}`,name:'MCU',footprint:{name:'SOIC-2',uuid:'fp'},component:{name:'DEVICE'},otherProperty:{Value:'TEST'},layer:1,x:index*100,y:0,rotation:0,primitiveLock:false});
  add('attribute',{parentPrimitiveId:component.primitiveId,key:'Designator',value:component.designator,keyVisible:false,valueVisible:true,layer:3,x:component.x,y:0,fontSize:50,lineWidth:8});
 }
 add('polyline',{layer:11,net:'',polygon:[0,0,'L',1000,0,1000,800,0,800,0,0],lineWidth:5,primitiveLock:false});
 return {eda,stores,calls,groups,add};
}

export const parseEdit=operations=>z.object(editSchema).strict().parse({operations,save:false,view:'none'});
export async function runEdit(environment,operations){const request=parseEdit(operations);return simpleEditRuntime(environment.eda,{target,executionId:`test-${executionCounter++}`,offset:0,operations:expandOperations(request.operations)},createNativeHelpers);}
export async function readScene(environment){return collectSceneRuntime(environment.eda,{target,geometry:true},createNativeHelpers);}

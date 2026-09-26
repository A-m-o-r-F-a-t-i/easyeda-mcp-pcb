import {assertAllowedTarget,executeBridgeCode,resolveBridge,saveDocument} from './bridge.mjs';

/** Serialized into EasyEDA; no Node APIs. */
export async function nativeActionRuntime(eda,request){
 const state=(object,key)=>{const getter=object?.['getState_'+key[0].toUpperCase()+key.slice(1)];const value=typeof getter==='function'?getter.call(object):object?.[key];return value&&typeof value.getSource==='function'?value.getSource():value;};
 const fields=['primitiveId','designator','name','uniqueId','parentPrimitiveId','componentPrimitiveId','padNumber','net','layer','x','y','rotation','startX','startY','endX','endY','lineWidth','diameter','holeDiameter','primitiveLock','pad','hole','metallization','pourName','pourPriority','preserveSilos','complexPolygon','pourPrimitiveId','pourFills','text','key','value','keyVisible','valueVisible'];
 const serialize=object=>Object.fromEntries(fields.map(key=>[key,state(object,key)]).filter(([,value])=>value!==undefined));
 const id=object=>state(object,'primitiveId');
 const guard=async()=>{const document=await eda.dmt_SelectControl.getCurrentDocumentInfo(),project=await eda.dmt_Project.getCurrentProjectInfo();if(document?.uuid!==request.target.documentUuid||document?.documentType!==3||project?.uuid!==request.target.projectUuid)throw Error('PCB target changed during native action');return {document,project};};
 const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
 const fingerprint=value=>{const text=stable(value);let hash=14695981039346656037n;for(let i=0;i<text.length;i++)hash=((hash^BigInt(text.charCodeAt(i)))*1099511628211n)&0xffffffffffffffffn;return hash.toString(16).padStart(16,'0');};
 const association=async document=>{const project=await eda.dmt_Project.getCurrentProjectInfo(),matches=(project?.data??[]).filter(item=>item?.pcb?.uuid===document.uuid);if(matches.length!==1||!matches[0]?.schematic?.uuid)throw Error('Exactly one associated schematic is required');const board=matches[0];return {projectUuid:project.uuid,boardName:board.name??null,pcbUuid:board.pcb.uuid,pcbName:board.pcb.name??null,schematicUuid:board.schematic.uuid,schematicName:board.schematic.name??null};};
 const snapshot=async document=>{
  const componentsRaw=await eda.pcb_PrimitiveComponent.getAll(),components=componentsRaw.map(serialize).sort((a,b)=>String(a.primitiveId).localeCompare(String(b.primitiveId))),pads=[];
  for(const component of componentsRaw){const componentId=id(component),pins=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);if(!Array.isArray(pins))throw Error('Component pads unavailable: '+componentId);pads.push(...pins.map(pin=>({...serialize(pin),componentPrimitiveId:componentId})));}
  const standalone=await eda.pcb_PrimitivePad.getAll(),known=new Set(pads.map(item=>item.primitiveId));for(const pad of standalone){const value=serialize(pad);if(!known.has(value.primitiveId))pads.push(value);}
  const all=async api=>(await api.getAll()).map(serialize).sort((a,b)=>String(a.primitiveId).localeCompare(String(b.primitiveId)));
  const value={association:await association(document),components,pads:pads.sort((a,b)=>String(a.primitiveId).localeCompare(String(b.primitiveId))),lines:await all(eda.pcb_PrimitiveLine),vias:await all(eda.pcb_PrimitiveVia),pours:await all(eda.pcb_PrimitivePour),strings:await all(eda.pcb_PrimitiveString),attributes:await all(eda.pcb_PrimitiveAttribute),netlist:await eda.pcb_Net.getNetlist()};
  return {snapshot:value,fingerprint:fingerprint(value)};
 };
 const document=(await guard()).document;
 if(request.kind==='rebuildPours'){
  const pours=await eda.pcb_PrimitivePour.getAll(),byId=new Map(pours.map(pour=>[id(pour),pour])),targetIds=request.pourIds?.length?[...new Set(request.pourIds)]:[...byId.keys()];
  const missing=targetIds.filter(value=>!byId.has(value));if(missing.length)throw Error('Unknown pour IDs: '+missing.join(', '));
  const before=(await eda.pcb_PrimitivePoured.getAll()).map(serialize),results=[];
  if(typeof eda.pcb_PrimitivePour.rebuildCopperRegions==='function'){await guard();const value=await eda.pcb_PrimitivePour.rebuildCopperRegions(targetIds);if(value===false)throw Error('Native repour returned false');results.push({method:'batch',acknowledged:value===true});}
  else for(const pourId of targetIds){const pour=byId.get(pourId);if(typeof pour?.rebuildCopperRegion!=='function')throw Error('No public repour API for '+pourId);await guard();const value=await pour.rebuildCopperRegion();if(value===false)throw Error('Native repour returned false for '+pourId);results.push({pourId,returnedFillId:id(value)??null});}
  await guard();const after=(await eda.pcb_PrimitivePoured.getAll()).map(serialize),targetSet=new Set(targetIds),beforeMap=new Map(before.map(item=>[item.primitiveId,item])),afterMap=new Map(after.map(item=>[item.primitiveId,item])),collateral=[];
  for(const primitiveId of new Set([...beforeMap.keys(),...afterMap.keys()])){const a=beforeMap.get(primitiveId),b=afterMap.get(primitiveId),boundary=b?.pourPrimitiveId??a?.pourPrimitiveId;if(!targetSet.has(boundary)&&stable(a)!==stable(b))collateral.push({primitiveId,boundary,action:!a?'added':!b?'removed':'modified'});}
  const fills=targetIds.map(pourId=>{const items=after.filter(item=>item.pourPrimitiveId===pourId);return {pourId,pouredIds:items.map(item=>item.primitiveId),fillPartCount:items.reduce((sum,item)=>sum+(Array.isArray(item.pourFills)?item.pourFills.length:0),0)};});
  return {targetIds,results,fills,collateralChanges:collateral,units:'mil'};
 }
 if(request.kind==='syncSchematic'){
  const before=await snapshot(document),schematicUuid=before.snapshot.association.schematicUuid;
  await guard();const nativeAccepted=await eda.pcb_Document.importChanges(schematicUuid);if(nativeAccepted!==true)throw Error('importChanges was not accepted');
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const findButton=()=>{const modal=globalThis?.document?.getElementById?.('dlgShowImportChanges');if(!modal?.querySelectorAll)return [];return [...modal.querySelectorAll('button')].filter(button=>button?.getAttribute?.('data-test')==='Apply Changes'||button?.getAttribute?.('title')==='应用修改');};
  let after=await snapshot(document),confirmationApplied=false;
  if(after.fingerprint===before.fingerprint){let buttons=findButton();for(let i=0;i<40&&!buttons.length;i++){await delay(50);await guard();buttons=findButton();}if(buttons.length>1)throw Error('Ambiguous Apply Changes controls');if(buttons.length===1){if(buttons[0].disabled||buttons[0].getAttribute?.('aria-disabled')==='true')throw Error('Apply Changes is disabled');buttons[0].click();confirmationApplied=true;for(let i=0;i<600&&findButton().length;i++){await delay(50);await guard();}}}
  let previous=after;for(let i=0;i<8;i++){await delay(125);await guard();const current=await snapshot(document);if(current.fingerprint===previous.fingerprint){after=current;break;}previous=current;after=current;}
  return {nativeAccepted:true,confirmationApplied,changed:after.fingerprint!==before.fingerprint,association:after.snapshot.association,beforeFingerprint:before.fingerprint,afterFingerprint:after.fingerprint,beforeCounts:Object.fromEntries(Object.entries(before.snapshot).filter(([,value])=>Array.isArray(value)).map(([key,value])=>[key,value.length])),afterCounts:Object.fromEntries(Object.entries(after.snapshot).filter(([,value])=>Array.isArray(value)).map(([key,value])=>[key,value.length]))};
 }
 throw Error('Unknown native action');
}

const code=request=>`return await (${nativeActionRuntime.toString()})(eda,${JSON.stringify(request)});`;
export async function rebuildPours({target,pourIds,save=true}){assertAllowedTarget(target);const bridge=await resolveBridge({windowId:target.windowId}),result=await executeBridgeCode(bridge,code({kind:'rebuildPours',target,pourIds}),180_000),saved=save?await saveDocument(bridge,target):null;return {ok:true,target,saved,...result};}
export async function syncSchematic({target,save=true}){assertAllowedTarget(target);const bridge=await resolveBridge({windowId:target.windowId}),result=await executeBridgeCode(bridge,code({kind:'syncSchematic',target}),180_000),saved=save&&result.changed?await saveDocument(bridge,target):null;return {ok:true,target,saved,...result};}

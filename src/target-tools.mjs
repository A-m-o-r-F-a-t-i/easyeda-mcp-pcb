import {assertAllowedTarget,executeBridgeCode,fetchJson,resolveBridge} from './bridge.mjs';

export async function identityRuntime(eda){
 const project=await eda.dmt_Project.getCurrentProjectInfo(),document=await eda.dmt_SelectControl.getCurrentDocumentInfo();
 return {project:project?{uuid:project.uuid,name:project.friendlyName??project.name}:null,document:document??null,boards:(project?.data??[]).filter(item=>item.pcb).map(item=>({name:item.name,pcbUuid:item.pcb.uuid,pcbName:item.pcb.name,schematicUuid:item.schematic?.uuid??null}))};
}

export async function listTargets({projectUuid}={}){
 const bridge=await resolveBridge({requireEda:false}),listing=await fetchJson(`${bridge.baseUrl}/eda-windows`,{},2500),items=[],failures=[];
 for(const window of listing.windows??[]){
  if(!window.connected)continue;
  try{
   const identity=await executeBridgeCode({...bridge,windowId:window.windowId},`return await (${identityRuntime.toString()})(eda);`);
   if(projectUuid&&identity.project?.uuid!==projectUuid)continue;
   items.push({windowId:window.windowId,...identity});
  }catch(error){failures.push({windowId:window.windowId,error:String(error?.message??error)});}
 }
 return {ok:true,connectedWindowCount:(listing.windows??[]).filter(item=>item.connected).length,items,failures,mutatesEditor:false};
}

export async function openTargetRuntime(eda,target){
 const before=await eda.dmt_SelectControl.getCurrentDocumentInfo(),project=await eda.dmt_Project.getCurrentProjectInfo();
 if(project?.uuid!==target.projectUuid)throw Error('Project mismatch; project switching is not supported');
 if(!(project.data??[]).some(board=>board.pcb?.uuid===target.documentUuid))throw Error('PCB is not associated with this project');
 if(before?.uuid===target.documentUuid&&before?.documentType===3)return {status:'already_open',document:before,verified:true};
 const tabId=await eda.dmt_EditorControl.openDocument(target.documentUuid);if(!tabId)throw Error('openDocument returned no tab ID');
 const after=await eda.dmt_SelectControl.getCurrentDocumentInfo(),afterProject=await eda.dmt_Project.getCurrentProjectInfo();
 if(after?.uuid!==target.documentUuid||after?.documentType!==3||afterProject?.uuid!==target.projectUuid)throw Error('Open-target readback mismatch');
 return {status:'opened',tabId,document:after,verified:true};
}

export async function openTarget(target){
 assertAllowedTarget(target);
 const bridge=await resolveBridge({windowId:target.windowId});
 return {ok:true,target,...await executeBridgeCode(bridge,`return await (${openTargetRuntime.toString()})(eda,${JSON.stringify(target)});`)};
}

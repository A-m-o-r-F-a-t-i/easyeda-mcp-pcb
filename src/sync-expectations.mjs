// Explicit caller-supplied ECO goals. Validates all fields before a native import.
const record=(value,label)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error(label+' must be an object');return value;};
const only=(value,keys,label)=>{record(value,label);for(const key of Object.keys(value))if(!keys.includes(key))throw Error(label+': unknown field '+key);};
const text=(value,label,empty=false)=>{if(typeof value!=='string'||(!empty&&!value.trim()))throw Error(label+': string required');};
export function validateSyncExpectations(expectedAfter) {
  if(expectedAfter===undefined)return undefined;
  only(expectedAfter,['components','pads'],'expectedAfter');
  const components=expectedAfter.components===undefined?[]:expectedAfter.components;
  const pads=expectedAfter.pads===undefined?[]:expectedAfter.pads;
  if(!Array.isArray(components)||!Array.isArray(pads)||components.length+pads.length===0)throw Error('expectedAfter requires nonempty component or pad expectations');
  if(components.length>1000||pads.length>5000)throw Error('ECO expectation count exceeds supported limit');
  const componentGoals=new Map(),padGoals=new Set();
  for(const goal of components){
    only(goal,['uniqueId','present','designator','name'],'component goal');
    text(goal.uniqueId,'uniqueId');
    if(goal.present!==undefined&&typeof goal.present!=='boolean')throw Error('present must be boolean');
    if(goal.designator!==undefined)text(goal.designator,'designator');
    if(goal.name!==undefined)text(goal.name,'name',true);
    if(goal.present===false&&(goal.designator!==undefined||goal.name!==undefined))throw Error('Component absence goal contradicts attribute requirements');
    if(componentGoals.has(goal.uniqueId))throw Error('Duplicate component goal: '+goal.uniqueId);
    componentGoals.set(goal.uniqueId,goal);
  }
  for(const goal of pads){
    only(goal,['primitiveId','componentUniqueId','padNumber','net'],'pad goal');
    text(goal.net,'net',true);
    const raw=goal.primitiveId!==undefined,logical=goal.componentUniqueId!==undefined||goal.padNumber!==undefined;
    if(raw===logical)throw Error('Pad goal requires exactly one identity: primitiveId OR componentUniqueId plus padNumber');
    if(raw)text(goal.primitiveId,'primitiveId');
    else{
      text(goal.componentUniqueId,'componentUniqueId');text(goal.padNumber,'padNumber');
      if(componentGoals.get(goal.componentUniqueId)?.present===false)throw Error('Pad goal contradicts component absence');
    }
    const key=JSON.stringify(raw?['id',goal.primitiveId]:['logical',goal.componentUniqueId,goal.padNumber]);
    if(padGoals.has(key))throw Error('Duplicate pad goal identity');
    padGoals.add(key);
  }
  return {components,pads};
}
export function evaluateSyncExpectations(snapshot, expectedAfter) {
  const goals=validateSyncExpectations(expectedAfter);
  if(goals===undefined)return {supplied:false,verified:null,checks:[],unmet:[],scope:'No explicit ECO goal was supplied'};
  if(!Array.isArray(snapshot?.components)||!Array.isArray(snapshot?.pads))throw Error('ECO postcondition data unavailable');
  const checks=[];
  for(const expected of goals.components){
    const matches=snapshot.components.filter(c=>c.uniqueId===expected.uniqueId);
    const present=expected.present!==false;
    const fields=['designator','name'].filter(k=>expected[k]!==undefined);
    const matched=present?matches.length===1&&fields.every(k=>matches[0][k]===expected[k]):matches.length===0;
    checks.push({kind:'component',expected,actual:matches.map(c=>({primitiveId:c.primitiveId,uniqueId:c.uniqueId,designator:c.designator,name:c.name})),matched});
  }
  for(const expected of goals.pads){
    let matches=[],resolution;
    if(expected.primitiveId!==undefined){matches=snapshot.pads.filter(p=>p.primitiveId===expected.primitiveId);resolution=matches.length===1?'exact-primitive-id':matches.length?'ambiguous-primitive-id':'pad-not-found';}
    else{
      const components=snapshot.components.filter(c=>c.uniqueId===expected.componentUniqueId);
      if(components.length!==1)resolution=components.length?'ambiguous-source-component':'component-not-found';
      else if(typeof components[0].primitiveId!=='string'||!components[0].primitiveId)resolution='component-parent-unavailable';
      else{
        const parent=components[0].primitiveId;
        matches=snapshot.pads.filter(p=>p.componentPrimitiveId===parent&&String(p.padNumber)===expected.padNumber);
        resolution=matches.length?'logical-component-pad':'pad-not-found';
      }
    }
    const ids=matches.map(p=>p.primitiveId);
    const physicalIdentityValid=ids.every(id=>typeof id==='string'&&id)&&new Set(ids).size===ids.length;
    const matched=matches.length>0&&physicalIdentityValid&&matches.every(p=>p.net===expected.net)&&(expected.primitiveId===undefined||matches.length===1);
    checks.push({kind:'pad-net',expected,resolution,actual:matches.map(p=>({primitiveId:p.primitiveId,componentPrimitiveId:p.componentPrimitiveId,padNumber:p.padNumber,net:p.net})),matched});
  }
  return {supplied:true,verified:checks.every(c=>c.matched),checks,unmet:checks.filter(c=>!c.matched),scope:'Only explicitly supplied component fields and raw or logical component-pad net goals'};
}

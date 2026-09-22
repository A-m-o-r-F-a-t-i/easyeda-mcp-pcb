/** Count findings, not native UI grouping nodes. Preserve original objects and category paths. */
export function summarizeDrcReport(raw) {
  if (!Array.isArray(raw)) throw new Error('Invalid verbose DRC response: expected an error array');
  const items=[], active=new Set(), seenIds=new Set(), countsByCategory=Object.create(null), countsByRule=Object.create(null);
  let visitedNodes=0,groupCount=0;
  const walk=(nodes,path,depth)=>{
    if(depth>32)throw new Error('DRC grouping depth exceeds supported limit');
    for(const node of nodes){
      if(++visitedNodes>200000)throw new Error('DRC report exceeds supported node limit');
      if(!node||typeof node!=='object'||Array.isArray(node))throw new Error('Invalid DRC report node');
      if(active.has(node))throw new Error('Cyclic DRC report');
      active.add(node);
      if(Object.hasOwn(node,'list')){
        if(!Array.isArray(node.list))throw new Error('Invalid DRC group list; cannot treat unreadable entries as empty');
        groupCount++;
        walk(node.list,[...path,String(node.name??'unnamed group')],depth+1);
      }else{
        if(!Object.keys(node).length)throw new Error('Empty DRC finding has no diagnostic identity');
        const id=node.globalIndex;
        if(typeof id==='string'&&id){if(seenIds.has(id))throw new Error('Duplicate DRC finding identity: '+id);seenIds.add(id);}
        const category=path[0]??node.errorType??'Ungrouped';const rule=node.ruleName??node.errorObjType??node.name??'Unspecified';
        countsByCategory[category]=(countsByCategory[category]??0)+1;
        countsByRule[rule]=(countsByRule[rule]??0)+1;
        items.push({...node,categoryPath:[...path]});
      }
      active.delete(node);
    }
  };
  walk(raw,[],0);
  return {verified:true,total:items.length,topLevelCount:raw.length,groupCount,countsByCategory,countsByRule,items};
}

import { inspectSilkscreen } from './inspection.mjs';

// Bounded, read-only aggregation of the public paginated inspection contract.
export async function inspectAllSilkscreen(request, inspect = inspectSilkscreen) {
  const maximumObjects = request.maximumObjects ?? 2000;
  const take = async () => {
    const items = [], identities = new Set();
    let total = null;
    for (let offset = 0; ; offset += 100) {
      const page = await inspect({...request, offset, limit:100});
      if(page.missingIds?.length)throw Error('Requested silkscreen IDs are missing: '+page.missingIds.join(', '));
      if (!Number.isInteger(page.total) || page.total > maximumObjects) throw Error('Silkscreen total unavailable or exceeds maximumObjects; full inspection not performed');
      if (total !== null && total !== page.total) throw Error('Silkscreen object count changed across pages');
      total = page.total;
      if (page.offset !== offset || !Array.isArray(page.items)) throw Error('Invalid silkscreen page');
      for (const item of page.items) {
        if (!item.primitiveId || identities.has(item.primitiveId)) throw Error('Missing or duplicate silkscreen identity across pages');
        identities.add(item.primitiveId); items.push(item);
      }
      if (!page.hasMore) break;
      if (!page.items.length) throw Error('Empty incomplete silkscreen page');
    }
    if (items.length !== total) throw Error('Incomplete silkscreen page assembly');
    if(request.ids?.some(id=>!identities.has(id)))throw Error('Requested silkscreen IDs were not found in the complete result');
    return items;
  };
  const first = await take(), all = await take();
  if (JSON.stringify(first) !== JSON.stringify(all)) throw Error('Silkscreen changed during two full reads; settle edits and repeat');
  const overlaps = [], detailLimit = request.detailLimit ?? 1000;
  let overlapCount = 0;
  const visible = all.filter(item => item.visibility !== 'hidden-attribute');
  for (let i = 0; i < visible.length; i++) for (let j = i+1; j < visible.length; j++) {
    const a=visible[i], b=visible[j], u=a.bounds, v=b.bounds;
    if (a.layer===b.layer && u && v && Math.min(u.maxX,v.maxX)>Math.max(u.minX,v.minX) && Math.min(u.maxY,v.maxY)>Math.max(u.minY,v.minY)) {
      overlapCount++;
      if (overlaps.length < detailLimit) overlaps.push([a.primitiveId,b.primitiveId]);
    }
  }
  const offset=request.offset??0, limit=request.limit??40;
  const warningCounts = {};
  for (const item of visible) for (const warning of item.warnings??[]) warningCounts[warning]=(warningCounts[warning]??0)+1;
  return {ok:true, units:'mil', total:all.length, evaluatedObjectCount:all.length, visibleObjectCount:visible.length,
    offset,limit,hasMore:offset+limit<all.length,items:all.slice(offset,offset+limit),
    overlapCount,sameLayerBBoxOverlaps:overlaps,overlapDetailsTruncated:overlapCount>overlaps.length,warningCounts,
    missingIds:[],selectionComplete:true,
    coverage:{overlaps:'all selected objects including cross-page pairs',stableFullReads:2,atomic:false},
    limitations:['BBox overlap is a candidate, not glyph collision.','Native font, solder mask, assembly occlusion, hidden layers and physical printing need separate verification.','Returned detail pagination does not restrict the all-object comparison.']};
}

import { assertAllowedTarget, executeBridgeCode, fetchJson, loadPlanSource, resolveBridge } from './bridge.mjs';

// These runtimes use only the documented EasyEDA API; no foreground browser actions.
export async function identityRuntime(eda) {
  const p = await eda.dmt_Project.getCurrentProjectInfo();
  const d = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  const p2 = await eda.dmt_Project.getCurrentProjectInfo();
  const d2 = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (p?.uuid !== p2?.uuid || d?.uuid !== d2?.uuid || (d?.parentProjectUuid && d.parentProjectUuid !== p?.uuid)) throw Error('Window identity changed during discovery');
  return {
    project: p ? { uuid: p.uuid, name: p.friendlyName ?? p.name } : null,
    document: d ?? null,
    boards: (p?.data ?? []).filter(x => x.pcb).map(x => ({ name: x.name, pcbUuid: x.pcb.uuid, pcbName: x.pcb.name, schematicUuid: x.schematic?.uuid ?? null })),
  };
}

export async function listTargets({ bridgeUrl, projectUuid } = {}) {
  const bridge = await resolveBridge({ bridgeUrl, requireEda: false });
  const listing = await fetchJson(`${bridge.baseUrl}/eda-windows`, {}, 2500);
  const items = [], failures = [];
  let filteredOutWindowCount = 0;
  for (const w of listing.windows ?? []) {
    if (!w.connected) continue;
    try {
      const identity = await executeBridgeCode({ ...bridge, windowId: w.windowId }, `return await (${identityRuntime.toString()})(eda);`);
      if (projectUuid && identity.project?.uuid !== projectUuid) { filteredOutWindowCount++; continue; }
      items.push({ bridgeUrl: bridge.baseUrl, windowId: w.windowId, ...identity });
    } catch (error) { failures.push({ windowId: w.windowId, error: String(error?.message ?? error) }); }
  }
  return { ok: true, bridgeUrl: bridge.baseUrl, activeWindowId: listing.activeWindowId ?? null, connectedWindowCount: (listing.windows ?? []).filter(x => x.connected).length, filteredOutWindowCount, items, failures, mutatesActiveWindow: false, note: 'Only minimal project/document identity is read from connected windows. An absent target must be connected; it is never replaced by the active window.' };
}

const reconnectDelay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function isWindowReconnectError(error) {
  const code = String(error?.code ?? '');
  const outcome = String(error?.details?.outcome ?? '');
  const message = String(error?.message ?? error ?? '');
  return code === 'WINDOW_DISCONNECTED' || (outcome === 'unknown' && /(?:window|eda).*disconnect|disconnect.*(?:window|eda)/i.test(message));
}

export async function rediscoverExactPcbTarget({ target, bridgeUrl, attempts = 20, delayMs = 125 } = {}) {
  if (!target?.projectUuid || !target?.documentUuid) throw Error('Exact projectUuid/documentUuid required for reconnect discovery');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) throw Error('Reconnect attempts must be an integer from 1 to 100');
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000) throw Error('Reconnect delayMs must be an integer from 0 to 5000');
  let lastListing = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastListing = await listTargets({ bridgeUrl, projectUuid: target.projectUuid });
    const matches = lastListing.items.filter(item =>
      item.project?.uuid === target.projectUuid &&
      item.document?.uuid === target.documentUuid &&
      item.document?.documentType === 3
    );
    if (matches.length > 1) {
      const error = new Error('More than one connected EasyEDA window exposes the exact project and PCB; reconnect is ambiguous');
      error.code = 'AMBIGUOUS_TARGET_RECONNECT';
      error.details = { projectUuid: target.projectUuid, documentUuid: target.documentUuid, windowIds: matches.map(item => item.windowId) };
      throw error;
    }
    if (matches.length === 1) {
      const item = matches[0];
      const recoveredTarget = {
        projectUuid: target.projectUuid,
        documentUuid: target.documentUuid,
        windowId: item.windowId,
        ...(item.document.tabId ? { tabId: item.document.tabId } : {}),
      };
      return { ok: true, attempt, bridgeUrl: item.bridgeUrl ?? lastListing.bridgeUrl, target: recoveredTarget, identity: item };
    }
    if (attempt < attempts && delayMs > 0) await reconnectDelay(delayMs);
  }
  const error = new Error('Exact EasyEDA project and PCB did not reconnect within the guarded discovery window');
  error.code = 'TARGET_NOT_RECOVERED';
  error.details = {
    projectUuid: target.projectUuid,
    documentUuid: target.documentUuid,
    attempts,
    connectedWindowCount: lastListing?.connectedWindowCount ?? null,
    failures: lastListing?.failures ?? [],
  };
  throw error;
}

export async function openTargetRuntime(eda, request) {
  const { target, expectedCurrentDocumentUuid } = request;
  if (!target.projectUuid || !target.windowId || !target.documentUuid) throw Error('Exact projectUuid/windowId/documentUuid required');
  const before = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  const project = await eda.dmt_Project.getCurrentProjectInfo();
  if (project?.uuid !== target.projectUuid) throw Error('Project mismatch before open; project switching is not supported');
  if (!(project.data ?? []).some(board => board.pcb?.uuid === target.documentUuid)) throw Error('PCB not associated with the exact current project');
  if ((before?.uuid ?? null) !== expectedCurrentDocumentUuid) throw Error('Current document changed before open; review current state');
  if (before?.uuid === target.documentUuid && before?.documentType === 3) return { status: 'already_open', document: before, verified: true };
  const fresh = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if ((fresh?.uuid ?? null) !== expectedCurrentDocumentUuid || (await eda.dmt_Project.getCurrentProjectInfo())?.uuid !== target.projectUuid) throw Error('Target changed during open preflight');
  const tabId = await eda.dmt_EditorControl.openDocument(target.documentUuid);
  if (!tabId) throw Error('openDocument returned no tab ID');
  const after = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (after?.uuid !== target.documentUuid || after?.documentType !== 3 || (await eda.dmt_Project.getCurrentProjectInfo())?.uuid !== target.projectUuid) throw Error('Open target readback mismatch; inspect selected window');
  return { status: 'opened', tabId, before: before ?? null, document: after, verified: true, scope: 'document inside explicitly selected EDA window only' };
}

export async function openTarget(request) {
  assertAllowedTarget(request.target);
  const bridge = await resolveBridge({ bridgeUrl: request.bridgeUrl, windowId: request.target.windowId });
  try {
    return { ok: true, ...await executeBridgeCode(bridge, `return await (${openTargetRuntime.toString()})(eda,${JSON.stringify(request)});`) };
  } catch (error) {
    if (!isWindowReconnectError(error)) throw error;
    let recovered;
    try {
      recovered = await rediscoverExactPcbTarget({ target: request.target, bridgeUrl: bridge.baseUrl });
    } catch (recoveryError) {
      error.details = {
        ...(error.details ?? {}),
        recoveryCode: recoveryError?.code ?? null,
        recoveryError: String(recoveryError?.message ?? recoveryError),
        recoveryDetails: recoveryError?.details ?? null,
        requiresReadbackBeforeRetry: true,
      };
      throw error;
    }
    return {
      ok: true,
      status: 'opened_after_window_reconnect',
      tabId: recovered.target.tabId ?? null,
      before: request.expectedCurrentDocumentUuid === null ? null : { uuid: request.expectedCurrentDocumentUuid },
      document: recovered.identity.document,
      verified: true,
      scope: 'document inside an exact project/document reconnect only',
      recovery: {
        windowReconnected: true,
        replayed: false,
        originalWindowId: request.target.windowId,
        recoveredWindowId: recovered.target.windowId,
        discoveryAttempt: recovered.attempt,
      },
      target: recovered.target,
    };
  }
}

export async function inspectSilkscreenRuntime(eda, request) {
  const guard = async () => {
    const d = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (d?.uuid !== request.target.documentUuid || d?.documentType !== 3) throw Error('PCB document mismatch during silkscreen inspection');
    if (request.target.projectUuid && (await eda.dmt_Project.getCurrentProjectInfo())?.uuid !== request.target.projectUuid) throw Error('PCB project mismatch during silkscreen inspection');
  };
  const state = (o, k) => { const f = o?.[`getState_${k[0].toUpperCase()}${k.slice(1)}`]; return typeof f === 'function' ? f.call(o) : o?.[k]; };
  const fields = ['primitiveId','parentPrimitiveId','layer','x','y','text','key','value','keyVisible','valueVisible','fontFamily','fontSize','lineWidth','rotation','mirror','alignMode','primitiveLock','reverse','expansion'];
  await guard();
  const all = [];
  for (const [kind, api] of [['string', eda.pcb_PrimitiveString], ['attribute', eda.pcb_PrimitiveAttribute]]) {
    if (typeof api?.getAll !== 'function') throw Error(`Required ${kind} read API is unavailable`);
    const values = await api.getAll();
    if (!Array.isArray(values)) throw Error(`Invalid ${kind} result; unknown is not an empty list`);
    for (const o of values) {
      const v = Object.fromEntries(fields.map(k => [k, state(o,k)]).filter(([,value])=>value !== undefined));
      if (![3,4].includes(v.layer)) continue;
      all.push({ kind, ...v, visibility: kind === 'string' ? 'text-object' : v.keyVisible === true || v.valueVisible === true ? 'visible-attribute' : v.keyVisible === false && v.valueVisible === false ? 'hidden-attribute' : 'unknown-attribute' });
    }
  }
  all.sort((a,b)=>String(a.primitiveId).localeCompare(String(b.primitiveId)));
  const ids = request.ids ? new Set(request.ids) : null;
  const missingIds = request.ids?.filter(id=>!all.some(x=>x.primitiveId === id)) ?? [];
  const selected = ids ? all.filter(x=>ids.has(x.primitiveId)) : all;
  const offset = request.offset ?? 0, limit = request.limit ?? 40;
  const items = [];
  for (const v of selected.slice(offset, offset+limit)) {
    await guard();
    let bounds=null, boundsError=null;
    try {
      const b=await eda.pcb_Primitive?.getPrimitivesBBox?.([v.primitiveId]);
      if (b && ['minX','maxX','minY','maxY'].every(k=>Number.isFinite(b[k])) && b.minX<=b.maxX && b.minY<=b.maxY) bounds=b;
      else boundsError='No valid native graphics bounds';
    } catch (error) { boundsError=String(error?.message ?? error); }
    const fontSizeMm=Number.isFinite(v.fontSize)?v.fontSize*0.0254:null;
    const strokeWidthMm=Number.isFinite(v.lineWidth)?v.lineWidth*0.0254:null;
    const warnings=[];
    if (v.visibility !== 'hidden-attribute') {
      if (fontSizeMm === null) warnings.push('FONT_SIZE_UNKNOWN');
      else if (fontSizeMm < (request.minimumFontSizeMm ?? 1.2)) warnings.push('NOMINAL_FONT_BELOW_DESIGN_TARGET');
      if (strokeWidthMm === null) warnings.push('STROKE_WIDTH_UNKNOWN');
      else if (strokeWidthMm < (request.minimumStrokeWidthMm ?? 0.18)) warnings.push('STROKE_BELOW_DESIGN_TARGET');
      if (!bounds) warnings.push('GRAPHICS_BOUNDS_UNKNOWN');
    }
    items.push({...v,fontSizeMm,strokeWidthMm,bounds,boundsError,warnings});
  }
  const sameLayerBBoxOverlaps=[];
  for(let a=0;a<items.length;a++) for(let b=a+1;b<items.length;b++) {
    const x=items[a],y=items[b],u=x.bounds,v=y.bounds;
    if(u&&v&&x.layer===y.layer&&x.visibility!=='hidden-attribute'&&y.visibility!=='hidden-attribute'&&Math.min(u.maxX,v.maxX)>Math.max(u.minX,v.minX)&&Math.min(u.maxY,v.maxY)>Math.max(u.minY,v.minY)) sameLayerBBoxOverlaps.push([x.primitiveId,y.primitiveId]);
  }
  await guard();
  return { units:'mil', total:selected.length, totalSilkscreenTextObjects:all.length, offset,limit,hasMore:offset+limit<selected.length,missingIds,items,sameLayerBBoxOverlaps,coverage:{overlaps:'returned page only; no cross-page pairs',nativeBounds:true,atomic:false},limitations:['Font size is the API nominal value, not measured glyph height.','BBox intersections are candidates, not proven glyph collisions.','Layer visibility, solder-mask openings, component body occlusion and actual manufacturing rendering remain unverified.','Hidden attributes remain in the report and do not count as readable labels.'] };
}
export async function inspectSilkscreen(request) {
  assertAllowedTarget(request.target);
  const bridge=await resolveBridge({bridgeUrl:request.bridgeUrl,windowId:request.target.windowId});
  return {ok:true,...await executeBridgeCode(bridge,`return await (${inspectSilkscreenRuntime.toString()})(eda,${JSON.stringify(request)});`)};
}

const kinds = ['components','pads','lines','vias','pours','poured','fills','arcs','regions','strings','attributes'];
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v;
const equal = (a,b) => JSON.stringify(stable(a))===JSON.stringify(stable(b));
function index(items, kind) {
  if (!Array.isArray(items)) throw Error(`${kind}: complete array required; paginated objects must be assembled first`);
  const map=new Map();
  for(const v of items) {
    if(!v || typeof v.primitiveId!=='string' || !v.primitiveId || map.has(v.primitiveId)) throw Error(`${kind}: missing or duplicate primitiveId`);
    map.set(v.primitiveId,v);
  }
  return map;
}
export function compareSnapshots(before, after, { detailLimit=100 }={}) {
  if(!before || !after || typeof before!=='object'||typeof after!=='object') throw Error('Two snapshot objects required');
  if(!['mil','mm'].includes(before.units)||before.units!==after.units) throw Error('Snapshots must use the same explicit units');
  if(!before.document?.uuid || before.document.uuid!==after.document?.uuid) throw Error('Snapshot document UUID mismatch');
  const bp=before.document.parentProjectUuid ?? before.projectUuid,ap=after.document.parentProjectUuid ?? after.projectUuid;
  if((bp||ap)&&bp!==ap) throw Error('Snapshot project UUID mismatch');
  if(before.coverage?.complete===false || after.coverage?.complete===false) throw Error('Incomplete checkpoint cannot be compared as a complete snapshot');
  const comparedKinds=kinds.filter(k=>k in before&&k in after),missingKinds=kinds.filter(k=>!(k in before&&k in after));
  if(!comparedKinds.length) throw Error('No comparable primitive arrays');
  const counts={},details=[];let changeCount=0,sensitiveAttributeChangeCount=0;
  const add=event=>{changeCount++;if(event.kind==='attributes' && (event.action!=='modified'||event.fields.some(x=>['key','value','parentPrimitiveId'].includes(x.field))))sensitiveAttributeChangeCount++;if(details.length<detailLimit)details.push(event)};
  for(const kind of comparedKinds){
    const b=index(before[kind],kind),a=index(after[kind],kind);const c={added:0,removed:0,modified:0,unchanged:0};
    for(const id of [...new Set([...b.keys(),...a.keys()])].sort()){
      if(!b.has(id)){c.added++;add({kind,primitiveId:id,action:'added',after:a.get(id)});continue;}
      if(!a.has(id)){c.removed++;add({kind,primitiveId:id,action:'removed',before:b.get(id)});continue;}
      const old=b.get(id),now=a.get(id),changedFields=Object.keys({...old,...now}).sort().filter(k=>!equal(old[k],now[k]));
      if(changedFields.length){c.modified++;add({kind,primitiveId:id,action:'modified',fields:changedFields.map(field=>({field,before:old[field]??null,after:now[field]??null,beforePresent:field in old,afterPresent:field in now}))});}else c.unchanged++;
    }counts[kind]=c;
  }
  const dataKinds=['netlist','layers','constraints'];
  const metadataValid=(s,k)=>{
    let v=s[k];
    if(k==='netlist'){
      if(typeof v==='string'){try{v=JSON.parse(v);}catch{return false;}}
      return Boolean(v&&typeof v==='object'&&!Array.isArray(v));
    }
    if(k==='layers')return Array.isArray(v)&&v.every(x=>x&&typeof x==='object'&&!Array.isArray(x));
    if(!v||typeof v!=='object'||Array.isArray(v))return false;
    const required=['currentRuleConfiguration','allRuleConfigurations','netRules','netByNetRules','regionRules','netClasses','differentialPairs','equalLengthGroups','padPairGroups','realTimeDrc'];
    if(required.some(name=>!(name in v)))return false;
    const groups=['netClasses','differentialPairs','equalLengthGroups','padPairGroups'];
    if(groups.some(name=>!Array.isArray(v[name])||v[name].some(x=>!x||typeof x!=='object'||Array.isArray(x))))return false;
    if(required.filter(name=>!groups.includes(name)).some(name=>{const field=v[name];return !field||typeof field!=='object'||Array.isArray(field)||field.available!==true||field.error||field.value==null||(name==='realTimeDrc'?typeof field.value!=='boolean':typeof field.value!=='object');}))return false;
    if((s.coverage?.unavailableConstraintFields?.length??0)>0||(s.coverage?.missingConstraintFields?.length??0)>0)return false;
    return Object.values(v).every(x=>!(x&&typeof x==='object'&&!Array.isArray(x)&&'available' in x)||x.available===true&&!x.error&&x.value!=null);
  };
  const comparedData=dataKinds.filter(k=>k in before&&k in after&&metadataValid(before,k)&&metadataValid(after,k));
  const unverifiedData=dataKinds.filter(k=>(k in before||k in after)&&!comparedData.includes(k));
  const completeComparison=missingKinds.length===0&&comparedData.length===dataKinds.length;

  const changedData=comparedData.filter(k=>!equal(before[k],after[k]));
  const nonTextChanged=comparedKinds.filter(k=>!['strings','attributes'].includes(k)&&counts[k].added+counts[k].removed+counts[k].modified>0);
  const derivedKinds=['poured'];
  const derivedChangedKinds=comparedKinds.filter(k=>derivedKinds.includes(k)&&counts[k].added+counts[k].removed+counts[k].modified>0);
  const designKinds=comparedKinds.filter(k=>!derivedKinds.includes(k));
  const designChangeCount=designKinds.reduce((total,k)=>total+counts[k].added+counts[k].removed+counts[k].modified,0);
  const designSnapshotUnchanged=completeComparison?designChangeCount===0&&changedData.length===0:null;
  return {ok:true,units:before.units,documentUuid:before.document.uuid,comparedKinds,missingKinds,comparedData,unverifiedData,completeComparison,fullSnapshotUnchanged:completeComparison?changeCount===0&&changedData.length===0:null,designSnapshotUnchanged,designKinds,derivedKinds,derivedChangedKinds,derivedChangeCount:changeCount-designChangeCount,missingData:['netlist','layers','constraints'].filter(k=>!comparedData.includes(k)),changedData,sensitiveAttributeChangeCount,counts,changeCount,details,truncated:changeCount>details.length,unchangedWithinComparedScope:changeCount===0&&changedData.length===0,nonTextChanged,engineeringRelease:'NOT_EVALUATED',limitations:['Only supplied fields and categories are compared. Empty missing categories must never be fabricated.','Poured objects are native derived fill output; designSnapshotUnchanged excludes them but reports every derived change separately.','Different IDs are additions/removals; no geometry-based identity or valid-user-edit inference is made.','Equal snapshots are not an electrical, manufacturing or source-schematic approval.']};
}
export async function compareSnapshotSources({before,after,beforePath,afterPath,detailLimit}) {
  const b=await loadPlanSource({plan:before,planPath:beforePath},{maxBytes:33554432}),a=await loadPlanSource({plan:after,planPath:afterPath},{maxBytes:33554432});
  return {...compareSnapshots(b.raw,a.raw,{detailLimit}),sources:{before:b.source,after:a.source}};
}

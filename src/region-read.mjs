import { connectGateway } from './gateway-client.mjs';
import { executeBridgeCode } from './bridge.mjs';
import { createKeepoutModel } from './keepout.mjs';

export async function regionReadRuntime(eda, request, modelFactory) {
  const guard = async () => {
    const d = await eda.dmt_SelectControl.getCurrentDocumentInfo(), p = await eda.dmt_Project.getCurrentProjectInfo();
    if (d?.uuid !== request.target.documentUuid || d?.documentType !== 3 || p?.uuid !== request.target.projectUuid || d?.tabId !== request.target.tabId) throw Error('Region read target changed');
  };
  const map = { COMPONENT: 2, VIA: 3, TRACK: 5, FILL: 6, COPPER: 7, PLANE: 8 };
  const take = async () => {
    await guard();
    const source = await eda.sys_FileManager.getDocumentSource();
    if (typeof source !== 'string' || new TextEncoder().encode(source).length > 33554432) throw Error('Native region source unavailable/oversized');
    const rows = modelFactory().parse(source).filter(r => r.header.type === 'REGION').map(({ header, body }) => {
      if (!Array.isArray(body.prohibitType) || body.prohibitType.some(t => !(t in map)) || !['PROHIBIT','CONSTRAINT'].includes(body.regionType)) throw Error('Unrecognized native region rule encoding');
      return { primitiveId: header.id, primitiveType: 'Region', layer: body.layerId, primitiveLock: body.locked, regionName: body.name ?? '', lineWidth: body.width, complexPolygon: body.path, regionType: body.regionType, prohibitions: body.prohibitType, ruleType: body.regionType === 'CONSTRAINT' ? [9] : body.prohibitType.map(p => map[p]), nativeRecord: body };
    }).sort((a,b) => a.primitiveId.localeCompare(b.primitiveId));
    await guard();
    return rows;
  };
  const first = await take(), second = await take();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw Error('Native regions changed during two reads');
  let rows = second;
  if (request.ids) rows = rows.filter(r => request.ids.includes(r.primitiveId));
  if (request.layer !== undefined) rows = rows.filter(r => r.layer === request.layer);
  const offset = request.offset ?? 0, limit = request.limit ?? 200;
  return { total: rows.length, offset, limit, items: rows.slice(offset,offset+limit), hasMore: offset+limit<rows.length, stableReads:2, ruleSource:'native REGION.prohibitType; includes VIA omitted by client 4.1.60 Region getter', drcEnforcementVerified:false };
}
export async function readNativeRegions({ target, bridgeUrl, kind, ...filters }) {
  for (const key of Object.keys(filters)) if (!['ids','layer','offset','limit'].includes(key)) throw Error('Unsupported native region read filter: '+key);
  if (filters.offset !== undefined && (!Number.isSafeInteger(filters.offset) || filters.offset<0)) throw Error('Invalid offset');
  if (filters.limit !== undefined && (!Number.isSafeInteger(filters.limit) || filters.limit<1 || filters.limit>2000)) throw Error('Invalid limit');
  const session = await connectGateway({target,bridgeUrl});
  const request = {target:session.target,...filters};
  const result = await executeBridgeCode(session.bridge,`return await (${regionReadRuntime.toString()})(eda,${JSON.stringify(request)},${createKeepoutModel.toString()});`,180000);
  return {ok:true,bridge:{baseUrl:session.bridge.baseUrl,windowId:session.bridge.windowId},result};
}

import { connectGateway, gatewayError, prepareGatewayState, readNativeText } from './gateway-client.mjs';
import { expectedForRpc } from './execution-context.mjs';
import { parseDsnScene } from './dsn.mjs';

const cache = new Map();
const MAX_SCENES = 4;
const SECTIONS = new Set(['summary', 'boardOutline', 'layers', 'rules', 'components', 'images', 'padstacks', 'pads', 'nets', 'tracks', 'vias']);
function remember(key, scene) {
  cache.delete(key); cache.set(key, scene);
  while (cache.size > MAX_SCENES) cache.delete(cache.keys().next().value);
}
export function clearRouteSceneCache() { cache.clear(); }

export async function readRouteScene({ target, bridgeUrl, sceneSection = 'summary', net, layerName, offset = 0, limit = 100 }) {
  if (!SECTIONS.has(sceneSection)) throw gatewayError('INVALID_REQUEST', 'Unknown route-scene section');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw gatewayError('INVALID_REQUEST', 'Invalid scene pagination');
  const session = await connectGateway({ target, bridgeUrl });
  const prepared = session.protocolVersion === 2 ? await prepareGatewayState(session) : null;
  const stateKey = prepared ? JSON.stringify([session.target, prepared.generationId, prepared.bridgeGenerationId, prepared.sourceHash]) : null;
  let scene = stateKey ? cache.get(stateKey) : null;
  let cacheHit = Boolean(scene);
  if (!scene) {
    const file = await readNativeText({ target: session.target, bridgeUrl, kind: 'dsn' });
    if (prepared) await session.rpc('events.getState', {}, { expected: expectedForRpc(prepared) });
    const key = stateKey ?? JSON.stringify([session.target, file.sha256]);
    scene = cache.get(key);
    cacheHit = Boolean(scene);
    if (!scene) { scene = parseDsnScene(file.text); remember(key, scene); }
  }
  const metadata = { ok: true, kind: 'routeScene', target: session.target, protocolVersion: session.protocolVersion, cacheHit, sourceSha256: scene.sourceSha256, units: scene.units, sourceUnits: scene.sourceUnits, resolution: scene.resolution, coordinateFrame: scene.coordinateFrame, apiCoordinateTransform: scene.apiCoordinateTransform, summary: scene.summary, coverage: { ...scene.coverage, unresolvedNetPins: scene.coverage.unresolvedNetPins.slice(0, 100), warnings: scene.coverage.warnings.slice(0, 20) } };
  if (sceneSection === 'summary') return metadata;
  let items = scene[sceneSection];
  if (net !== undefined) items = items.filter(item => (sceneSection === 'nets' ? item.name : item.net) === net);
  if (layerName !== undefined) items = items.filter(item => item.layer === layerName || (sceneSection === 'layers' && item.name === layerName));
  return { ...metadata, section: sceneSection, total: items.length, offset, items: items.slice(offset, offset + limit), truncated: offset + limit < items.length };
}

import { gatewayError } from './gateway-client.mjs';

const finite = (v, label) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw gatewayError('INVALID_REQUEST', `Invalid ${label}`); return v; };
const copper = value => value === 1 || value === 2 || (Number.isInteger(value) && value >= 15 && value <= 44);
const sameLayer = (a, b) => a === '*' || b === '*' || a === b;
const pointDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function pointSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  if (!length2) return pointDistance(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return pointDistance(p, [a[0] + t * dx, a[1] + t * dy]);
}
function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}
function segmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}
function insideConvex(point, polygon) {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (Math.abs(cross) < 1e-12) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}
const edges = polygon => polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length]]);
function shapeDistance(a, b) {
  if (a.type === 'capsule' && b.type === 'capsule') return Math.max(0, segmentDistance(a.a, a.b, b.a, b.b) - a.radius - b.radius);
  if (a.type === 'polygon' && b.type === 'capsule') return shapeDistance(b, a);
  if (a.type === 'capsule') {
    if (insideConvex(a.a, b.points) || insideConvex(a.b, b.points)) return 0;
    return Math.max(0, Math.min(...edges(b.points).map(([c, d]) => segmentDistance(a.a, a.b, c, d))) - a.radius);
  }
  if (insideConvex(a.points[0], b.points) || insideConvex(b.points[0], a.points)) return 0;
  return Math.min(...edges(a.points).flatMap(([p, q]) => edges(b.points).map(([r, s]) => segmentDistance(p, q, r, s))));
}
function bounds(shape) {
  const points = shape.type === 'capsule' ? [shape.a, shape.b] : shape.points;
  const radius = shape.radius ?? 0;
  return { minX: Math.min(...points.map(p => p[0])) - radius, maxX: Math.max(...points.map(p => p[0])) + radius, minY: Math.min(...points.map(p => p[1])) - radius, maxY: Math.max(...points.map(p => p[1])) + radius };
}
function entirelyInDrill(shape, drill, tolerance) {
  const points = shape.type === 'capsule' ? [shape.a, shape.b] : shape.points;
  return Math.max(...points.map(p => pointDistance(p, drill.center))) + (shape.radius ?? 0) < drill.radius - tolerance;
}

/** A bounded copper-contact graph, with every unsupported physical input explicitly retained. */
export function analyzeConnectivity(snapshot, { net, toleranceMm = 0.000508, maxDetails = 100, maxComparisons = 8000000, nativeUnroutedCount } = {}) {
  if (!snapshot || !['mil', 'mm'].includes(snapshot.units)) throw gatewayError('INVALID_REQUEST', 'Connectivity requires explicit mil or mm snapshot units');
  if (!Number.isFinite(toleranceMm) || toleranceMm < 0 || toleranceMm > 0.05) throw gatewayError('INVALID_REQUEST', 'Connectivity tolerance must be 0..0.05 mm');
  if (!Number.isSafeInteger(maxDetails) || maxDetails < 0 || maxDetails > 2000 || !Number.isSafeInteger(maxComparisons) || maxComparisons < 1 || maxComparisons > 20000000) throw gatewayError('INVALID_REQUEST', 'Invalid graph detail or comparison bound');
  const scale = snapshot.units === 'mil' ? 0.0254 : 1;
  const nodes = [], unsupported = [], excluded = [];
  const ids = new Set();
  const coord = (v, label) => finite(v, label) * scale;
  function add(raw, kind, layer, shape, drill = null) {
    const id = raw.primitiveId;
    if (typeof id !== 'string' || !id || ids.has(id)) throw gatewayError('INVALID_REQUEST', 'Missing or duplicate connectivity primitive identity', { id });
    ids.add(id);
    if (!raw.net || (net !== undefined && raw.net !== net)) return;
    nodes.push({ id, kind, net: raw.net, layer, shape, drill, padNumber: raw.padNumber ?? null, componentId: raw.parentComponentPrimitiveId ?? raw.componentPrimitiveId ?? null, ...(shape ? bounds(shape) : { minX: Infinity, maxX: Infinity, minY: Infinity, maxY: Infinity }) });
  }
  for (const kind of ['lines', 'vias', 'pads']) if (!Array.isArray(snapshot[kind])) throw gatewayError('INVALID_REQUEST', `Connectivity snapshot lacks ${kind}`);
  if (snapshot.lines.length + snapshot.vias.length + snapshot.pads.length > 30000) throw gatewayError('FILE_TOO_LARGE', 'Connectivity node limit exceeded');
  for (const line of snapshot.lines) {
    if (!copper(line.layer)) continue;
    const radius = coord(line.lineWidth, 'track width') / 2;
    if (radius <= 0) throw gatewayError('INVALID_REQUEST', 'Track width must be positive');
    add(line, 'track', line.layer, { type: 'capsule', a: [coord(line.startX, 'startX'), coord(line.startY, 'startY')], b: [coord(line.endX, 'endX'), coord(line.endY, 'endY')], radius });
  }
  for (const via of snapshot.vias) {
    if (via.viaType !== 0) { unsupported.push({ primitiveId: via.primitiveId, net: via.net, reason: 'blind/buried via layer span' }); add(via, 'via', null, null); continue; }
    const center = [coord(via.x, 'via x'), coord(via.y, 'via y')], radius = coord(via.diameter, 'via diameter') / 2, hole = coord(via.holeDiameter, 'via hole') / 2;
    if (radius <= hole || hole < 0) throw gatewayError('INVALID_REQUEST', 'Invalid through-via annulus');
    add(via, 'via', '*', { type: 'capsule', a: center, b: center, radius }, { center, radius: hole });
  }
  for (const pad of snapshot.pads) {
    if (pad.layer === 12 && pad.metallization !== true) { excluded.push({ primitiveId: pad.primitiveId, reason: 'non-plated multi-layer hole' }); continue; }
    if (!copper(pad.layer) && pad.layer !== 12) continue;
    const layer = pad.layer === 12 ? '*' : pad.layer;
    const center = [coord(pad.x, 'pad x'), coord(pad.y, 'pad y')];
    const angle = finite(pad.rotation ?? 0, 'pad rotation') * Math.PI / 180;
    const transform = ([x, y]) => [center[0] + x * Math.cos(angle) - y * Math.sin(angle), center[1] + x * Math.sin(angle) + y * Math.cos(angle)];
    const source = pad.pad;
    let shape = null;
    if (Array.isArray(source) && ['RECT', 'OVAL', 'ELLIPSE'].includes(source[0])) {
      const width = coord(source[1], 'pad width'), height = coord(source[2], 'pad height');
      if (width <= 0 || height <= 0) throw gatewayError('INVALID_REQUEST', 'Pad dimensions must be positive');
      if (source[0] === 'RECT' && (source[3] ?? 0) === 0) shape = { type: 'polygon', points: [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]].map(transform) };
      else if (source[0] === 'OVAL') {
        const alongX = width >= height, radius = Math.min(width, height) / 2, halfAxis = Math.abs(width - height) / 2;
        shape = { type: 'capsule', a: transform(alongX ? [-halfAxis, 0] : [0, -halfAxis]), b: transform(alongX ? [halfAxis, 0] : [0, halfAxis]), radius };
      } else if (source[0] === 'ELLIPSE' && Math.abs(width - height) <= 1e-9) shape = { type: 'capsule', a: center, b: center, radius: width / 2 };
    }
    if (!shape) unsupported.push({ primitiveId: pad.primitiveId, net: pad.net, reason: 'unmodeled pad shape', shape: source?.[0] ?? null });
    if (pad.hole) unsupported.push({ primitiveId: pad.primitiveId, net: pad.net, reason: 'pad drill geometry units/offset not verified; outer copper model only' });
    add(pad, 'pad', layer, shape);
  }
  const relevantUnsupported = unsupported.filter(item => net === undefined || item.net === net);
  const missingCoverage = [];
  for (const kind of ['arcs', 'fills', 'poured', 'regions']) {
    const count = Array.isArray(snapshot[kind]) ? snapshot[kind].length : snapshot.coverage?.observedExcludedCounts?.[kind];
    if (count !== 0) missingCoverage.push({ kind, count: Number.isSafeInteger(count) ? count : null, reason: Number.isSafeInteger(count) ? 'not modeled' : 'not enumerated' });
  }
  const parent = nodes.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
  const byNet = new Map();
  for (const [index, node] of nodes.entries()) { if (!byNet.has(node.net)) byNet.set(node.net, []); byNet.get(node.net).push(index); }
  let comparisons = 0, contacts = 0;
  for (const indices of byNet.values()) {
    const sorted = indices.filter(i => nodes[i].shape).sort((a, b) => nodes[a].minX - nodes[b].minX);
    for (let a = 0; a < sorted.length; a++) {
      const first = nodes[sorted[a]];
      for (let b = a + 1; b < sorted.length; b++) {
        const second = nodes[sorted[b]];
        if (second.minX > first.maxX + toleranceMm) break;
        if (++comparisons > maxComparisons) throw gatewayError('FILE_TOO_LARGE', 'Connectivity comparison limit reached; inspect a smaller net scope');
        if (!sameLayer(first.layer, second.layer) || second.minY > first.maxY + toleranceMm || first.minY > second.maxY + toleranceMm) continue;
        if (first.drill && entirelyInDrill(second.shape, first.drill, toleranceMm)) continue;
        if (second.drill && entirelyInDrill(first.shape, second.drill, toleranceMm)) continue;
        if (shapeDistance(first.shape, second.shape) <= toleranceMm) { union(sorted[a], sorted[b]); contacts++; }
      }
    }
  }
  let splitPadNetCount = 0;
  const netResults = [];
  for (const [name, indices] of [...byNet].sort(([a], [b]) => a.localeCompare(b))) {
    const groups = new Map();
    for (const index of indices) { const root = find(index); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(nodes[index]); }
    const values = [...groups.values()];
    const padGroups = values.filter(group => group.some(item => item.kind === 'pad'));
    if (padGroups.length > 1) splitPadNetCount++;
    netResults.push({ net: name, modeledComponentCount: values.length, padGroupCount: padGroups.length, copperOnlyIslandCount: values.length - padGroups.length, padGroups: padGroups.slice(0, maxDetails).map(group => ({ padCount: group.filter(n => n.kind === 'pad').length, primitiveCount: group.length, pads: group.filter(n => n.kind === 'pad').slice(0, maxDetails).map(n => ({ primitiveId: n.id, componentId: n.componentId, padNumber: n.padNumber })) })), groupsTruncated: padGroups.length > maxDetails });
  }
  const partial = relevantUnsupported.length > 0 || missingCoverage.length > 0;
  const verdict = partial ? 'PARTIAL' : splitPadNetCount > 0 ? 'DISCONNECTED' : 'CONNECTED_WITHIN_COVERAGE';
  const nativeCrossCheck = Number.isSafeInteger(nativeUnroutedCount) ? { nativeUnroutedCount, modeledSplitPadNetCount: splitPadNetCount, agreement: partial ? 'NOT_COMPARABLE_WITH_PARTIAL_COVERAGE' : (nativeUnroutedCount === 0) === (splitPadNetCount === 0) ? 'ZERO_NONZERO_AGREE' : 'DISAGREEMENT_REQUIRES_REVIEW' } : null;
  return { connectivityVerdict: verdict, units: 'mm', toleranceMm, scope: net === undefined ? 'provided snapshot nets' : `net:${net}`, nodeCount: nodes.length, netCount: byNet.size, contactCount: contacts, comparisonCount: comparisons, modeledSplitPadNetCount: splitPadNetCount, coverage: { straightTracks: true, roundRectOvalPads: true, throughVias: true, padDrillShapes: false, arcs: false, pouredCopper: false, blindBuriedVias: false, unsupportedObjectCount: relevantUnsupported.length, unsupportedObjects: relevantUnsupported.slice(0, maxDetails), unmodeledCategories: missingCoverage, excludedNonconductiveCount: excluded.length, callerInventory: 'supplied snapshot; no independent circuit intent inferred' }, nativeCrossCheck, nets: netResults.slice(0, maxDetails), detailsTruncated: netResults.length > maxDetails };
}

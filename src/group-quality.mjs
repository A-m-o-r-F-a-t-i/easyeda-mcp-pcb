import { describeArc } from './arc-geometry.mjs';

// Metrics describe observed geometry, not routed path length or electrical approval.
const copper = layer => layer === 1 || layer === 2 || Number.isInteger(layer) && layer >= 15 && layer <= 44;
const finite = (value, field) => { if (!Number.isFinite(value)) throw new Error(`${field}: finite number required`); return value; };
const unique = values => [...new Set(values)];
export function inspectGroupQuality(snapshot, { groups, referenceLayers = [], detailLimit = 100 } = {}) {
  if (!snapshot || snapshot.units !== 'mil') throw new Error('Group metrics require a mil snapshot');
  for (const key of ['lines', 'pads', 'vias']) if (!Array.isArray(snapshot[key])) throw new Error(`Group metrics require complete ${key} inventory`);
  if (!Array.isArray(groups) || !groups.length || groups.length > 32) throw new Error('Provide 1..32 explicit functional groups');
  if (!Number.isInteger(detailLimit) || detailLimit < 0 || detailLimit > 5000) throw new Error('detailLimit must be 0..5000');
  if (unique(groups.map(group => group.name)).length !== groups.length) throw new Error('Duplicate group name');
  const scale = 1, allIds = new Set(), byNet = new Map(), byPad = new Map();
  const stat = net => { if (!byNet.has(net)) byNet.set(net, { net, straightLengthMil: 0, arcLengthMil: Array.isArray(snapshot.arcs) ? 0 : null, lineCount: 0, arcCount: 0, viaCount: 0, drilledPadCount: 0, padCount: 0, layers: new Map(), items: [] }); return byNet.get(net); };
  const refs = new Map();
  for (const ref of referenceLayers) {
    if (!copper(ref.layer) || typeof ref.net !== 'string' || !ref.net || refs.has(ref.layer)) throw new Error('Reference layers need unique copper layers and exact net names');
    refs.set(ref.layer, ref.net);
  }
  for (const [kind, items] of [['line', snapshot.lines], ['arc', snapshot.arcs ?? []], ['via', snapshot.vias], ['pad', snapshot.pads], ['fill', snapshot.fills ?? []]]) {
    for (const item of items) {
      if (typeof item.primitiveId !== 'string' || !item.primitiveId || allIds.has(item.primitiveId)) throw new Error('Missing or duplicate metric primitive identity');
      allIds.add(item.primitiveId);
      if (kind === 'pad') byPad.set(item.primitiveId, item);
      if (typeof item.net !== 'string' || !item.net || kind !== 'via' && kind !== 'pad' && !copper(item.layer)) continue;
      const s = stat(item.net); let lengthMil = 0;
      if (kind === 'line') {
        for (const key of ['startX', 'startY', 'endX', 'endY']) finite(item[key], `${item.primitiveId}.${key}`);
        lengthMil = Math.hypot(item.endX - item.startX, item.endY - item.startY) * scale;
        s.straightLengthMil += lengthMil; s.lineCount++;
      } else if (kind === 'arc') {
        const arc = describeArc(item); lengthMil = arc.radius * Math.abs(arc.sweep) * scale;
        s.arcLengthMil += lengthMil; s.arcCount++;
      } else if (kind === 'via') s.viaCount++;
      else if (kind === 'pad') { s.padCount++; if (item.layer === 12 && item.metallization === true && Array.isArray(item.hole) && item.hole[1] > 0) s.drilledPadCount++; }
      if (kind === 'line' || kind === 'arc') {
        const usage = s.layers.get(item.layer) ?? { layer: item.layer, lineCount: 0, arcCount: 0, lengthMil: 0 };
        usage[kind === 'line' ? 'lineCount' : 'arcCount']++; usage.lengthMil += lengthMil; s.layers.set(item.layer, usage);
      }
      s.items.push({ ...item, metricKind: kind, lengthMil });
    }
  }
  const results = groups.map(group => {
    if (typeof group.name !== 'string' || !group.name || !Array.isArray(group.nets) || !group.nets.length || group.nets.length > 512 || group.nets.some(n => typeof n !== 'string' || !n) || unique(group.nets).length !== group.nets.length) throw new Error('Groups require a name and unique exact network names');
    const region = group.region;
    if (region && (!['minX', 'maxX', 'minY', 'maxY'].every(k => Number.isFinite(region[k])) || region.minX >= region.maxX || region.minY >= region.maxY)) throw new Error('Invalid group region in snapshot units');
    const inside = (x, y) => x >= region.minX && x <= region.maxX && y >= region.minY && y <= region.maxY;
    const missingNets = group.nets.filter(net => !byNet.has(net)), reasons = [], outside = [], occupation = [];
    const nets = group.nets.map(net => {
      const s = byNet.get(net);
      if (!s) return { net, state: 'NOT_OBSERVED_IN_SNAPSHOT', straightLengthMil: null, arcLengthMil: null, viaCount: null, connectivity: 'NOT_EVALUATED' };
      const { items, layers, ...data } = s;
      for (const item of items) {
        if (refs.has(item.layer) && refs.get(item.layer) !== net && ['line', 'arc', 'fill'].includes(item.metricKind)) occupation.push({ primitiveId: item.primitiveId, net, layer: item.layer, kind: item.metricKind, lengthMil: item.metricKind === 'fill' ? null : item.lengthMil });
        if (region) {
          const points = item.metricKind === 'line' || item.metricKind === 'arc' ? [[item.startX, item.startY], [item.endX, item.endY]] : ['pad', 'via'].includes(item.metricKind) ? [[item.x, item.y]] : [];
          if (points.some(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && !inside(x, y))) outside.push({ primitiveId: item.primitiveId, net, kind: item.metricKind });
        }
      }
      return { ...data, state: 'OBSERVED', layerUsage: [...layers.values()].sort((a, b) => a.layer - b.layer), connectivity: 'NOT_EVALUATED' };
    });
    if ((group.pairs?.length ?? 0) > 512) throw new Error('At most 512 explicit pad pairs per group');
    const pairs = (group.pairs ?? []).map(pair => {
      const a = byPad.get(pair.fromPadId), b = byPad.get(pair.toPadId), label = pair.name ?? `${pair.fromPadId} -> ${pair.toPadId}`;
      if (typeof pair.fromPadId !== 'string' || typeof pair.toPadId !== 'string' || pair.fromPadId === pair.toPadId) throw new Error('Pad pairs require two distinct exact pad IDs');
      if (pair.maxDistanceMil !== undefined && !(finite(pair.maxDistanceMil, 'maxDistanceMil') > 0)) throw new Error('Positive pair distance budget required');
      if (!a || !b) { reasons.push({ code: 'PAIR_ENDPOINT_UNAVAILABLE', pair: label }); return { name: label, state: 'ENDPOINT_UNAVAILABLE', distanceMil: null, fromPadId: pair.fromPadId, toPadId: pair.toPadId }; }
      const distanceMil = Math.hypot(finite(a.x, 'pad x') - finite(b.x, 'pad x'), finite(a.y, 'pad y') - finite(b.y, 'pad y')) * scale;
      if (!group.nets.includes(a.net) || !group.nets.includes(b.net)) reasons.push({ code: 'PAIR_OUTSIDE_GROUP_NETS', pair: label, fromNet: a.net ?? null, toNet: b.net ?? null });
      if (pair.maxDistanceMil !== undefined && distanceMil > pair.maxDistanceMil) reasons.push({ code: 'PAIR_DISTANCE_BUDGET_EXCEEDED', pair: label, distanceMil, maximumMil: pair.maxDistanceMil });
      return { name: label, state: 'MEASURED', fromPadId: a.primitiveId, toPadId: b.primitiveId, fromNet: a.net ?? null, toNet: b.net ?? null, sameNet: Boolean(a.net) && a.net === b.net, distanceMil };
    });
    const observed = nets.filter(net => net.state === 'OBSERVED');
    const totals = { straightLengthMil: observed.reduce((sum, net) => sum + net.straightLengthMil, 0), arcLengthMil: Array.isArray(snapshot.arcs) ? observed.reduce((sum, net) => sum + net.arcLengthMil, 0) : null, viaCount: observed.reduce((sum, net) => sum + net.viaCount, 0), drilledPadCount: observed.reduce((sum, net) => sum + net.drilledPadCount, 0), observedNetCount: observed.length, requestedNetCount: group.nets.length };
    if (group.maxViaCount !== undefined && (!Number.isInteger(group.maxViaCount) || group.maxViaCount < 0)) throw new Error('maxViaCount must be a nonnegative integer');
    if (group.maxViaCount !== undefined && totals.viaCount > group.maxViaCount) reasons.push({ code: 'VIA_BUDGET_EXCEEDED', actual: totals.viaCount, maximum: group.maxViaCount });
    if (missingNets.length) reasons.push({ code: 'EXACT_NETS_NOT_OBSERVED', nets: missingNets });
    if (occupation.length) reasons.push({ code: 'REFERENCE_LAYER_USAGE_REQUIRES_REVIEW', count: occupation.length });
    if (outside.length) reasons.push({ code: 'GEOMETRY_OUTSIDE_GROUP_REGION', count: outside.length });
    return { name: group.name, role: group.role ?? 'unspecified', state: reasons.length ? 'REVIEW_REQUIRED' : 'METRICS_AVAILABLE', totals, missingNets, nets, pairs, reviewReasons: reasons, referenceLayerOccupation: { count: occupation.length, items: occupation.slice(0, detailLimit), continuity: 'NOT_EVALUATED' }, outsideRegion: region ? { count: outside.length, items: outside.slice(0, detailLimit), meaning: 'endpoint/center outside explicit region; not complete arc or polygon intersection' } : null, detailsTruncated: occupation.length > detailLimit || outside.length > detailLimit };
  });
  return { readOnly: true, wrotePCB: false, units: 'mil', groups: results, coverage: snapshot.coverage ?? null, meaning: 'Line and arc centerline sums, not pad-to-pad routed paths; no overlap deduplication. Missing exact-case networks are unknown, not zero-length or disconnected. Drilled pads are not Via objects.', notChecked: ['native DRC', 'routed connectivity and completion', 'pour path length', 'reference copper continuity or return connection', 'electrical/thermal performance', 'placement optimization'], engineeringRelease: 'NOT_EVALUATED' };
}

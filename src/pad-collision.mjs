export function createPadCollisionGuard(eda, { state, id, toleranceMil = 0.02 } = {}) {
  if (typeof state !== 'function' || typeof id !== 'function') throw new Error('Pad collision guard requires state/id adapters');
  const tolerance = Number.isFinite(toleranceMil) && toleranceMil > 0 ? toleranceMil : 0.02;
  let inventory = null;

  const finite = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Pad collision coverage incomplete: ${label}`);
    return value;
  };
  const sameLayer = (a, b) => a === '*' || b === '*' || a === b;
  const pointDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const rotatePoint = (point, degrees, origin = [0, 0]) => {
    const angle = degrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const x = point[0] - origin[0], y = point[1] - origin[1];
    return [origin[0] + x * cos - y * sin, origin[1] + x * sin + y * cos];
  };
  const pointSegmentDistance = (point, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    if (!length2) return pointDistance(point, a);
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2));
    return pointDistance(point, [a[0] + t * dx, a[1] + t * dy]);
  };
  const orientation = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (a, b, point) => Math.abs(orientation(a, b, point)) <= tolerance &&
    point[0] >= Math.min(a[0], b[0]) - tolerance && point[0] <= Math.max(a[0], b[0]) + tolerance &&
    point[1] >= Math.min(a[1], b[1]) - tolerance && point[1] <= Math.max(a[1], b[1]) + tolerance;
  const segmentsIntersect = (a, b, c, d) => {
    const abC = orientation(a, b, c), abD = orientation(a, b, d), cdA = orientation(c, d, a), cdB = orientation(c, d, b);
    if (Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB) &&
        Math.abs(abC) > tolerance && Math.abs(abD) > tolerance && Math.abs(cdA) > tolerance && Math.abs(cdB) > tolerance) return true;
    return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
  };
  const segmentDistance = (a, b, c, d) => segmentsIntersect(a, b, c, d) ? 0 : Math.min(
    pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b),
  );
  const pointInPolygon = (point, polygon) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[j], b = polygon[i];
      if (pointSegmentDistance(point, a, b) <= tolerance) return true;
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  };
  const polygonEdges = points => points.map((point, index) => [point, points[(index + 1) % points.length]]);
  const shapeDistance = (a, b) => {
    if (a.type === 'capsule' && b.type === 'capsule') return Math.max(0, segmentDistance(a.a, a.b, b.a, b.b) - a.radius - b.radius);
    if (a.type === 'polygon' && b.type === 'capsule') return shapeDistance(b, a);
    if (a.type === 'capsule') {
      if (pointInPolygon(a.a, b.points) || pointInPolygon(a.b, b.points)) return 0;
      return Math.max(0, Math.min(...polygonEdges(b.points).map(([c, d]) => segmentDistance(a.a, a.b, c, d))) - a.radius);
    }
    if (pointInPolygon(a.points[0], b.points) || pointInPolygon(b.points[0], a.points)) return 0;
    return Math.min(...polygonEdges(a.points).flatMap(([p, q]) => polygonEdges(b.points).map(([r, s]) => segmentDistance(p, q, r, s))));
  };
  const shapeBounds = shape => {
    const points = shape.type === 'capsule' ? [shape.a, shape.b] : shape.points;
    const radius = shape.radius ?? 0;
    return {
      minX: Math.min(...points.map(point => point[0])) - radius,
      maxX: Math.max(...points.map(point => point[0])) + radius,
      minY: Math.min(...points.map(point => point[1])) - radius,
      maxY: Math.max(...points.map(point => point[1])) + radius,
    };
  };
  const boundsOverlap = (a, b) => a.minX <= b.maxX + tolerance && a.maxX + tolerance >= b.minX && a.minY <= b.maxY + tolerance && a.maxY + tolerance >= b.minY;
  const transformShape = (shape, transform) => shape.type === 'capsule'
    ? { type: 'capsule', a: transform(shape.a), b: transform(shape.b), radius: shape.radius }
    : { type: 'polygon', points: shape.points.map(transform) };

  const simplePolygon = source => {
    if (Array.isArray(source) && source.length === 1 && Array.isArray(source[0])) source = source[0];
    if (!Array.isArray(source)) return null;
    const values = [];
    for (const token of source) {
      if (token === 'L') continue;
      if (typeof token !== 'number' || !Number.isFinite(token)) return null;
      values.push(token);
    }
    if (values.length < 6 || values.length % 2) return null;
    const points = [];
    for (let index = 0; index < values.length; index += 2) points.push([values[index], values[index + 1]]);
    if (points.length > 3 && pointDistance(points[0], points.at(-1)) <= tolerance) points.pop();
    return points.length >= 3 ? points : null;
  };
  const transformed = (center, rotation, local) => {
    const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    return [center[0] + local[0] * cos - local[1] * sin, center[1] + local[0] * sin + local[1] * cos];
  };
  const padShape = pad => {
    const center = [finite(pad.x, 'pad x'), finite(pad.y, 'pad y')];
    const rotation = finite(pad.rotation ?? 0, 'pad rotation');
    const source = pad.pad;
    if (!Array.isArray(source) || typeof source[0] !== 'string') return null;
    const type = source[0];
    if (['ELLIPSE', 'OVAL', 'RECT'].includes(type)) {
      const width = finite(source[1], 'pad width'), height = finite(source[2], 'pad height');
      if (!(width > 0 && height > 0)) return null;
      if (type === 'OVAL') {
        const alongX = width >= height, radius = Math.min(width, height) / 2, halfAxis = Math.abs(width - height) / 2;
        return { type: 'capsule', a: transformed(center, rotation, alongX ? [-halfAxis, 0] : [0, -halfAxis]), b: transformed(center, rotation, alongX ? [halfAxis, 0] : [0, halfAxis]), radius };
      }
      if (type === 'ELLIPSE') {
        const segments = 32, expansion = 1 / Math.cos(Math.PI / segments), points = [];
        for (let index = 0; index < segments; index++) {
          const angle = (index * 2 + 1) * Math.PI / segments;
          points.push(transformed(center, rotation, [Math.cos(angle) * width * expansion / 2, Math.sin(angle) * height * expansion / 2]));
        }
        return { type: 'polygon', points };
      }
      return { type: 'polygon', points: [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]].map(point => transformed(center, rotation, point)) };
    }
    if (type === 'NGON') {
      const diameter = finite(source[1], 'pad diameter'), sides = finite(source[2], 'pad sides');
      if (!(diameter > 0) || !Number.isInteger(sides) || sides < 3 || sides > 64) return null;
      return { type: 'polygon', points: Array.from({ length: sides }, (_, index) => {
        const angle = -Math.PI / 2 + index * 2 * Math.PI / sides;
        return transformed(center, rotation, [Math.cos(angle) * diameter / 2, Math.sin(angle) * diameter / 2]);
      }) };
    }
    if (type === 'POLYGON') {
      const points = simplePolygon(source[1]);
      return points ? { type: 'polygon', points: points.map(point => transformed(center, rotation, point)) } : null;
    }
    return null;
  };
  const nativeBoundsShape = async primitiveId => {
    if (!primitiveId || typeof eda.pcb_Primitive?.getPrimitivesBBox !== 'function') return null;
    const bounds = await eda.pcb_Primitive.getPrimitivesBBox([primitiveId]);
    if (!bounds || !['minX', 'maxX', 'minY', 'maxY'].every(key => Number.isFinite(bounds[key])) || bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) return null;
    return { type: 'polygon', points: [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY]] };
  };
  const padValues = raw => ({
    primitiveId: id(raw) ?? state(raw, 'primitiveId') ?? null,
    padNumber: state(raw, 'padNumber') ?? '', net: state(raw, 'net') ?? '', layer: state(raw, 'layer'),
    x: state(raw, 'x'), y: state(raw, 'y'), rotation: state(raw, 'rotation') ?? 0, pad: state(raw, 'pad'),
  });
  const recordFromPad = async (raw, metadata) => {
    const pad = padValues(raw), primitiveId = pad.primitiveId ?? metadata.primitiveId ?? null;
    const layer = pad.layer === 12 ? '*' : pad.layer;
    if (![1, 2, '*'].includes(layer)) throw new Error(`Pad collision coverage incomplete: unsupported pad layer ${String(pad.layer)}`);
    const shape = padShape(pad) ?? await nativeBoundsShape(primitiveId);
    if (!shape) throw new Error(`Pad collision coverage incomplete for ${metadata.designator ?? metadata.kind ?? 'pad'} ${pad.padNumber || primitiveId || '?'}`);
    return { ...metadata, primitiveId, padNumber: String(pad.padNumber ?? ''), net: String(pad.net ?? ''), layer, shape, bounds: shapeBounds(shape) };
  };
  const recordFromVia = raw => {
    const x = finite(state(raw, 'x'), 'via x'), y = finite(state(raw, 'y'), 'via y'), diameter = finite(state(raw, 'diameter'), 'via diameter');
    if (!(diameter > 0)) throw new Error('Pad collision coverage incomplete: invalid via diameter');
    const shape = { type: 'capsule', a: [x, y], b: [x, y], radius: diameter / 2 };
    return { kind: 'via', ownerId: null, designator: null, primitiveId: id(raw) ?? state(raw, 'primitiveId') ?? null, padNumber: '', net: String(state(raw, 'net') ?? ''), layer: '*', shape, bounds: shapeBounds(shape) };
  };
  const componentSummary = component => ({
    primitiveId: id(component) ?? state(component, 'primitiveId'), designator: state(component, 'designator') ?? null,
    x: state(component, 'x'), y: state(component, 'y'), rotation: state(component, 'rotation') ?? 0, layer: state(component, 'layer'),
  });

  const loadInventory = async () => {
    if (inventory) return inventory;
    if (typeof eda.pcb_PrimitiveComponent?.getAll !== 'function' || typeof eda.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId !== 'function') throw new Error('Pad collision guard requires component and pin enumeration');
    if (typeof eda.pcb_PrimitivePad?.getAll !== 'function' || typeof eda.pcb_PrimitiveVia?.getAll !== 'function') throw new Error('Pad collision guard requires standalone pad and via enumeration');
    const components = await eda.pcb_PrimitiveComponent.getAll();
    if (!Array.isArray(components)) throw new Error('Pad collision guard component enumeration unavailable');
    const records = [], componentMap = new Map(), componentPadIds = new Set();
    for (const component of components) {
      const meta = componentSummary(component), componentId = meta.primitiveId;
      if (typeof componentId !== 'string' || !componentId || componentMap.has(componentId)) throw new Error('Pad collision guard found missing or duplicate component identity');
      componentMap.set(componentId, meta);
      const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);
      if (!Array.isArray(pins)) throw new Error(`Pad collision guard pins unavailable: ${meta.designator ?? componentId}`);
      for (const pin of pins) {
        const pinId = id(pin) ?? state(pin, 'primitiveId');
        if (typeof pinId !== 'string' || !pinId || componentPadIds.has(pinId)) throw new Error('Pad collision guard found missing or duplicate component pad identity');
        componentPadIds.add(pinId);
        records.push(await recordFromPad(pin, { kind: 'component-pad', ownerId: componentId, designator: meta.designator }));
      }
    }
    const pads = await eda.pcb_PrimitivePad.getAll();
    if (!Array.isArray(pads)) throw new Error('Pad collision guard standalone pad enumeration unavailable');
    for (const pad of pads) {
      const padId = id(pad) ?? state(pad, 'primitiveId');
      if (!componentPadIds.has(padId)) records.push(await recordFromPad(pad, { kind: 'standalone-pad', ownerId: null, designator: null }));
    }
    const vias = await eda.pcb_PrimitiveVia.getAll();
    if (!Array.isArray(vias)) throw new Error('Pad collision guard via enumeration unavailable');
    for (const via of vias) records.push(recordFromVia(via));
    inventory = { records, componentMap };
    return inventory;
  };

  const compact = record => ({
    kind: record.kind, primitiveId: record.primitiveId, componentId: record.ownerId, designator: record.designator,
    padNumber: record.padNumber, net: record.net, layer: record.layer,
  });
  const findCollisions = (candidates, obstacles) => {
    const collisions = [];
    for (const candidate of candidates) for (const obstacle of obstacles) {
      if (candidate.primitiveId && obstacle.primitiveId === candidate.primitiveId) continue;
      if (!sameLayer(candidate.layer, obstacle.layer) || !boundsOverlap(candidate.bounds, obstacle.bounds)) continue;
      if (shapeDistance(candidate.shape, obstacle.shape) <= tolerance) collisions.push({ candidate: compact(candidate), obstacle: compact(obstacle) });
    }
    return collisions;
  };
  const blocked = collisions => {
    if (!collisions.length) return;
    const first = collisions[0], label = item => item.designator ? `${item.designator} pad ${item.padNumber || '?'}` : `${item.kind} ${item.primitiveId || '?'}`;
    const error = new Error(`Pad overlap blocked: ${label(first.candidate)} intersects ${label(first.obstacle)}${collisions.length > 1 ? ` (${collisions.length} collisions)` : ''}`);
    error.code = 'PAD_OVERLAP_BLOCKED';
    error.details = { collisionCount: collisions.length, collisions: collisions.slice(0, 50), detailsTruncated: collisions.length > 50, policy: 'Different-component pads and standalone pad/via objects may not overlap, even on the same net.' };
    throw error;
  };

  const assertComponentCandidate = async ({ componentId, current, desired }) => {
    const data = await loadInventory();
    const own = data.records.filter(record => record.ownerId === componentId);
    if (!own.length) throw new Error(`Pad collision guard found no pads for component ${componentId}`);
    if (desired.layer !== current.layer) return { checked: false, reason: 'NATIVE_LAYER_FLIP_POSTCHECK_REQUIRED' };
    const currentOrigin = [finite(current.x, 'component x'), finite(current.y, 'component y')];
    const desiredOrigin = [finite(desired.x, 'desired component x'), finite(desired.y, 'desired component y')];
    const delta = finite(desired.rotation, 'desired component rotation') - finite(current.rotation, 'component rotation');
    const transform = point => {
      const rotated = rotatePoint(point, delta, currentOrigin);
      return [rotated[0] + desiredOrigin[0] - currentOrigin[0], rotated[1] + desiredOrigin[1] - currentOrigin[1]];
    };
    const candidates = own.map(record => {
      const shape = transformShape(record.shape, transform);
      return { ...record, shape, bounds: shapeBounds(shape) };
    });
    const obstacles = data.records.filter(record => record.ownerId !== componentId);
    blocked(findCollisions(candidates, obstacles));
    return { checked: true, candidatePadCount: candidates.length, obstacleCount: obstacles.length };
  };

  const actualComponentRecords = async (componentId, component, pins) => {
    const meta = componentSummary(component), designator = meta.designator;
    if (!Array.isArray(pins)) throw new Error(`Pad collision guard pins unavailable after move: ${designator ?? componentId}`);
    const records = [];
    for (const pin of pins) records.push(await recordFromPad(pin, { kind: 'component-pad', ownerId: componentId, designator }));
    return records;
  };
  const assertActualComponent = async ({ componentId, component, pins }) => {
    const data = await loadInventory(), candidates = await actualComponentRecords(componentId, component, pins);
    const obstacles = data.records.filter(record => record.ownerId !== componentId);
    blocked(findCollisions(candidates, obstacles));
    return { checked: true, candidatePadCount: candidates.length, obstacleCount: obstacles.length };
  };
  const replaceComponent = async ({ previousComponentId, componentId, component, pins }) => {
    const data = await loadInventory(), records = await actualComponentRecords(componentId, component, pins);
    data.records = data.records.filter(record => record.ownerId !== previousComponentId && record.ownerId !== componentId).concat(records);
    data.componentMap.delete(previousComponentId);
    data.componentMap.set(componentId, componentSummary(component));
  };
  const assertStandaloneCandidate = async ({ kind, primitiveId = null, desired }) => {
    const data = await loadInventory();
    let candidate;
    if (kind === 'pad') candidate = await recordFromPad({ ...desired, primitiveId }, { kind: 'standalone-pad', ownerId: null, designator: null, primitiveId });
    else if (kind === 'via') candidate = recordFromVia({ ...desired, primitiveId });
    else throw new Error(`Unsupported standalone collision candidate ${kind}`);
    const obstacles = data.records.filter(record => record.kind === 'component-pad');
    blocked(findCollisions([candidate], obstacles));
    return { checked: true, candidatePadCount: 1, obstacleCount: obstacles.length };
  };

  return {
    assertComponentCandidate,
    assertActualComponent,
    replaceComponent,
    assertStandaloneCandidate,
    invalidate() { inventory = null; },
  };
}

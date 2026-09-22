import { validatePlan } from './plan.mjs';
import { describeArc, pointToArcDistance } from './arc-geometry.mjs';

/** Keep MCP policy separate from the older Gateway's finite plan schema.
 * The original plan remains the prepared/hash-bound source. Only circularKeepouts
 * is evaluated at this boundary; every native operation and old-state guard stays
 * identical. Unknown constraints are never removed or ignored.
 */
export function prepareGeometryTransport(raw) {
  const normalized = validatePlan(raw);
  const wirePlan = structuredClone(raw);
  const circles = normalized.constraints.circularKeepouts ?? [];
  if (wirePlan.constraints) delete wirePlan.constraints.circularKeepouts;
  const wireNormalized = validatePlan(wirePlan);
  if (JSON.stringify(normalized.operations) !== JSON.stringify(wireNormalized.operations)) {
    throw new Error('Geometry transport adapter changed operations or old-state assertions');
  }
  return {
    wirePlan,
    circles,
    enforcement: {
      circularKeepouts: circles.length ? 'MCP full-plan validation plus typed live copper readback before save' : 'not_requested',
      circleCount: circles.length,
      gateway: 'typed-v2 target/generation/epoch/source guards and independent operation verification',
      originalPlanRetained: true,
      coverage: 'straight traces, native circular arcs, through-vias and solid fills; component bodies, poured regions and other region primitives require separate inspection',
    },
  };
}

export function circularReadbackRequests(operations, results) {
  if (!Array.isArray(results) || operations.length !== results.length) throw new Error('Incomplete geometry batch result inventory');
  const groups = { lines: new Set(), arcs: new Set(), vias: new Set(), fills: new Set() };
  for (let index = 0; index < operations.length; index++) {
    const op = operations[index], result = results[index];
    if (result?.id !== op.id || result.verified !== true) throw new Error('Geometry batch result identity mismatch');
    if (!['line', 'arc', 'via', 'fill'].includes(op.kind) || op.type.endsWith('.delete') || (op.kind === 'line' && (op.state?.layer ?? op.set?.layer ?? op.expected?.layer) === 11)) continue;
    const ids = result.primitiveIds ?? (result.primitiveId ? [result.primitiveId] : []);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Copper write returned no independently addressable identity');
    const group = groups[op.kind === 'line' ? 'lines' : op.kind === 'arc' ? 'arcs' : op.kind === 'fill' ? 'fills' : 'vias'];
    for (const id of ids) group.add(id);
  }
  return Object.entries(groups).filter(([,ids]) => ids.size).map(([kind, ids]) => ({kind, ids:[...ids]}));
}

function pointSegmentDistance(point, a, b) {
  const dx=b[0]-a[0],dy=b[1]-a[1],length2=dx*dx+dy*dy;
  if (!(length2 > 0)) return Math.hypot(point[0]-a[0],point[1]-a[1]);
  const t=Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length2));
  return Math.hypot(point[0]-(a[0]+t*dx),point[1]-(a[1]+t*dy));
}
function fillPoints(source) {
  if (Array.isArray(source)&&source.length===1&&Array.isArray(source[0])) source=source[0];
  if (!Array.isArray(source)) throw new Error('Actual fill polygon source is unavailable');
  const numbers=[];
  for (const token of source) {
    if (token==='L') continue;
    if (typeof token!=='number'||!Number.isFinite(token)) throw new Error('Actual fill contains unsupported polygon commands');
    numbers.push(token);
  }
  if (numbers.length<6||numbers.length%2) throw new Error('Actual fill polygon is degenerate');
  const points=[];for(let i=0;i<numbers.length;i+=2)points.push([numbers[i],numbers[i+1]]);
  if(points.length>3&&Math.hypot(points[0][0]-points.at(-1)[0],points[0][1]-points.at(-1)[1])<=1e-9)points.pop();
  return points;
}
function pointInPolygon(point, points) {
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[i],b=points[j];
    if(pointSegmentDistance(point,a,b)<=1e-9)return true;
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
function fillDistanceToCircle(item, circle) {
  const source=item.complexPolygon?.getSource?.()??item.complexPolygon;
  const points=fillPoints(source),center=[circle.x,circle.y];
  if(pointInPolygon(center,points))return -circle.radius;
  let distance=Infinity;
  for(let i=0;i<points.length;i++)distance=Math.min(distance,pointSegmentDistance(center,points[i],points[(i+1)%points.length]));
  return distance;
}

/** Inputs are API mil coordinates, including native rounding, not requested coordinates. */
export function verifyCircularCopperReadback(circles, kind, expectedIds, items) {
  if (!['lines', 'arcs', 'vias', 'fills'].includes(kind)) throw new Error('Unsupported circular copper readback kind');
  if (!Array.isArray(items) || items.length !== expectedIds.length) throw new Error('Missing circular copper readback objects');
  const expected = new Set(expectedIds), seen = new Set();
  for (const item of items) {
    if (!item || !expected.has(item.primitiveId) || seen.has(item.primitiveId)) throw new Error('Unexpected or duplicate circular copper readback identity');
    seen.add(item.primitiveId);
    const fields = kind === 'vias' ? ['x','y','diameter'] : kind === 'fills' ? ['layer'] : kind === 'arcs' ? ['startX','startY','endX','endY','arcAngle','lineWidth','interactiveMode','layer'] : ['startX','startY','endX','endY','lineWidth','layer'];
    if (fields.some(key => !Number.isFinite(item[key]))) throw new Error('Incomplete actual copper geometry for circular keepout verification');
    if (['lines','arcs'].includes(kind) && item.layer === 11) throw new Error('Copper object unexpectedly changed to board outline');
    const radius = kind === 'fills' ? 0 : (kind === 'vias' ? item.diameter : item.lineWidth) / 2;
    if (kind !== 'fills' && !(radius > 0)) throw new Error('Actual copper has invalid width or diameter');
    for (const circle of circles) {
      let distance;
      if (kind === 'vias') distance = Math.hypot(item.x-circle.x, item.y-circle.y) - radius;
      else if (kind === 'arcs') distance = pointToArcDistance(circle.x,circle.y,describeArc(item)) - radius;
      else if (kind === 'fills') distance = fillDistanceToCircle(item,circle);
      else {
        const dx=item.endX-item.startX, dy=item.endY-item.startY, length2=dx*dx+dy*dy;
        if (!(length2 > 0)) throw new Error('Actual copper segment has zero length');
        const t=Math.max(0,Math.min(1,((circle.x-item.startX)*dx+(circle.y-item.startY)*dy)/length2));
        distance=Math.hypot(item.startX+t*dx-circle.x,item.startY+t*dy-circle.y)-radius;
      }
      // Do not reuse the editor's coordinate tolerance as a relaxed mechanical clearance.
      if (distance + 1e-9 < circle.radius) throw new Error('Actual copper intersects circular keepout '+circle.name+' at '+item.primitiveId);
    }
  }
  return {verified:true, kind, checkedObjects:items.length, checkedCircles:circles.length};
}

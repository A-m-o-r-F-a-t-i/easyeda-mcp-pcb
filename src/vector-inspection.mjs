import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertAllowedTarget, executeBridgeCode, resolveBridge } from './bridge.mjs';
import { captureSnapshotRuntime } from './verification.mjs';
import { readRuntime } from './runtime.mjs';
import { constraintRuntime } from './constraint-runtime.mjs';
import { arcBounds, arcSvgPath, describeArc } from './arc-geometry.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const fmt = value => Number(value.toFixed(4)).toString();
const escapeXml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const emptyBounds = () => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const addPoint = (bounds, x, y, radius = 0) => {
  if (!finite(x) || !finite(y) || !finite(radius)) return bounds;
  bounds.minX = Math.min(bounds.minX, x - radius);
  bounds.minY = Math.min(bounds.minY, y - radius);
  bounds.maxX = Math.max(bounds.maxX, x + radius);
  bounds.maxY = Math.max(bounds.maxY, y + radius);
  return bounds;
};
const mergeBounds = (target, source) => {
  if (!source || ![source.minX, source.minY, source.maxX, source.maxY].every(finite)) return target;
  target.minX = Math.min(target.minX, source.minX);
  target.minY = Math.min(target.minY, source.minY);
  target.maxX = Math.max(target.maxX, source.maxX);
  target.maxY = Math.max(target.maxY, source.maxY);
  return target;
};
const validBounds = bounds => bounds && [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(finite) && bounds.maxX > bounds.minX && bounds.maxY > bounds.minY;
const intersects = (a, b) => !b || (a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY);

function sourceArrays(source) {
  if (!Array.isArray(source)) return [];
  if (source.length && source.every(item => Array.isArray(item))) return source.flatMap(sourceArrays);
  return [source];
}

export function parseComplexPolygon(source, scale = 1) {
  const outputs = [];
  for (const tokens of sourceArrays(source)) {
    if (!tokens.length) continue;
    if (tokens[0] === 'R' && tokens.length >= 5 && [tokens[1], tokens[2], tokens[3], tokens[4]].every(finite)) {
      const cx = tokens[1] * scale, cy = tokens[2] * scale, width = Math.abs(tokens[3] * scale), height = Math.abs(tokens[4] * scale);
      const rotation = finite(tokens[6]) ? tokens[6] : 0;
      const bounds = { minX: cx - width / 2, minY: cy - height / 2, maxX: cx + width / 2, maxY: cy + height / 2 };
      const transform = rotation ? ` transform="rotate(${fmt(rotation)} ${fmt(cx)} ${fmt(cy)})"` : '';
      outputs.push({ d: `M ${fmt(cx - width / 2)} ${fmt(cy - height / 2)} h ${fmt(width)} v ${fmt(height)} h ${fmt(-width)} Z`, bounds, transform });
      continue;
    }
    if (tokens[0] === 'CIRCLE' && tokens.length === 4 && [tokens[1], tokens[2], tokens[3]].every(finite) && tokens[3] > 0) {
      const cx = tokens[1] * scale, cy = tokens[2] * scale, radius = Math.abs(tokens[3] * scale);
      const bounds = { minX: cx - radius, minY: cy - radius, maxX: cx + radius, maxY: cy + radius };
      const d = `M ${fmt(cx - radius)} ${fmt(cy)} A ${fmt(radius)} ${fmt(radius)} 0 1 0 ${fmt(cx + radius)} ${fmt(cy)} A ${fmt(radius)} ${fmt(radius)} 0 1 0 ${fmt(cx - radius)} ${fmt(cy)} Z`;
      outputs.push({ d, bounds, transform: '' });
      continue;
    }
    if (tokens.length < 2 || !finite(tokens[0]) || !finite(tokens[1])) continue;
    let index = 2;
    let mode = 'L';
    let x = tokens[0] * scale, y = tokens[1] * scale;
    const bounds = emptyBounds();
    addPoint(bounds, x, y);
    let d = `M ${fmt(x)} ${fmt(y)}`;
    while (index < tokens.length) {
      const token = tokens[index];
      if (typeof token === 'string') {
        const command = token.toUpperCase();
        if (command === 'L') { mode = 'L'; index += 1; continue; }
        if (command === 'ARC') {
          const angle = Number(tokens[index + 1]);
          const nextX = Number(tokens[index + 2]) * scale;
          const nextY = Number(tokens[index + 3]) * scale;
          if (![angle, nextX, nextY].every(finite)) break;
          const chord = Math.hypot(nextX - x, nextY - y);
          const sine = Math.sin(Math.abs(angle) * Math.PI / 360);
          const radius = chord > 0 && Math.abs(sine) > 1e-9 ? Math.abs(chord / (2 * sine)) : chord / 2;
          const largeArc = Math.abs(angle) > 180 ? 1 : 0;
          const sweep = angle >= 0 ? 1 : 0;
          d += ` A ${fmt(radius)} ${fmt(radius)} 0 ${largeArc} ${sweep} ${fmt(nextX)} ${fmt(nextY)}`;
          addPoint(bounds, x, y);
          addPoint(bounds, nextX, nextY);
          x = nextX; y = nextY; index += 4; mode = 'L'; continue;
        }
        index += 1;
        continue;
      }
      const nextX = Number(tokens[index]) * scale;
      const nextY = Number(tokens[index + 1]) * scale;
      if (![nextX, nextY].every(finite)) break;
      d += mode === 'L' ? ` L ${fmt(nextX)} ${fmt(nextY)}` : ` L ${fmt(nextX)} ${fmt(nextY)}`;
      addPoint(bounds, nextX, nextY);
      x = nextX; y = nextY; index += 2;
    }
    if (validBounds(bounds)) outputs.push({ d: `${d} Z`, bounds, transform: '' });
  }
  return outputs;
}

function padGeometry(pad) {
  if (!finite(pad?.x) || !finite(pad?.y) || !Array.isArray(pad.pad)) return [];
  const shape = String(pad.pad[0] ?? '').toUpperCase();
  if (shape === 'POLYGON') return parseComplexPolygon(pad.pad[1]).map(item=>({...item,element:`<path d="${item.d}"/>`}));
  if (shape === 'NGON') {
    const diameter=Math.abs(Number(pad.pad[1])),sides=Number(pad.pad[2]);
    if(!finite(diameter)||diameter<=0||!Number.isInteger(sides)||sides<3||sides>64)return [];
    const radius=diameter/2,rotation=finite(pad.rotation)?pad.rotation:0;
    const points=Array.from({length:sides},(_,index)=>{const angle=-Math.PI/2+index*2*Math.PI/sides;return `${fmt(radius*Math.cos(angle))},${fmt(radius*Math.sin(angle))}`;}).join(' ');
    const bounds={minX:pad.x-radius,minY:pad.y-radius,maxX:pad.x+radius,maxY:pad.y+radius};
    return [{element:`<polygon points="${points}"/>`,transform:`translate(${fmt(pad.x)} ${fmt(pad.y)}) rotate(${fmt(rotation)})`,bounds}];
  }
  const width = Math.abs(Number(pad.pad[1]));
  const height = Math.abs(Number(pad.pad[2] ?? pad.pad[1]));
  if (![width, height].every(finite) || width <= 0 || height <= 0) return [];
  const boundsRadius = Math.hypot(width, height) / 2;
  const bounds = { minX: pad.x - boundsRadius, minY: pad.y - boundsRadius, maxX: pad.x + boundsRadius, maxY: pad.y + boundsRadius };
  const rotation = finite(pad.rotation) ? pad.rotation : 0;
  const transform = `translate(${fmt(pad.x)} ${fmt(pad.y)}) rotate(${fmt(rotation)})`;
  if (shape === 'ELLIPSE') return [{ element: `<ellipse cx="0" cy="0" rx="${fmt(width / 2)}" ry="${fmt(height / 2)}"/>`, transform, bounds }];
  const radius = shape === 'OVAL' ? Math.min(width, height) / 2 : Math.max(0, Math.min(Number(pad.pad[3] ?? 0), Math.min(width, height) / 2));
  return [{ element: `<rect x="${fmt(-width / 2)}" y="${fmt(-height / 2)}" width="${fmt(width)}" height="${fmt(height)}" rx="${fmt(radius)}" ry="${fmt(radius)}"/>`, transform, bounds }];
}

function holeGeometry(pad) {
  if(pad?.layer!==12||pad.physicalDrill?.present===false||pad.holeReadback?.verified===false)return null;
  if (!finite(pad?.x) || !finite(pad?.y) || !Array.isArray(pad.hole)) return null;
  const shape = String(pad.hole[0] ?? '').toUpperCase();
  const width = Math.abs(Number(pad.hole[1]));
  const height = Math.abs(Number(pad.hole[2] ?? pad.hole[1]));
  if (![width, height].every(finite) || width <= 0 || height <= 0) return null;
  const rotation = finite(pad.rotation) ? pad.rotation : 0;
  const transform = `translate(${fmt(pad.x)} ${fmt(pad.y)}) rotate(${fmt(rotation)})`;
  if (shape === 'SLOT') return { element: `<rect x="${fmt(-width / 2)}" y="${fmt(-height / 2)}" width="${fmt(width)}" height="${fmt(height)}" rx="${fmt(Math.min(width, height) / 2)}"/>`, transform };
  return { element: `<ellipse cx="0" cy="0" rx="${fmt(width / 2)}" ry="${fmt(height / 2)}"/>`, transform };
}

function layerColor(layer) {
  return typeof layer?.color === 'string' && /^#[0-9a-f]{6}$/i.test(layer.color) ? layer.color : '#d7dde8';
}

export function renderSnapshotSvg(snapshot, options = {}) {
  if (!snapshot || snapshot.units !== 'mil' || !Array.isArray(snapshot.layers)) throw Error('A typed mil snapshot with layers is required');
  const layerMode = options.layerMode ?? 'visible';
  if (!['visible', 'all', 'explicit'].includes(layerMode)) throw Error('layerMode must be visible, all or explicit');
  const layerRows = snapshot.layers.filter(layer => Number.isInteger(layer?.id)).sort((a, b) => a.id - b.id);
  const knownLayerIds = new Set(layerRows.map(layer => layer.id));
  let selectedLayerIds;
  if (layerMode === 'visible') selectedLayerIds = new Set(layerRows.filter(layer => layer.layerStatus === 1 || layer.layerStatus === 'SHOW' || layer.layerStatus === 'VISIBLE').map(layer => layer.id));
  else if (layerMode === 'all') selectedLayerIds = new Set(layerRows.map(layer => layer.id));
  else {
    if (!Array.isArray(options.layerIds) || !options.layerIds.length || new Set(options.layerIds).size !== options.layerIds.length || options.layerIds.some(id => !Number.isInteger(id) || !knownLayerIds.has(id))) throw Error('explicit layerMode requires unique existing layerIds');
    selectedLayerIds = new Set(options.layerIds);
  }
  if (layerMode !== 'explicit' && options.layerIds !== undefined) throw Error('layerIds is only valid for layerMode=explicit');
  const designators = options.designators ?? 'visible';
  if (!['visible', 'all', 'none'].includes(designators)) throw Error('designators must be visible, all or none');
  const region = options.region ?? null;
  if (region && !validBounds(region)) throw Error('region must have finite nonzero min/max bounds');
  const marginMil = options.marginMil ?? 50;
  if (!finite(marginMil) || marginMil < 0 || marginMil > 10000) throw Error('marginMil must be 0..10000');

  const layers = new Map(layerRows.map(layer => [layer.id, { ...layer, shapes: [] }]));
  const counts = { lines: 0, polylines: 0, pads: 0, holes: 0, vias: 0, pours: 0, poured: 0, fills: 0, regions: 0, components: 0, text: 0, omitted: 0 };
  const push = (layerId, kind, bounds, svg) => {
    if (!selectedLayerIds.has(layerId) || !validBounds(bounds) || !intersects(bounds, region)) return;
    const layer = layers.get(layerId);
    if (!layer) { counts.omitted += 1; return; }
    layer.shapes.push({ kind, bounds, svg });
    if (kind in counts) counts[kind] += 1;
  };
  const title = value => value ? `<title>${escapeXml(value)}</title>` : '';
  const boardBounds = emptyBounds();
  for (const line of snapshot.lines ?? []) {
    const radius = finite(line.lineWidth) && line.lineWidth > 0 ? line.lineWidth / 2 : 0;
    addPoint(boardBounds, line.startX, line.startY, radius);
    addPoint(boardBounds, line.endX, line.endY, radius);
  }
  for (const arcItem of snapshot.arcs ?? []) {
    try {
      const arc = describeArc(arcItem);
      mergeBounds(boardBounds, arcBounds(arc, finite(arcItem.lineWidth) && arcItem.lineWidth > 0 ? arcItem.lineWidth / 2 : 0));
    } catch { counts.omitted += 1; }
  }
  for (const polyline of snapshot.polylines ?? []) for (const item of parseComplexPolygon(polyline.polygon)) mergeBounds(boardBounds,item.bounds);
  for (const pad of snapshot.pads ?? []) for (const item of padGeometry(pad)) mergeBounds(boardBounds, item.bounds);
  for (const via of snapshot.vias ?? []) addPoint(boardBounds, via.x, via.y, finite(via.diameter) ? via.diameter / 2 : 0);
  for (const component of snapshot.components ?? []) addPoint(boardBounds, component.x, component.y, 1);

  const pourOutlines = new Map();
  for (const pour of snapshot.pours ?? []) {
    const paths = parseComplexPolygon(pour.complexPolygon);
    const bounds = emptyBounds();
    for (const item of paths) mergeBounds(bounds, item.bounds);
    const rectangularEncoding = Array.isArray(pour.complexPolygon) && pour.complexPolygon[0] === 'R';
    pourOutlines.set(pour.primitiveId, { pour, paths, bounds, rectangularEncoding });
    if (!rectangularEncoding) for (const item of paths) push(pour.layer, 'pours', item.bounds, `<path d="${item.d}"${item.transform} class="pour-outline">${title(pour.net || pour.pourName)}</path>`);
  }
  for (const poured of snapshot.poured ?? []) {
    const association = pourOutlines.get(poured.pourPrimitiveId ?? poured.primitiveId);
    if (!association) { counts.omitted += 1; continue; }
    if (!selectedLayerIds.has(association.pour.layer)) continue;
    if (poured.fillGeometry?.verified !== true || poured.fillGeometry?.units !== 'mil' || !Array.isArray(poured.pourFillsMil)) throw Error('Poured coordinates require verified canonical mil geometry: '+(poured.primitiveId??''));
    for (const fill of poured.pourFillsMil) {
      const paths = parseComplexPolygon(fill?.path?.complexPolygon);
      const bounds = emptyBounds();
      for (const item of paths) mergeBounds(bounds, item.bounds);
      if (!validBounds(bounds)) { counts.omitted += 1; continue; }
      const d = paths.map(item => item.d).join(' ');
      push(association.pour.layer, 'poured', bounds, `<path d="${d}" class="poured" fill-rule="evenodd">${title(association.pour.net || association.pour.pourName)}</path>`);
    }
  }
  for (const fill of snapshot.fills ?? []) {
    for (const item of parseComplexPolygon(fill.complexPolygon)) push(fill.layer, 'fills', item.bounds, `<path d="${item.d}"${item.transform} class="solid-region">${title(fill.net)}</path>`);
  }
  for (const item of snapshot.regions ?? []) {
    for (const pathItem of parseComplexPolygon(item.complexPolygon)) push(item.layer, 'regions', pathItem.bounds, `<path d="${pathItem.d}"${pathItem.transform} class="region">${title(item.net)}</path>`);
  }
  for (const polyline of snapshot.polylines ?? []) {
    const width=finite(polyline.lineWidth)&&polyline.lineWidth>0?polyline.lineWidth:1;
    for(const pathItem of parseComplexPolygon(polyline.polygon))push(polyline.layer,'polylines',pathItem.bounds,`<path d="${pathItem.d}"${pathItem.transform} fill="none" stroke-width="${fmt(width)}" class="track">${title(polyline.net)}</path>`);
  }
  for (const arcItem of snapshot.arcs ?? []) {
    try {
      const width=finite(arcItem.lineWidth)&&arcItem.lineWidth>0?arcItem.lineWidth:1;
      const arc=describeArc(arcItem),bounds=arcBounds(arc,width/2);
      push(arcItem.layer,'arcs',bounds,`<path d="${arcSvgPath(arc,fmt)}" fill="none" stroke-width="${fmt(width)}" class="track">${title(arcItem.net)}</path>`);
    } catch { counts.omitted += 1; }
  }
  for (const line of snapshot.lines ?? []) {
    if (![line.startX, line.startY, line.endX, line.endY].every(finite)) { counts.omitted += 1; continue; }
    const width = finite(line.lineWidth) && line.lineWidth > 0 ? line.lineWidth : 1;
    const bounds = emptyBounds(); addPoint(bounds, line.startX, line.startY, width / 2); addPoint(bounds, line.endX, line.endY, width / 2);
    push(line.layer, 'lines', bounds, `<line x1="${fmt(line.startX)}" y1="${fmt(line.startY)}" x2="${fmt(line.endX)}" y2="${fmt(line.endY)}" stroke-width="${fmt(width)}" class="track">${title(line.net)}</line>`);
  }
  for (const pad of snapshot.pads ?? []) {
    const geometry = padGeometry(pad);
    if (!geometry.length) { counts.omitted += 1; continue; }
    for (const item of geometry) {
      const transform = item.transform ? ` transform="${item.transform}"` : '';
      push(pad.layer, 'pads', item.bounds, `<g${transform} class="pad">${title(`${pad.net ?? ''} pad ${pad.padNumber ?? ''}`)}${item.element}</g>`);
    }
    const hole = holeGeometry(pad);
    if (hole && selectedLayerIds.has(pad.layer)) {
      const bounds = geometry[0]?.bounds;
      if (bounds && intersects(bounds, region)) {
        const layer = layers.get(pad.layer);
        layer?.shapes.push({ kind: 'holes', bounds, svg: `<g transform="${hole.transform}" class="hole">${hole.element}</g>` });
        counts.holes += 1;
      }
    }
  }
  const viaLayer = knownLayerIds.has(12) ? 12 : [...selectedLayerIds][0];
  for (const via of snapshot.vias ?? []) {
    if (![via.x, via.y, via.diameter].every(finite) || via.diameter <= 0) { counts.omitted += 1; continue; }
    const radius = via.diameter / 2;
    const bounds = { minX: via.x - radius, minY: via.y - radius, maxX: via.x + radius, maxY: via.y + radius };
    const holeRadius = finite(via.holeDiameter) && via.holeDiameter > 0 ? via.holeDiameter / 2 : 0;
    push(viaLayer, 'vias', bounds, `<g class="via">${title(via.net)}<circle cx="${fmt(via.x)}" cy="${fmt(via.y)}" r="${fmt(radius)}"/><circle cx="${fmt(via.x)}" cy="${fmt(via.y)}" r="${fmt(holeRadius)}" class="hole"/></g>`);
  }
  if (designators === 'all') {
    for (const component of snapshot.components ?? []) {
      if (![component.x, component.y].every(finite) || !component.designator) continue;
      const size = 32;
      const bounds = { minX: component.x - size * 2, minY: component.y - size, maxX: component.x + size * 2, maxY: component.y + size };
      push(component.layer, 'components', bounds, `<g class="component-label" transform="translate(${fmt(component.x)} ${fmt(component.y)}) rotate(${fmt(component.rotation ?? 0)})"><circle r="5"/><text x="8" y="0">${escapeXml(component.designator)}</text></g>`);
    }
  }
  if (designators !== 'none') {
    for (const attribute of snapshot.attributes ?? []) {
      const visible = attribute.valueVisible === true || attribute.keyVisible === true;
      if (!visible || !finite(attribute.x) || !finite(attribute.y)) continue;
      if (designators === 'all' && attribute.key === 'Designator') continue;
      const value = attribute.valueVisible ? attribute.value : attribute.key;
      if (!value) continue;
      const fontSize = finite(attribute.fontSize) && attribute.fontSize > 0 ? attribute.fontSize : 30;
      const bounds = { minX: attribute.x - fontSize * String(value).length * 0.35, minY: attribute.y - fontSize, maxX: attribute.x + fontSize * String(value).length * 0.35, maxY: attribute.y + fontSize };
      const rotation = finite(attribute.rotation) ? ((attribute.rotation % 360) + 360) % 360 : 0;
      push(attribute.layer, 'text', bounds, `<text x="${fmt(attribute.x)}" y="${fmt(attribute.y)}" font-size="${fmt(fontSize)}" transform="rotate(${fmt(rotation)} ${fmt(attribute.x)} ${fmt(attribute.y)})" class="silk-text">${escapeXml(value)}</text>`);
    }
  }
  for (const string of snapshot.strings ?? []) {
    if (!finite(string.x) || !finite(string.y) || !string.text) continue;
    const fontSize = finite(string.fontSize) && string.fontSize > 0 ? string.fontSize : 30;
    const bounds = { minX: string.x - fontSize * String(string.text).length * 0.35, minY: string.y - fontSize, maxX: string.x + fontSize * String(string.text).length * 0.35, maxY: string.y + fontSize };
    push(string.layer, 'text', bounds, `<text x="${fmt(string.x)}" y="${fmt(string.y)}" font-size="${fmt(fontSize)}" class="silk-text">${escapeXml(string.text)}</text>`);
  }

  const contentBounds = emptyBounds();
  for (const layer of layers.values()) for (const shape of layer.shapes) mergeBounds(contentBounds, shape.bounds);
  const baseBounds = region ?? contentBounds;
  if (!validBounds(baseBounds)) throw Error('No renderable geometry in the selected layers/region');
  const view = {
    minX: baseBounds.minX - marginMil,
    minY: baseBounds.minY - marginMil,
    maxX: baseBounds.maxX + marginMil,
    maxY: baseBounds.maxY + marginMil,
  };
  const width = view.maxX - view.minX, height = view.maxY - view.minY;
  const clipId = 'inspection-clip';
  const groups = [];
  const renderedLayers = [];
  for (const layer of [...layers.values()].sort((a, b) => a.id - b.id)) {
    if (!layer.shapes.length) continue;
    renderedLayers.push({ id: layer.id, name: layer.name ?? `Layer ${layer.id}`, type: layer.type ?? null, color: layerColor(layer), primitiveCount: layer.shapes.length });
    groups.push(`<g id="layer-${layer.id}" data-layer-id="${layer.id}" data-layer-name="${escapeXml(layer.name ?? '')}" style="--layer-color:${layerColor(layer)}">${layer.shapes.map(shape => shape.svg).join('')}</g>`);
  }
  const metadata = {
    format: 'easyeda-pcb-inspection-svg/v1',
    sourceDocument: snapshot.document ?? null,
    sourceUnits: 'mil',
    stableReads: 2,
    layerMode,
    requestedLayerIds: layerMode === 'explicit' ? [...selectedLayerIds] : null,
    region: region ?? null,
    renderedLayers,
    counts,
    limitations: [
      'Generated from stable typed API fields without changing editor viewport, selection or layer visibility.',
      'Poured geometry requires explicit verified canonical mil coordinates; no bounding-box-based scale inference is performed.',
      'Curved polygon segments use SVG arc reconstruction; component body and courtyard geometry are not independently reconstructed.',
      'This view does not certify copper connectivity, DRC, current capacity, signal integrity, mechanics, solder mask, assembly or manufacturing output.',
    ],
  };
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(view.minX)} ${fmt(view.minY)} ${fmt(width)} ${fmt(height)}" width="1600" height="${Math.max(1, Math.round(1600 * height / width))}" preserveAspectRatio="xMidYMid meet">\n<title>EasyEDA PCB API inspection view</title>\n<desc>Stable typed API rendering; editor state was not changed.</desc>\n<metadata>${escapeXml(JSON.stringify(metadata))}</metadata>\n<defs><clipPath id="${clipId}"><rect x="${fmt(view.minX)}" y="${fmt(view.minY)}" width="${fmt(width)}" height="${fmt(height)}"/></clipPath></defs>\n<style>svg{background:#101216}.track{stroke:var(--layer-color);stroke-linecap:round;fill:none}.pad,.via{fill:var(--layer-color);stroke:#f4f7fb;stroke-width:.8}.hole{fill:#101216;stroke:#667085;stroke-width:.6}.poured{fill:var(--layer-color);fill-opacity:.2;stroke:none}.pour-outline,.region,.solid-region{fill:var(--layer-color);fill-opacity:.08;stroke:var(--layer-color);stroke-width:1}.component-label circle{fill:var(--layer-color)}.component-label text,.silk-text{fill:var(--layer-color);font-family:Arial,"Microsoft YaHei",sans-serif;text-anchor:middle;dominant-baseline:middle;paint-order:stroke;stroke:#101216;stroke-width:1.2}</style>\n<rect x="${fmt(view.minX)}" y="${fmt(view.minY)}" width="${fmt(width)}" height="${fmt(height)}" fill="#101216"/>\n<g clip-path="url(#${clipId})">${groups.join('')}</g>\n</svg>\n`;
  return { svg, metadata, viewBox: view, widthMil: width, heightMil: height, renderedLayers, counts };
}

export async function renderInspectionSvg(request) {
  assertAllowedTarget(request.target);
  if (!request.target?.documentUuid || !request.target?.projectUuid || !request.target?.windowId) throw Error('Vector inspection requires exact project/document/window');
  if (typeof request.outputPath !== 'string' || !path.isAbsolute(request.outputPath) || path.extname(request.outputPath).toLowerCase() !== '.svg') throw Error('outputPath must be an absolute .svg filename');
  const parent = await fs.lstat(path.dirname(request.outputPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Vector inspection parent must be an existing regular directory');
  try { await fs.lstat(request.outputPath); throw Error('Vector inspection destination already exists; overwrite is not supported'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const maxBytes = request.maxBytes ?? 16777216;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 33554432) throw Error('maxBytes must be 1024..33554432');
  const units = request.units ?? 'mil';
  if (!['mil', 'mm'].includes(units)) throw Error('units must be mil or mm');
  const scale = units === 'mm' ? 1 / 0.0254 : 1;
  const region = request.region ? {
    minX: Math.min(request.region.left, request.region.right) * scale,
    maxX: Math.max(request.region.left, request.region.right) * scale,
    minY: Math.min(request.region.top, request.region.bottom) * scale,
    maxY: Math.max(request.region.top, request.region.bottom) * scale,
  } : null;
  const marginMil = (request.margin ?? (units === 'mm' ? 1.27 : 50)) * scale;
  const bridge = await resolveBridge({ bridgeUrl: request.bridgeUrl, windowId: request.target.windowId, requireEda: true });
  const code = `return await (${captureSnapshotRuntime.toString()})(eda,${JSON.stringify({ target: request.target })},${readRuntime.toString()},${constraintRuntime.toString()});`;
  const snapshot = await executeBridgeCode(bridge, code, 240_000);
  const rendered = renderSnapshotSvg(snapshot, {
    layerMode: request.layerMode ?? 'visible',
    layerIds: request.layerIds,
    designators: request.designators ?? 'visible',
    region,
    marginMil,
  });
  const bytes = Buffer.from(rendered.svg, 'utf8');
  if (bytes.length > maxBytes) throw Error('Vector inspection SVG exceeds maxBytes; no file written');
  let created = false;
  try {
    const handle = await fs.open(request.outputPath, 'wx');
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    const persisted = await fs.readFile(request.outputPath);
    if (!persisted.equals(bytes)) throw Error('Vector inspection disk readback mismatch');
  } catch (error) {
    if (created) await fs.rm(request.outputPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    bridge: { baseUrl: bridge.baseUrl, windowId: bridge.windowId },
    path: request.outputPath,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    units: 'mil',
    viewBox: rendered.viewBox,
    widthMil: rendered.widthMil,
    heightMil: rendered.heightMil,
    layerMode: request.layerMode ?? 'visible',
    renderedLayers: rendered.renderedLayers,
    counts: rendered.counts,
    stableReads: 2,
    verifiedTransfer: true,
    overwritten: false,
    editorStateModified: false,
    pcbModified: false,
    limitations: rendered.metadata.limitations,
  };
}

import { hashBytes } from './gateway-client.mjs';

export function tokenizeSExpression(text, { maximumBytes = 12582912, maximumTokens = 2000000 } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maximumBytes) throw new Error('DSN text exceeds its byte limit');
  const tokens = [];
  let index = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let quote = '"';
  const push = token => { if (tokens.length >= maximumTokens) throw new Error('DSN token limit exceeded'); tokens.push(token); };
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === ';') { while (index < text.length && text[index] !== '\n') index++; continue; }
    if (char === '(' || char === ')') { push({ kind: char === '(' ? 'open' : 'close', offset: index++ }); continue; }
    const previous = tokens.at(-1);
    if (previous?.kind === 'atom' && previous.value.toLowerCase() === 'string_quote' && tokens.at(-2)?.kind === 'open') {
      quote = char; push({ kind: 'atom', value: char, offset: index++ }); continue;
    }
    const start = index;
    if (char === quote) {
      index++;
      let value = '', closed = false;
      while (index < text.length) {
        const current = text[index++];
        if (current === quote) { closed = true; break; }
        if (current === '\\' && index < text.length) {
          const next = text[index++];
          value += next === quote || next === '\\' ? next : '\\' + next;
        } else value += current;
      }
      if (!closed) throw new Error(`Unterminated DSN string at offset ${start}`);
      push({ kind: 'atom', value, offset: start });
    } else {
      while (index < text.length && !/[\s();]/.test(text[index])) index++;
      push({ kind: 'atom', value: text.slice(start, index), offset: start });
    }
  }
  return tokens;
}

export function parseSExpression(text, options = {}) {
  const tokens = tokenizeSExpression(text, options);
  const roots = [], stack = [];
  const maximumDepth = options.maximumDepth ?? 128;
  for (const token of tokens) {
    if (token.kind === 'open') {
      if (stack.length >= maximumDepth) throw new Error('DSN nesting limit exceeded');
      const node = [];
      (stack.length ? stack.at(-1) : roots).push(node);
      stack.push(node);
    } else if (token.kind === 'close') {
      if (!stack.length) throw new Error(`Unexpected DSN closing parenthesis at offset ${token.offset}`);
      stack.pop();
    } else {
      if (!stack.length) throw new Error(`DSN atom outside an expression at offset ${token.offset}`);
      stack.at(-1).push(token.value);
    }
  }
  if (stack.length) throw new Error('Unclosed DSN expression');
  if (roots.length !== 1) throw new Error('DSN must contain one root expression');
  return roots[0];
}
const keyword = node => Array.isArray(node) && typeof node[0] === 'string' ? node[0].toLowerCase() : '';
const children = (node, name) => (node ?? []).filter(item => keyword(item) === name);
const child = (node, name) => children(node, name)[0] ?? null;
const number = (value, label) => {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) throw new Error(`Invalid DSN number: ${label}`);
  return Number(value);
};
const name = (value, label) => { if (typeof value !== 'string' || !value.length) throw new Error(`Missing DSN identifier: ${label}`); return value; };
function uniqueMap(items, key, label) {
  const map = new Map();
  for (const item of items) { if (map.has(item[key])) throw new Error(`Duplicate ${label}: ${item[key]}`); map.set(item[key], item); }
  return map;
}

/** Coordinates use the declared unit. DSN resolution is precision, not a divisor. */
export function parseDsnScene(text) {
  const root = parseSExpression(text);
  if (keyword(root) !== 'pcb') throw new Error('Expected a PCB DSN root');
  const resolutionNode = child(root, 'resolution');
  const explicitUnit = child(root, 'unit')?.[1];
  const sourceUnit = name(explicitUnit ?? resolutionNode?.[1], 'unit').toLowerCase();
  const scaleMm = { mm: 1, mil: 0.0254, inch: 25.4, in: 25.4, um: 0.001, cm: 10 }[sourceUnit];
  if (!scaleMm) throw new Error(`Unsupported DSN unit ${sourceUnit}`);
  if (explicitUnit && resolutionNode && explicitUnit.toLowerCase() !== resolutionNode[1].toLowerCase()) throw new Error('Conflicting DSN unit and resolution declarations');
  const resolution = resolutionNode ? number(resolutionNode[2], 'resolution') : null;
  if (resolution !== null && resolution <= 0) throw new Error('DSN resolution must be positive');
  const length = (value, label) => number(value, label) * scaleMm;
  const warnings = [];
  function shape(node) {
    const type = keyword(node);
    if (['path', 'polygon'].includes(type)) {
      const atoms = node.slice(3).filter(value => typeof value === 'string');
      if (atoms.length < 4 || atoms.length % 2) throw new Error(`Invalid DSN ${type} coordinates`);
      const points = [];
      for (let i = 0; i < atoms.length; i += 2) points.push([length(atoms[i], `${type}.x`), length(atoms[i + 1], `${type}.y`)]);
      return { type, layer: name(node[1], 'shape layer'), width: length(node[2], 'shape width'), points };
    }
    if (type === 'rect') return { type, layer: name(node[1], 'shape layer'), bounds: [length(node[2], 'x1'), length(node[3], 'y1'), length(node[4], 'x2'), length(node[5], 'y2')] };
    if (type === 'circle') return { type, layer: name(node[1], 'shape layer'), diameter: length(node[2], 'diameter'), x: node[3] === undefined ? 0 : length(node[3], 'x'), y: node[4] === undefined ? 0 : length(node[4], 'y') };
    warnings.push({ code: 'UNSUPPORTED_SHAPE', shape: type });
    return { type, raw: node, supported: false };
  }
  const structure = child(root, 'structure');
  const library = child(root, 'library');
  const placement = child(root, 'placement');
  const network = child(root, 'network');
  const wiring = child(root, 'wiring');
  if (!structure || !library || !placement || !network) throw new Error('DSN requires structure, library, placement and network sections');
  const layers = children(structure, 'layer').map((node, index) => ({ name: name(node[1], 'layer'), ordinal: index, type: child(node, 'type')?.[1] ?? null }));
  uniqueMap(layers, 'name', 'DSN layer');
  const boardOutline = children(structure, 'boundary').flatMap(node => node.slice(1).filter(Array.isArray).map(shape));
  const padstacks = children(library, 'padstack').map(node => ({ id: name(node[1], 'padstack'), shapes: children(node, 'shape').flatMap(entry => entry.slice(1).filter(Array.isArray).map(shape)), attributes: node.slice(2).filter(entry => keyword(entry) !== 'shape') }));
  const stackMap = uniqueMap(padstacks, 'id', 'DSN padstack');
  const images = children(library, 'image').map(node => ({
    id: name(node[1], 'image'),
    pins: children(node, 'pin').map(pin => {
      const atoms = pin.filter(value => typeof value === 'string');
      return { padstackId: name(atoms[1], 'pin padstack'), pinId: name(atoms[2], 'pin'), localX: length(atoms[3], 'pin x'), localY: length(atoms[4], 'pin y'), rotation: child(pin, 'rotate') ? number(child(pin, 'rotate')[1], 'pin rotation') : 0 };
    }),
    outlines: children(node, 'outline').flatMap(entry => entry.slice(1).filter(Array.isArray).map(shape)),
    keepouts: children(node, 'keepout'),
  }));
  const imageMap = uniqueMap(images, 'id', 'DSN image');
  const components = children(placement, 'component').flatMap(node => children(node, 'place').map(place => ({ imageId: name(node[1], 'placed image'), reference: name(place[1], 'placement reference'), x: length(place[2], 'placement x'), y: length(place[3], 'placement y'), side: name(place[4], 'placement side'), rotation: number(place[5], 'placement rotation') })));
  uniqueMap(components, 'reference', 'placement reference');
  const nets = children(network, 'net').map(node => ({ name: name(node[1], 'net'), pins: children(node, 'pins').flatMap(pin => pin.slice(1).map(value => name(value, 'net pin'))) }));
  uniqueMap(nets, 'name', 'DSN net');
  const pinNets = new Map();
  for (const net of nets) for (const pin of net.pins) {
    if (pinNets.has(pin) && pinNets.get(pin) !== net.name) throw new Error(`DSN pin belongs to multiple nets: ${pin}`);
    pinNets.set(pin, net.name);
  }
  const pads = [];
  for (const component of components) {
    const image = imageMap.get(component.imageId);
    if (!image) { warnings.push({ code: 'MISSING_IMAGE', reference: component.reference }); continue; }
    for (const pin of image.pins) {
      const id = `${component.reference}-${pin.pinId}`;
      const resolved = component.side.toLowerCase() === 'front';
      const radians = component.rotation * Math.PI / 180;
      const pad = { id, component: component.reference, pinId: pin.pinId, padstackId: pin.padstackId, net: pinNets.get(id) ?? null, localX: pin.localX, localY: pin.localY, rotation: component.rotation + pin.rotation, transformResolved: resolved };
      if (resolved) { pad.x = component.x + pin.localX * Math.cos(radians) - pin.localY * Math.sin(radians); pad.y = component.y + pin.localX * Math.sin(radians) + pin.localY * Math.cos(radians); }
      else warnings.push({ code: 'BACK_SIDE_TRANSFORM_UNVERIFIED', pad: id });
      if (!stackMap.has(pin.padstackId)) warnings.push({ code: 'MISSING_PADSTACK', pad: id });
      pads.push(pad);
    }
  }
  const padMap = uniqueMap(pads, 'id', 'DSN pin');
  const unresolvedNetPins = [...pinNets.keys()].filter(pin => !padMap.has(pin));
  const tracks = [];
  for (const [wireIndex, wire] of children(wiring, 'wire').entries()) {
    const net = child(wire, 'net')?.[1] ?? null;
    for (const node of wire.slice(1).filter(Array.isArray)) {
      if (keyword(node) === 'path') {
        const parsed = shape(node);
        if (parsed.width <= 0) throw new Error('DSN wire width must be positive');
        for (let i = 1; i < parsed.points.length; i++) tracks.push({ id: `wire-${wireIndex}-${i}`, net, layer: parsed.layer, width: parsed.width, start: parsed.points[i - 1], end: parsed.points[i] });
      } else if (!['net', 'type', 'shield', 'turret'].includes(keyword(node))) warnings.push({ code: 'UNSUPPORTED_WIRING', shape: keyword(node), wire: wireIndex });
    }
  }
  const vias = children(wiring, 'via').map((node, index) => ({ id: `via-${index}`, padstackId: name(node[1], 'via padstack'), x: length(node[2], 'via x'), y: length(node[3], 'via y'), net: child(node, 'net')?.[1] ?? null, layers: stackMap.get(node[1])?.shapes.map(item => item.layer).filter(Boolean) ?? [] }));
  const scene = {
    schema: 'easyeda-route-scene/v1', sourceSha256: hashBytes(Buffer.from(text, 'utf8')), boardName: root[1], units: 'mm', sourceUnits: sourceUnit, resolution,
    coordinateFrame: 'DSN export coordinates', apiCoordinateTransform: null,
    boardOutline, layers, rules: children(structure, 'rule'), components, images, padstacks, pads, nets, tracks, vias,
    coverage: { syntaxValid: true, frontPlacementTransforms: true, backPlacementTransforms: false, pouredCopper: false, nativeComponentIdentity: false, unresolvedNetPins, warnings },
    ignoredRootSections: root.filter(Array.isArray).map(keyword).filter(key => !['parser', 'resolution', 'unit', 'structure', 'library', 'placement', 'network', 'wiring'].includes(key)),
  };
  scene.summary = { layerCount: layers.length, placementCount: components.length, padCount: pads.length, netCount: nets.length, segmentCount: tracks.length, viaCount: vias.length, unresolvedPinCount: unresolvedNetPins.length, warningCount: warnings.length };
  return scene;
}

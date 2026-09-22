import { hashBytes, readNativeText } from './gateway-client.mjs';

const NUMBER = '[+-]?(?:\\d+(?:[.,]\\d+)?|\\.\\d+)';
const normalize = text => text.trim().toLowerCase().replace(/[\s_\-]/g, '');
const aliases = new Map([
  ['projecttitle', 'projectTitle'], ['工程标题', 'projectTitle'], ['boardtitle', 'boardTitle'], ['板子标题', 'boardTitle'],
  ['pcbtitle', 'pcbTitle'], ['pcb标题', 'pcbTitle'], ['time', 'timestamp'], ['时间', 'timestamp'],
  ['boardsize', 'boardSize'], ['板子尺寸', 'boardSize'], ['layers', 'layers'], ['layer', 'layers'], ['层', 'layers'],
  ['devices', 'deviceCount'], ['device', 'deviceCount'], ['器件', 'deviceCount'], ['footprints', 'footprintCount'], ['footprint', 'footprintCount'], ['封装', 'footprintCount'],
  ['components', 'components'], ['component', 'components'], ['元件', 'components'], ['pads', 'pads'], ['pad', 'pads'], ['焊盘', 'pads'],
  ['nets', 'nets'], ['net', 'nets'], ['网络', 'nets'], ['testpoints', 'testPoints'], ['测试点', 'testPoints'],
  ['cutoutregions', 'cutoutCount'], ['cutouts', 'cutoutCount'], ['挖槽区域', 'cutoutCount'],
  ['vias', 'vias'], ['via', 'vias'], ['过孔', 'vias'], ['copperpourregions', 'pourBoundaryCount'], ['copperpours', 'pourBoundaryCount'], ['pourregions', 'pourBoundaryCount'], ['铺铜区域', 'pourBoundaryCount'],
  ['tracelength', 'traceLength'], ['tracklength', 'traceLength'], ['wirelength', 'traceLength'], ['导线长度', 'traceLength'],
]);
function count(value) {
  const text = value.trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}
function metric(value, labels) {
  const pieces = value.split(/[,，;；]/);
  for (const label of labels) {
    const match = pieces.map(piece => piece.trim().match(new RegExp(`^${label}\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*%?$`, 'i'))).find(Boolean);
    if (match) return Number(match[1]);
  }
  return null;
}
function lengthMm(value) {
  const match = value.trim().match(new RegExp(`^(${NUMBER})\\s*(mm|mil|inch|in|um|µm)$`, 'i'));
  if (!match) return null;
  const number = Number(match[1].replace(',', '.'));
  return number * ({ mm: 1, mil: 0.0254, inch: 25.4, in: 25.4, um: 0.001, 'µm': 0.001 }[match[2].toLowerCase()]);
}

/** Keep distinct native labels: device count is not placed component count. */
export function parseNativeBoardInfo(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1048576) throw new Error('PCB Info must be bounded UTF-8 text');
  const result = { rawFileSha256: hashBytes(Buffer.from(text, 'utf8')), localeDetected: /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-or-other', nativeLabels: {}, unparsedLines: [], issues: [] };
  const put = (key, value, line) => {
    if (value === null || value === undefined || (typeof value === 'number' && (!Number.isFinite(value) || value < 0))) { result.unparsedLines.push(line); return; }
    if (result[key] !== undefined && JSON.stringify(result[key]) !== JSON.stringify(value)) { result.issues.push({ code: 'CONFLICTING_FIELD', field: key, values: [result[key], value] }); return; }
    result[key] = value;
  };
  let previousLabel = null;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const split = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!split) {
      if (previousLabel === 'testPoints' && metric(line, ['总计', 'total']) !== null) {
        put('testPointCount', metric(line, ['总计', 'total']), raw);
        put('topTestPointCount', metric(line, ['顶面测试点', 'top(?: test points)?']), raw);
        put('bottomTestPointCount', metric(line, ['底面测试点', 'bottom(?: test points)?']), raw);
      } else result.unparsedLines.push(raw);
      continue;
    }
    const label = aliases.get(normalize(split[1]));
    const value = split[2].trim();
    previousLabel = label;
    result.nativeLabels[split[1].trim()] = value;
    if (!label) { result.unparsedLines.push(raw); continue; }
    if (['projectTitle', 'boardTitle', 'pcbTitle', 'timestamp'].includes(label)) { put(label, value, raw); continue; }
    if (['deviceCount', 'footprintCount', 'cutoutCount', 'pourBoundaryCount'].includes(label)) { put(label, count(value), raw); continue; }
    if (label === 'boardSize') {
      const parts = value.split(/\s*[x×]\s*/i);
      const width = parts.length === 2 ? lengthMm(parts[0]) : null;
      const height = parts.length === 2 ? lengthMm(parts[1]) : null;
      put('boardSizeMm', width !== null && height !== null ? { width, height } : null, raw);
    } else if (label === 'layers') {
      put('layerCount', metric(value, ['总计', 'total']), raw);
      put('copperLayerCount', metric(value, ['铜箔层', 'copper(?: layers)?']), raw);
    } else if (label === 'components') {
      put('componentCount', metric(value, ['总计', 'total']) ?? count(value), raw);
      put('topComponentCount', metric(value, ['顶层', 'top(?: layer)?']), raw);
      put('bottomComponentCount', metric(value, ['底层', 'bottom(?: layer)?']), raw);
    } else if (label === 'pads') {
      put('padCount', metric(value, ['总计', 'total']), raw);
      put('topSmdPadCount', metric(value, ['顶面表贴', 'top smd']), raw);
      put('bottomSmdPadCount', metric(value, ['底面表贴', 'bottom smd']), raw);
      put('platedHolePadCount', metric(value, ['金属化孔', 'plated(?: holes)?']), raw);
      put('nonPlatedHolePadCount', metric(value, ['非金属化孔', 'non[- ]?plated(?: holes)?']), raw);
    } else if (label === 'nets') {
      put('netCount', metric(value, ['总计', 'total']), raw);
      put('nativeUnroutedCount', metric(value, ['未布线', 'unrouted', 'unrouted nets']), raw);
    } else if (label === 'vias') {
      put('viaCount', metric(value, ['总计', 'total']), raw);
      put('throughViaCount', metric(value, ['通孔', 'through(?: vias)?']), raw);
      put('blindBuriedViaCount', metric(value, ['盲埋孔', 'blind(?:\\s+and\\s+|/|\\s+)buried(?: vias)?']), raw);
    } else if (label === 'traceLength') put('traceLengthMm', lengthMm(value), raw);
    else if (label === 'testPoints') {
      put('testPointNetCount', metric(value, ['网络总数', 'total nets']), raw);
      put('netsWithTestPoints', metric(value, ['有测试点的网络', 'nets with test points']), raw);
      put('testPointCoveragePercent', metric(value, ['测试点覆盖率', 'test point coverage']), raw);
    }
  }
  result.unparsedLines = [...new Set(result.unparsedLines)];
  const required = ['boardSizeMm', 'copperLayerCount', 'componentCount', 'padCount', 'netCount', 'nativeUnroutedCount', 'viaCount'];
  result.missingFields = required.filter(key => result[key] === undefined);
  result.parsingComplete = result.missingFields.length === 0 && result.unparsedLines.length === 0 && result.issues.length === 0;
  return result;
}

export async function readNativeBoardInfo(request) {
  const file = await readNativeText({ ...request, kind: 'boardInfo' });
  return { ...parseNativeBoardInfo(file.text), target: file.target, transport: file.transport, protocolVersion: file.protocolVersion };
}

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertAllowedTarget, executeBridgeCode, resolveBridge } from './bridge.mjs';

// Serialized into the EasyEDA extension context. It exports only bounded File bytes and never opens a save dialog.
export async function manufacturingFileRuntime(eda, request) {
  if (!request?.target?.documentUuid || !request?.target?.projectUuid) throw Error('Manufacturing export requires exact project/document');
  if (!Number.isInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 16777216) throw Error('Invalid manufacturing export size limit');
  const guard = async () => {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    if (document?.uuid !== request.target.documentUuid || document?.documentType !== 3) throw Error('PCB document/type changed during manufacturing export');
    if (project?.uuid !== request.target.projectUuid) throw Error('PCB project changed during manufacturing export');
    return document;
  };
  await guard();
  const api = eda.pcb_ManufactureData;
  if (!api) throw Error('Public PCB manufacturing API unavailable');
  const methods = {
    gerber: 'getGerberFile',
    pickAndPlace: 'getPickAndPlaceFile',
    bom: 'getBomFile',
    testPoints: 'getTestPointFile',
    netlist: 'getNetlistFile',
    ipcD356A: 'getIpcD356AFile',
  };
  const method = methods[request.kind];
  if (!method || typeof api[method] !== 'function') throw Error(`Manufacturing export API unavailable for ${request.kind}`);
  let file;
  if (request.kind === 'gerber') file = await api.getGerberFile(request.fileName);
  else if (request.kind === 'pickAndPlace') file = await api.getPickAndPlaceFile(request.fileName, request.format, request.unit);
  else if (request.kind === 'bom') file = await api.getBomFile(request.fileName, request.format);
  else if (request.kind === 'testPoints') file = await api.getTestPointFile(request.fileName, request.format);
  else if (request.kind === 'netlist') file = await api.getNetlistFile(request.fileName, request.netlistType);
  else file = await api.getIpcD356AFile(request.fileName);
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isInteger(file.size) || file.size < 1) throw Error('Manufacturing export returned no readable File');
  if (file.size > request.maxBytes) throw Error('Manufacturing export exceeds maxBytes; no bytes transferred');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw Error('Manufacturing File size/readback mismatch');
  if (request.expectArchive && (bytes.length < 4 || bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4)) throw Error('Manufacturing archive signature mismatch');
  if (!request.expectArchive && bytes.every(value => value === 0)) throw Error('Manufacturing export contains only zero bytes');
  await guard();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index], b = bytes[index + 1] ?? 0, c = bytes[index + 2] ?? 0;
    chunk += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)] + (index + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=') + (index + 2 < bytes.length ? alphabet[c & 63] : '=');
    if (chunk.length >= 32768) { parts.push(chunk); chunk = ''; }
  }
  if (chunk) parts.push(chunk);
  return {
    name: file.name ?? null,
    mimeType: file.type ?? null,
    size: bytes.length,
    kind: request.kind,
    format: request.format ?? null,
    unit: request.unit ?? null,
    netlistType: request.netlistType ?? null,
    archive: request.expectArchive,
    encoding: 'base64',
    data: parts.join(''),
  };
}

export function decodeManufacturingFile(payload, maxBytes, expectArchive) {
  if (payload?.encoding !== 'base64' || typeof payload.data !== 'string' || !Number.isInteger(payload.size) || payload.size < 1 || payload.size > maxBytes) throw Error('Invalid manufacturing export response');
  if (payload.data.length !== 4 * Math.ceil(payload.size / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data)) throw Error('Invalid manufacturing base64 length/encoding');
  const bytes = Buffer.from(payload.data, 'base64');
  if (bytes.length !== payload.size || bytes.toString('base64') !== payload.data) throw Error('Manufacturing transfer size/canonical encoding mismatch');
  if (expectArchive && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw Error('Manufacturing ZIP/XLSX signature mismatch');
  if (!expectArchive && bytes.every(value => value === 0)) throw Error('Manufacturing export contains only zero bytes');
  return bytes;
}

export function normalizeExportRequest(request) {
  const kind = request.kind;
  const specs = {
    gerber: { extension: '.zip', format: null, expectArchive: true },
    pickAndPlace: { extension: request.format === 'csv' ? '.csv' : '.xlsx', format: request.format ?? 'xlsx', expectArchive: (request.format ?? 'xlsx') === 'xlsx' },
    bom: { extension: request.format === 'csv' ? '.csv' : '.xlsx', format: request.format ?? 'xlsx', expectArchive: (request.format ?? 'xlsx') === 'xlsx' },
    testPoints: { extension: request.format === 'csv' ? '.csv' : '.xlsx', format: request.format ?? 'xlsx', expectArchive: (request.format ?? 'xlsx') === 'xlsx' },
    netlist: { extension: '.net', format: null, expectArchive: false },
    ipcD356A: { extension: '.ipc', format: null, expectArchive: false },
  };
  const spec = specs[kind];
  if (!spec) throw Error('Unsupported manufacturing export kind');
  if (!['pickAndPlace', 'bom', 'testPoints'].includes(kind) && request.format !== undefined) throw Error(`format is not valid for ${kind}`);
  if (['pickAndPlace', 'bom', 'testPoints'].includes(kind) && request.format !== undefined && !['xlsx', 'csv'].includes(request.format)) throw Error('format must be xlsx or csv');
  if (kind !== 'pickAndPlace' && request.unit !== undefined) throw Error(`unit is not valid for ${kind}`);
  const unit = kind === 'pickAndPlace' ? (request.unit ?? 'mil') : null;
  if (unit !== null && !['mm', 'mil'].includes(unit)) throw Error('Pick-and-place unit must be mm or mil');
  if (kind !== 'netlist' && request.netlistType !== undefined) throw Error(`netlistType is not valid for ${kind}`);
  const netlistMap = {
    JLCEDA_PRO: 'JLCEDA',
    EASYEDA_PRO: 'EasyEDA',
    PADS: 'PADS',
    ALTIUM_DESIGNER: 'Protel2',
    ALLEGRO: 'Allegro',
  };
  const netlistType = kind === 'netlist' ? netlistMap[request.netlistType ?? 'JLCEDA_PRO'] : null;
  if (kind === 'netlist' && !netlistType) throw Error('Unsupported netlistType');
  return { ...spec, unit, netlistType };
}

export async function exportManufacturingFile(request) {
  assertAllowedTarget(request.target);
  if (!request.target?.documentUuid || !request.target?.projectUuid || !request.target?.windowId) throw Error('Manufacturing export requires exact project/document/window');
  const spec = normalizeExportRequest(request);
  const maxBytes = request.maxBytes ?? 8388608;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16777216) throw Error('maxBytes must be 1..16777216');
  if (typeof request.outputPath !== 'string' || !path.isAbsolute(request.outputPath) || path.extname(request.outputPath).toLowerCase() !== spec.extension) throw Error(`outputPath must be an absolute ${spec.extension} filename for ${request.kind}`);
  const parent = await fs.lstat(path.dirname(request.outputPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Manufacturing export parent must be an existing regular directory');
  try { await fs.lstat(request.outputPath); throw Error('Manufacturing export destination already exists; overwrite is not supported'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bridge = await resolveBridge({ bridgeUrl: request.bridgeUrl, windowId: request.target.windowId, requireEda: true });
  const runtimeRequest = {
    target: request.target,
    kind: request.kind,
    fileName: path.basename(request.outputPath, spec.extension),
    format: spec.format,
    unit: spec.unit,
    netlistType: spec.netlistType,
    expectArchive: spec.expectArchive,
    maxBytes,
  };
  const payload = await executeBridgeCode(bridge, `return await (${manufacturingFileRuntime.toString()})(eda,${JSON.stringify(runtimeRequest)});`, 240_000);
  const bytes = decodeManufacturingFile(payload, maxBytes, spec.expectArchive);
  let created = false;
  try {
    const handle = await fs.open(request.outputPath, 'wx');
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    const persisted = await fs.readFile(request.outputPath);
    if (!persisted.equals(bytes)) throw Error('Manufacturing export disk readback mismatch');
  } catch (error) {
    if (created) await fs.rm(request.outputPath, { force: true }).catch(() => {});
    throw error;
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    ok: true,
    bridge: { baseUrl: bridge.baseUrl, windowId: bridge.windowId },
    path: request.outputPath,
    size: bytes.length,
    sha256,
    kind: request.kind,
    format: spec.format,
    unit: spec.unit,
    netlistType: request.kind === 'netlist' ? (request.netlistType ?? 'JLCEDA_PRO') : null,
    sourceFileName: payload.name ?? null,
    mimeType: payload.mimeType ?? null,
    verifiedTransfer: true,
    overwritten: false,
    pcbModified: false,
    limitations: [
      'File generation and byte transfer are verified; the exported data still requires the appropriate manufacturing or assembly review.',
      'The tool does not place an order, upload a file, open a dialog, change layer visibility, or save/modify the PCB document.',
    ],
  };
}

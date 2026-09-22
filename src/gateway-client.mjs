import { normalizeDocumentSource } from './source-fingerprint.mjs';
import { createPortableSha256 } from './portable-sha256.mjs';
import crypto from 'node:crypto';
import { assertAllowedTarget, executeBridgeCode, fetchJson, resolveBridge } from './bridge.mjs';

export function gatewayError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code; error.details = details;
  return error;
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}
export const hashObject = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const hashBytes = value => crypto.createHash('sha256').update(value).digest('hex');

export async function connectGateway({ target, bridgeUrl, requireV2 = false }) {
  assertAllowedTarget(target);
  for (const field of ['windowId', 'projectUuid', 'documentUuid']) {
    if (typeof target?.[field] !== 'string' || !target[field].trim()) throw gatewayError('INVALID_REQUEST', `Exact target.${field} is required`);
  }
  const bridge = await resolveBridge({ bridgeUrl, windowId: target.windowId });
  const listing = await fetchJson(`${bridge.baseUrl}/eda-windows`, {}, 5000);
  const window = listing.windows?.find(item => item.windowId === target.windowId && item.connected);
  const protocolVersion = bridge.health.protocolVersions?.includes(2) && window?.protocolVersions?.includes(2) ? 2 : 1;
  if (requireV2 && protocolVersion !== 2) throw gatewayError('CLIENT_UNSUPPORTED', 'This operation requires a connected Protocol v2 Gateway', { protocolVersion, bridgeVersion: bridge.health.bridgeVersion ?? null, gatewayVersion: window?.gatewayVersion ?? null });
  let exactTarget = { ...target };
  async function rpc(operation, args = {}, { expected, windowOnly = false } = {}) {
    if (protocolVersion !== 2) throw gatewayError('CLIENT_UNSUPPORTED', 'Typed operation is unavailable on the legacy Gateway');
    const response = await fetchJson(`${bridge.baseUrl}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), operation, target: exactTarget, arguments: args, ...(expected === undefined ? {} : { expected }) }) }, 180000);
    if (!response.success || response.windowId !== exactTarget.windowId || response.operation !== operation) throw gatewayError('TARGET_CHANGED', 'Gateway result identity or operation mismatch', { operation });
    if (response.bridgeGenerationId !== bridge.health.bridgeGenerationId) throw gatewayError('GENERATION_MISMATCH', 'Bridge restarted while the client session was active');
    if (!windowOnly && response.state?.documentUuid !== exactTarget.documentUuid) throw gatewayError('TARGET_CHANGED', 'Gateway result document mismatch');
    return response;
  }
  if (protocolVersion === 2) {
    const identity = await rpc('target.inspect', {}, { windowOnly: true });
    for (const field of ['windowId', 'projectUuid', 'documentUuid']) if (identity.result?.[field] !== exactTarget[field]) throw gatewayError('TARGET_CHANGED', `Gateway ${field} mismatch`);
    if (!identity.result.tabId || (exactTarget.tabId && identity.result.tabId !== exactTarget.tabId)) throw gatewayError('TARGET_CHANGED', 'PCB tab identity mismatch');
    exactTarget = { ...exactTarget, tabId: identity.result.tabId };
  }
  return { bridge, target: exactTarget, protocolVersion, gatewayVersion: window?.gatewayVersion ?? null, rpc };
}

export function decodeUtf8Envelope(payload, maximumBytes) {
  if (payload?.encoding !== 'utf8' || typeof payload.text !== 'string' || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 0 || payload.byteLength > maximumBytes || !/^[0-9a-f]{64}$/.test(payload.sha256 ?? '')) throw gatewayError('TRANSFER_HASH_MISMATCH', 'Invalid bounded UTF-8 file envelope');
  const bytes = Buffer.from(payload.text, 'utf8');
  if (bytes.length !== payload.byteLength || hashBytes(bytes) !== payload.sha256) throw gatewayError('TRANSFER_HASH_MISMATCH', 'UTF-8 file length or hash mismatch');
  return bytes;
}

/** Compatibility path for already verified public native text exports; never browser fallback. */
export async function nativeTextRuntime(eda, request, digestBytes, normalizeSource) {
  const guard = async () => {
    const d = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const p = await eda.dmt_Project.getCurrentProjectInfo();
    if (d?.documentType !== 3 || d?.uuid !== request.target.documentUuid || p?.uuid !== request.target.projectUuid || (request.target.tabId && request.target.tabId !== d.tabId)) throw Error('Native text export target changed');
    return d;
  };
  const sha = async bytes => [...new Uint8Array(digestBytes(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  const sourceHash = async () => {
    const value = await eda.sys_FileManager.getDocumentSource();
    if (typeof value !== 'string') throw Error('Document source unavailable');
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > 33554432) throw Error('Source exceeds byte limit');
    return sha(new TextEncoder().encode(normalizeSource(value).canonicalText));
  };
  const doc = await guard();
  const before = await sourceHash();
  const method = request.kind === 'dsn' ? 'getDsnFile' : request.kind === 'boardInfo' ? 'getPcbInfoFile' : null;
  if (!method || typeof eda.pcb_ManufactureData?.[method] !== 'function') throw Error('Native export method unavailable');
  const file = await eda.pcb_ManufactureData[method]('PCB_Inspection');
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > request.maximumBytes) throw Error('Invalid or oversized native File');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw Error('Native File length changed');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if ((await sourceHash()) !== before) throw Error('PCB source changed during native export');
  await guard();
  return { encoding: 'utf8', text, byteLength: bytes.length, sha256: await sha(bytes), fileName: file.name, tabId: doc.tabId, sourceHash: before };
}

export async function readNativeText({ target, bridgeUrl, kind }) {
  if (!['dsn', 'boardInfo'].includes(kind)) throw gatewayError('INVALID_REQUEST', 'Unknown native text export kind');
  const maximumBytes = kind === 'dsn' ? 12582912 : 1048576;
  const session = await connectGateway({ target, bridgeUrl });
  const envelope = session.protocolVersion === 2
    ? (await session.rpc(kind === 'dsn' ? 'pcb.exportDsn' : 'pcb.nativeBoardInfo')).result
    : await executeBridgeCode(session.bridge, `return await (${nativeTextRuntime.toString()})(eda,${JSON.stringify({ target: session.target, kind, maximumBytes })},(${createPortableSha256.toString()})(),${normalizeDocumentSource.toString()});`, 180000);
  const bytes = decodeUtf8Envelope(envelope, maximumBytes);
  return { bytes, text: bytes.toString('utf8'), sha256: envelope.sha256, target: { ...session.target, tabId: envelope.tabId ?? session.target.tabId }, transport: session.protocolVersion === 2 ? 'typed-v2' : 'verified-public-api-v1-compatibility', protocolVersion: session.protocolVersion };
}

export async function prepareGatewayState(session) {
  if (session.protocolVersion !== 2) throw gatewayError('CLIENT_UNSUPPORTED', 'Generation-bound plans require Protocol v2');
  const first = await session.rpc('events.getState');
  const expected = { generationId: first.result.generationId, changeEpoch: first.result.changeEpoch, bridgeGenerationId: session.bridge.health.bridgeGenerationId };
  const source = await session.rpc('document.sourceHash', {}, { expected });
  await session.rpc('events.getState', {}, { expected });
  return { ...expected, sourceHash: source.result.sha256, eventCoverage: first.result.eventCoverage ?? 'unavailable' };
}

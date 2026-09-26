import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertAllowedTarget, executeBridgeCode, resolveBridge } from './bridge.mjs';
import { decodeBackup } from './backup.mjs';

// Serialized into the EasyEDA extension context. It never changes the viewport.
// Optional layer isolation is reverted and verified before a successful response.
export async function inspectionViewRuntime(eda, request) {
  if (!request?.target?.documentUuid || !request?.target?.projectUuid) throw Error('Inspection capture requires exact project/document');
  if (!Number.isInteger(request.maxBytes) || request.maxBytes < 8 || request.maxBytes > 16777216) throw Error('Invalid inspection capture size limit');
  const state = (object, key) => {
    if (object == null) return undefined;
    const getter = object[`getState_${key[0].toUpperCase()}${key.slice(1)}`];
    return typeof getter === 'function' ? getter.call(object) : object[key];
  };
  const guard = async () => {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    if (document?.uuid !== request.target.documentUuid || document?.documentType !== 3) throw Error('PCB document/type changed during inspection capture');
    if (project?.uuid !== request.target.projectUuid) throw Error('PCB project changed during inspection capture');
    if (!document.tabId) throw Error('Exact PCB tabId unavailable');
    return document;
  };
  const layerRows = async () => {
    if (typeof eda.pcb_Layer?.getAllLayers !== 'function') throw Error('Layer readback API unavailable');
    const rows = await eda.pcb_Layer.getAllLayers();
    if (!Array.isArray(rows)) throw Error('Invalid layer readback');
    return rows.map(row => ({
      id: state(row, 'id'),
      name: state(row, 'name') ?? null,
      layerStatus: state(row, 'layerStatus'),
      locked: state(row, 'locked') ?? null,
    })).filter(row => Number.isInteger(row.id)).sort((a, b) => a.id - b.id);
  };
  const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item);
  const isVisible = value => value === 1 || value === 'SHOW' || value === 'VISIBLE';
  const isHidden = value => value === 2 || value === 'HIDDEN' || value === 'HIDE';

  const document = await guard();
  if (typeof eda.dmt_EditorControl?.getCurrentRenderedAreaImage !== 'function') throw Error('Exact-tab rendered-image API unavailable');
  const initialLayers = await layerRows();
  const initialCurrentLayer = typeof eda.pcb_Layer?.getCurrentLayer === 'function' ? await eda.pcb_Layer.getCurrentLayer() : null;
  const initialCurrentLayerId = Number.isInteger(state(initialCurrentLayer, 'id')) ? state(initialCurrentLayer, 'id') : null;
  const knownLayerIds = new Set(initialLayers.map(row => row.id));
  const enabledLayerIds = new Set(initialLayers.filter(row => isVisible(row.layerStatus) || isHidden(row.layerStatus)).map(row => row.id));
  if (request.visibleLayerIds) {
    if (!Array.isArray(request.visibleLayerIds) || !request.visibleLayerIds.length || new Set(request.visibleLayerIds).size !== request.visibleLayerIds.length || request.visibleLayerIds.some(id => !Number.isInteger(id) || !knownLayerIds.has(id))) throw Error('visibleLayerIds must contain unique existing layer IDs');
    const disabled = request.visibleLayerIds.filter(id => !enabledLayerIds.has(id));
    if (disabled.length) throw Error(`Cannot isolate disabled/unavailable layers: ${disabled.join(',')}`);
    if (typeof eda.pcb_Layer?.setLayerVisible !== 'function' || typeof eda.pcb_Layer?.setLayerInvisible !== 'function') throw Error('Layer visibility APIs unavailable');
  }

  let payload = null;
  let operationError = null;
  const restorationErrors = [];
  try {
    await guard();
    if (request.visibleLayerIds) {
      const changed = await eda.pcb_Layer.setLayerVisible(request.visibleLayerIds, true);
      if (changed !== true) throw Error('Layer isolation returned false');
      const isolated = await layerRows();
      const requested = new Set(request.visibleLayerIds);
      const missingVisible = isolated.filter(row => requested.has(row.id) && !isVisible(row.layerStatus)).map(row => row.id);
      const unexpectedVisible = isolated.filter(row => !requested.has(row.id) && isVisible(row.layerStatus)).map(row => row.id);
      const changedDisabled = isolated.filter(row => !enabledLayerIds.has(row.id) && row.layerStatus !== initialLayers.find(item => item.id === row.id)?.layerStatus).map(row => row.id);
      if (missingVisible.length || unexpectedVisible.length || changedDisabled.length) throw Error(`Layer isolation readback mismatch; missing=${missingVisible.join(',')}; unexpected=${unexpectedVisible.join(',')}; disabledChanged=${changedDisabled.join(',')}`);
    }
    if (request.settleMs > 0) await new Promise(resolve => setTimeout(resolve, request.settleMs));
    await guard();
    const capturedLayers = await layerRows();
    const file = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(document.tabId);
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isInteger(file.size) || file.size < 8) throw Error('Rendered inspection capture returned no readable Blob');
    if (file.size > request.maxBytes) throw Error('Inspection capture exceeds maxBytes; no bytes transferred');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== file.size) throw Error('Inspection PNG size/readback mismatch');
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (signature.some((value, index) => bytes[index] !== value)) throw Error('Inspection capture PNG signature mismatch');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const parts = [];
    let chunk = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const a = bytes[index], b = bytes[index + 1] ?? 0, c = bytes[index + 2] ?? 0;
      chunk += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)] + (index + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=') + (index + 2 < bytes.length ? alphabet[c & 63] : '=');
      if (chunk.length >= 32768) { parts.push(chunk); chunk = ''; }
    }
    if (chunk) parts.push(chunk);
    payload = { encoding: 'base64', data: parts.join(''), size: bytes.length, name: file.name ?? null, capturedLayers };
  } catch (error) {
    operationError = error;
  }

  if (request.visibleLayerIds) {
    try {
      await guard();
      const originalVisible = initialLayers.filter(row => isVisible(row.layerStatus)).map(row => row.id);
      const originalHidden = initialLayers.filter(row => isHidden(row.layerStatus)).map(row => row.id);
      if (originalVisible.length && await eda.pcb_Layer.setLayerVisible(originalVisible, false) !== true) throw Error('Restoring visible layers returned false');
      if (originalHidden.length && await eda.pcb_Layer.setLayerInvisible(originalHidden, false) !== true) throw Error('Restoring hidden layers returned false');
      if (initialCurrentLayerId !== null && typeof eda.pcb_Layer.selectLayer === 'function') {
        const current = typeof eda.pcb_Layer.getCurrentLayer === 'function' ? await eda.pcb_Layer.getCurrentLayer() : null;
        if (state(current, 'id') !== initialCurrentLayerId && await eda.pcb_Layer.selectLayer(initialCurrentLayerId) !== true) throw Error('Restoring current layer returned false');
      }
    } catch (error) {
      restorationErrors.push(String(error?.message ?? error));
    }
  }

  let finalLayers = null;
  try {
    await guard();
    finalLayers = await layerRows();
    if (stable(finalLayers) !== stable(initialLayers)) restorationErrors.push('final layer state differs from initial state');
  } catch (error) {
    restorationErrors.push(`verification: ${String(error?.message ?? error)}`);
  }
  if (restorationErrors.length) throw Error(`${operationError ? `Inspection capture failed: ${String(operationError?.message ?? operationError)}; ` : ''}layer restoration failed: ${restorationErrors.join(' | ')}`);
  if (operationError) throw operationError;
  return {
    ...payload,
    initialLayers,
    finalLayers,
    restorationVerified: true,
    temporaryLayerMutation: Boolean(request.visibleLayerIds),
    viewportUnchanged: true,
    tabId: document.tabId,
  };
}

export async function captureInspectionView(request) {
  assertAllowedTarget(request.target);
  if (!request.target?.documentUuid || !request.target?.projectUuid || !request.target?.windowId) throw Error('Inspection capture requires exact project/document/window');
  const maxBytes = request.maxBytes ?? 8388608;
  if (!Number.isInteger(maxBytes) || maxBytes < 8 || maxBytes > 16777216) throw Error('maxBytes must be 8..16777216');
  if (typeof request.outputPath !== 'string' || !path.isAbsolute(request.outputPath) || path.extname(request.outputPath).toLowerCase() !== '.png') throw Error('outputPath must be an absolute .png filename');
  const parent = await fs.lstat(path.dirname(request.outputPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Inspection capture parent must be an existing regular directory');
  try { await fs.lstat(request.outputPath); throw Error('Inspection capture destination already exists; overwrite is not supported'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const visibleLayerIds = request.visibleLayerIds === undefined ? null : request.visibleLayerIds;
  const settleMs = request.settleMs ?? 150;
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 2000) throw Error('settleMs must be 0..2000');
  const bridge = await resolveBridge({ windowId: request.target.windowId, requireEda: true });
  const runtimeRequest = { target: request.target, visibleLayerIds, settleMs, maxBytes };
  const payload = await executeBridgeCode(bridge, `return await (${inspectionViewRuntime.toString()})(eda,${JSON.stringify(runtimeRequest)});`, 180_000);
  const bytes = decodeBackup(payload, maxBytes, 'png');
  let created = false;
  try {
    const handle = await fs.open(request.outputPath, 'wx');
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    const persisted = await fs.readFile(request.outputPath);
    if (!persisted.equals(bytes)) throw Error('Inspection capture disk readback mismatch');
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
    capturedVisibleLayerIds: payload.capturedLayers.filter(row => row.layerStatus === 1 || row.layerStatus === 'SHOW' || row.layerStatus === 'VISIBLE').map(row => row.id),
    restorationVerified: payload.restorationVerified,
    temporaryLayerMutation: payload.temporaryLayerMutation,
    viewportUnchanged: payload.viewportUnchanged,
    tabId: payload.tabId,
    verifiedTransfer: true,
    overwritten: false,
    pcbModified: false,
    limitations: [
      'This captures the existing 2D viewport. It does not pan, zoom, fit, activate a tab, or provide 3D/manufacturing preview.',
      'Optional layer isolation is limited to currently enabled layers; success requires exact API-visible layer-state restoration.',
    ],
  };
}

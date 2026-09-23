import fs from 'node:fs/promises';
import path from 'node:path';
import { exportNativeBackup } from './backup.mjs';
import { exportManufacturingFile } from './manufacturing.mjs';
import { gatewayError, hashBytes, readNativeText } from './gateway-client.mjs';
import { parseDsnScene } from './dsn.mjs';

const MANUFACTURING = { gerber: 'gerber', bom: 'bom', pick_place: 'pickAndPlace', test_point: 'testPoints', netlist: 'netlist', ipc_d_356a: 'ipcD356A' };
export async function assertNewLocalPath(outputPath) {
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || /^\\\\/.test(outputPath) || outputPath.includes('\0')) throw gatewayError('INVALID_REQUEST', 'Export requires an absolute local filesystem path');
  const absolute = path.resolve(outputPath);
  const basename = path.basename(absolute);
  if (!basename || /[<>:"|?*]/.test(basename) || /[. ]$/.test(basename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)) throw gatewayError('INVALID_REQUEST', 'Unsafe or reserved export filename');
  let current = path.dirname(absolute);
  while (true) {
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw gatewayError('INVALID_REQUEST', 'Export parent must be an existing non-symlink directory');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  try { await fs.lstat(absolute); throw gatewayError('OUTPUT_EXISTS', 'Export refuses to overwrite an existing file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return absolute;
}

/** Final name appears atomically through a same-volume exclusive hard link. */
export async function createAtomicExport(outputPath, producer, { maximumBytes = 16777216 } = {}) {
  const absolute = await assertNewLocalPath(outputPath);
  const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(absolute), '.pcb-export-'));
  const temporary = path.join(temporaryDirectory, path.basename(absolute));
  let linked = false;
  try {
    const detail = await producer(temporary);
    const stat = await fs.lstat(temporary);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) throw gatewayError('FILE_TOO_LARGE', 'Invalid export file size or type');
    const bytes = await fs.readFile(temporary);
    if (bytes.length !== stat.size) throw gatewayError('TRANSFER_HASH_MISMATCH', 'Temporary file changed during readback');
    const handle = await fs.open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.link(temporary, absolute);
    linked = true;
    const readback = await fs.readFile(absolute);
    if (!bytes.equals(readback)) throw gatewayError('TRANSFER_HASH_MISMATCH', 'Final export readback differs');
    return { ...detail, outputPath: absolute, byteLength: bytes.length, sha256: hashBytes(bytes), atomicFinalization: true, documentWritten: false };
  } catch (error) {
    if (linked) {
      const a = await fs.lstat(absolute).catch(() => null), b = await fs.lstat(temporary).catch(() => null);
      if (a && b && a.ino === b.ino && a.dev === b.dev) await fs.unlink(absolute).catch(() => {});
    }
    if (error.code === 'EEXIST') throw gatewayError('OUTPUT_EXISTS', 'Another process created the destination; existing file was preserved');
    throw error;
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(temporaryDirectory).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
}

export async function exportPcb(request) {
  const { target, kind, outputPath, bridgeUrl, maxBytes = 8388608, scope = 'project', parseScene = true, format, unit, netlistType } = request;
  const effectiveUnit = kind === 'pick_place' ? (unit ?? 'mil') : unit;
  if (!['backup', 'dsn', ...Object.keys(MANUFACTURING)].includes(kind)) throw gatewayError('INVALID_REQUEST', 'Unknown export kind');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 16777216) throw gatewayError('INVALID_REQUEST', 'Export byte limit must be 4..16777216');
  if (kind === 'backup' && path.extname(outputPath).toLowerCase() !== '.epro') throw gatewayError('INVALID_REQUEST', 'Native backup requires .epro');
  if (kind === 'dsn' && path.extname(outputPath).toLowerCase() !== '.dsn') throw gatewayError('INVALID_REQUEST', 'DSN export requires .dsn');
  return createAtomicExport(outputPath, async temporary => {
    if (kind === 'backup') {
      await exportNativeBackup({ target, outputPath: temporary, scope, maxBytes, bridgeUrl });
      return { ok: true, kind, scope, target };
    }
    if (kind === 'dsn') {
      const file = await readNativeText({ target, bridgeUrl, kind: 'dsn' });
      if (file.bytes.length > maxBytes) throw gatewayError('FILE_TOO_LARGE', 'DSN exceeds the requested output limit');
      if (!/^\uFEFF?\s*\(\s*PCB\b/i.test(file.text)) throw gatewayError('METHOD_FAILED', 'Native File lacks a PCB DSN header');
      const scene = parseScene ? parseDsnScene(file.text) : null;
      await fs.writeFile(temporary, file.bytes, { flag: 'wx' });
      return { ok: true, kind, target: file.target, transport: file.transport, scene: scene ? { ...scene.summary, units: scene.units, sourceUnits: scene.sourceUnits, resolution: scene.resolution, coordinateFrame: scene.coordinateFrame, apiCoordinateTransform: null, coverage: { ...scene.coverage, warnings: scene.coverage.warnings.slice(0, 20) } } : null };
    }
    await exportManufacturingFile({ target, kind: MANUFACTURING[kind], outputPath: temporary, format, unit: effectiveUnit, netlistType, maxBytes, bridgeUrl });
    return { ok: true, kind, target, format: format ?? null, unit: effectiveUnit ?? null, netlistType: netlistType ?? null };
  }, { maximumBytes: maxBytes });
}

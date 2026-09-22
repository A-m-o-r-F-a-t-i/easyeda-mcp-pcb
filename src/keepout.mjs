import { connectGateway, gatewayError, hashObject, prepareGatewayState } from './gateway-client.mjs';
import { contextRpc, contextVerifiedPublicWrite, executionContextFor, runGuardedNative } from './execution-context.mjs';
import { executeBridgeCode } from './bridge.mjs';
import { exportNativeBackup } from './backup.mjs';
import { createPortableSha256 } from './portable-sha256.mjs';
import { normalizeDocumentSource } from './source-fingerprint.mjs';

/** Shared with the client runtime. Only REGION records can be created/deleted. */
export function createKeepoutModel() {
  const allowed = ['COMPONENT', 'VIA', 'TRACK', 'FILL', 'COPPER', 'PLANE'];
  const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const exactKeys = (value, keys, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error('Invalid fields: ' + label);
  };
  function validate(plan) {
    exactKeys(plan, ['schema', 'intent', 'target', 'units', 'backupPath', 'operations'], 'keepout plan');
    if (plan.schema !== 'easyeda-pcb-keepout-plan/v1' || plan.units !== 'mm' || typeof plan.intent !== 'string' || !plan.intent.trim()) throw Error('Explicit keepout schema, mm and intent required');
    exactKeys(plan.target, ['documentUuid', 'projectUuid', 'windowId', 'tabId'], 'target');
    for (const key of ['documentUuid', 'projectUuid', 'windowId']) if (typeof plan.target[key] !== 'string' || !plan.target[key]) throw Error('Exact target required: ' + key);
    if (typeof plan.backupPath !== 'string' || !/\.epro$/i.test(plan.backupPath)) throw Error('A new native .epro backupPath is required');
    if (!Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 24) throw Error('Keepout plan requires 1..24 operations');
    const ids = new Set(), names = new Set();
    for (const op of plan.operations) {
      exactKeys(op, ['type', 'primitiveId', 'name', 'center', 'diameter', 'layer', 'prohibitions', 'expected'], 'region operation');
      if (!/^[0-9a-f]{16}$/.test(op.primitiveId || '') || ids.has(op.primitiveId)) throw Error('Unique 16-hex region ID required');
      ids.add(op.primitiveId);
      if (op.type === 'region.delete') {
        if (!op.expected || typeof op.expected !== 'object' || Array.isArray(op.expected)) throw Error('Region deletion requires full expected native record');
        for (const key of ['name', 'center', 'diameter', 'layer', 'prohibitions']) if (op[key] !== undefined) throw Error('Create-only field on delete: ' + key);
      } else if (op.type === 'region.circle.create') {
        if (op.expected !== null) throw Error('Create requires expected:null');
        if (!Array.isArray(op.center) || op.center.length !== 2 || op.center.some(n => !Number.isFinite(n) || Math.abs(n) > 10000)) throw Error('Invalid circle center');
        if (!Number.isFinite(op.diameter) || op.diameter <= 0 || op.diameter > 1000) throw Error('Invalid circle diameter');
        if (![1, 2, 12, ...Array.from({ length: 30 }, (_, i) => 15 + i)].includes(op.layer)) throw Error('Invalid region layer');
        if (typeof op.name !== 'string' || !op.name.trim() || op.name.length > 96 || names.has(op.name)) throw Error('Unique region name required');
        names.add(op.name);
        if (!Array.isArray(op.prohibitions) || !op.prohibitions.length || new Set(op.prohibitions).size !== op.prohibitions.length || op.prohibitions.some(p => !allowed.includes(p))) throw Error('Invalid native prohibitions');
      } else throw Error('Unsupported keepout operation');
    }
    return { operationCount: plan.operations.length, createCount: plan.operations.filter(o => o.type === 'region.circle.create').length, deleteCount: plan.operations.filter(o => o.type === 'region.delete').length };
  }
  function parse(source) {
    if (typeof source !== 'string') throw Error('Native source unavailable');
    const records = [];
    for (const line of source.split('\n')) {
      if (!line.trim()) continue;
      const p = line.indexOf('||');
      if (p < 0) throw Error('Unsupported native source record');
      const end = line.trimEnd();
      const body = end.endsWith('|') ? end.slice(p + 2, -1) : end.slice(p + 2);
      records.push({ header: JSON.parse(line.slice(0, p)), body: JSON.parse(body), line });
    }
    if (records[0]?.header.type !== 'DOCHEAD' || records[0]?.body.docType !== 'PCB') throw Error('PCB DOCHEAD required');
    return records;
  }
  function circleRecord(op) {
    const n = 96;
    // Circumscribe the requested disk; 2um margin covers 0.0001mil source rounding.
    const r = (op.diameter / 2 + 0.002) / 0.0254 / Math.cos(Math.PI / n);
    const x = op.center[0] / 0.0254, y = op.center[1] / 0.0254;
    const points = Array.from({ length: n }, (_, i) => {
      const a = (2 * i + 1) * Math.PI / n;
      return [Number((x + r * Math.cos(a)).toFixed(4)), Number((y + r * Math.sin(a)).toFixed(4))];
    });
    return { partitionId: '', groupId: '0', layerId: op.layer, width: 0.2, prohibitType: [...op.prohibitions], path: [[...points[0], 'L', ...points.slice(1).flat(), ...points[0]]], locked: true, zIndex: null, name: op.name, regionType: 'PROHIBIT' };
  }
  function patch(source, plan) {
    validate(plan);
    const records = parse(source);
    if (records[0].body.uuid !== plan.target.documentUuid) throw Error('Native source UUID mismatch');
    let ticket = records.reduce((n, r) => Math.max(n, Number.isSafeInteger(r.header.ticket) ? r.header.ticket : 0), 0);
    const removed = new Set(), added = [];
    for (const op of plan.operations) {
      const matches = records.filter(r => r.header.id === op.primitiveId);
      if (op.type === 'region.delete') {
        if (matches.length !== 1 || matches[0].header.type !== 'REGION' || canonical(matches[0].body) !== canonical(op.expected)) throw Error('Region delete old-state mismatch: ' + op.primitiveId);
        removed.add(op.primitiveId);
      } else {
        if (matches.length) throw Error('Create ID already exists: ' + op.primitiveId);
        if (records.some(r => r.header.type === 'REGION' && r.body.name === op.name)) throw Error('Region name already exists; read before replay');
        added.push({ header: { type: 'REGION', ticket: ++ticket, id: op.primitiveId }, body: circleRecord(op) });
      }
    }
    const lines = records.filter(r => !removed.has(r.header.id)).map(r => r.line.replace(/\r$/, '').replace(/\|$/, ''));
    lines.push(...added.map(r => JSON.stringify(r.header) + '||' + JSON.stringify(r.body)));
    // Native 4.x splits records with |; the original final record has no delimiter.
    // Appending after an undelimited original tail produces a client format error.
    return { source: lines.join('|\n'), added, removedIds: [...removed] };
  }
  function nonTargetRecords(records, affected, normalizeAngles = false) {
    return records.filter(r => r.header.type !== 'DOCHEAD' && !affected.has(r.header.id)).map(r => {
      const body = normalizeAngles && r.header.type === 'COMPONENT' && Number.isFinite(r.body.angle)
        ? { ...r.body, angle: ((r.body.angle % 360) + 360) % 360 } : r.body;
      return { header: Object.fromEntries(Object.entries(r.header).filter(([k]) => k !== 'ticket')), body };
    }).map(canonical).sort();
  }
  function verify(beforeSource, afterSource, plan) {
    const before = parse(beforeSource), after = parse(afterSource), affected = new Set(plan.operations.map(o => o.primitiveId));
    if (before[0].body.uuid !== after[0].body.uuid || after[0].body.uuid !== plan.target.documentUuid) throw Error('Source identity changed');
    const head = h => /^[0-9a-f]{16}$/i.test(h.client ?? '') && Number.isSafeInteger(h.updateTime) && h.version === String(h.updateTime) ? Object.fromEntries(Object.entries(h).filter(([k]) => !['client', 'updateTime', 'version'].includes(k))) : h;
    if (canonical(head(before[0].body)) !== canonical(head(after[0].body))) throw Error('Unexpected DOCHEAD change');
    const rawUnchanged = canonical(nonTargetRecords(before, affected)) === canonical(nonTargetRecords(after, affected));
    if (!rawUnchanged && canonical(nonTargetRecords(before, affected, true)) !== canonical(nonTargetRecords(after, affected, true))) {
      const prior = new Map(before.map(r => [r.header.type+':'+r.header.id,r]));
      const changed = after.filter(r => r.header.type !== 'DOCHEAD' && !affected.has(r.header.id) && canonical(r.body)!==canonical(prior.get(r.header.type+':'+r.header.id)?.body));
      const details=changed.slice(0,6).map(r=>({type:r.header.type,id:r.header.id,fields:[...new Set([...Object.keys(r.body),...Object.keys(prior.get(r.header.type+':'+r.header.id)?.body||{})])].filter(k=>canonical(r.body[k])!==canonical(prior.get(r.header.type+':'+r.header.id)?.body?.[k]))}));
      throw Error('Non-target native records changed; do not restore or replay blindly: '+canonical(details));
    }
    const previousComponents = new Map(before.filter(r=>r.header.type==='COMPONENT').map(r=>[r.header.id,r.body]));
    const normalizedAngles = after.filter(r=>r.header.type==='COMPONENT' && previousComponents.has(r.header.id) && r.body.angle!==previousComponents.get(r.header.id).angle).map(r=>({primitiveId:r.header.id,before:previousComponents.get(r.header.id).angle,after:r.body.angle}));
    const results = [];
    for (const op of plan.operations) {
      const found = after.filter(r => r.header.id === op.primitiveId);
      if (op.type === 'region.delete') {
        if (found.length) throw Error('Region delete not applied');
      } else {
        if (found.length !== 1 || found[0].header.type !== 'REGION') throw Error('Created region missing/ambiguous');
        const value = found[0].body, goal = circleRecord(op);
        if (value.layerId !== op.layer || value.locked !== true || value.regionType !== 'PROHIBIT' || canonical([...(value.prohibitType || [])].sort()) !== canonical([...op.prohibitions].sort())) throw Error('Native keepout flags/layer/lock mismatch');
        const points = p => { if (!Array.isArray(p) || p.length !== 1 || p[0][2] !== 'L') throw Error('Unsupported keepout readback polygon'); const a = [...p[0].slice(0, 2), ...p[0].slice(3)]; const xy = []; for (let i = 0; i < a.length - 2; i += 2) xy.push([a[i], a[i + 1]]); return xy; };
        const actual = points(value.path), wanted = points(goal.path);
        const close = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.002;
        const equivalent = actual.length === wanted.length && actual.some((p, offset) => close(p, wanted[0]) && [1, -1].some(direction => wanted.every((q, i) => close(q, actual[(offset + direction * i + actual.length) % actual.length]))));
        if (!equivalent) throw Error('Keepout polygon changed');
      }
      results.push({ primitiveId: op.primitiveId, type: op.type, verified: true, ...(op.prohibitions ? { prohibitions: op.prohibitions, layer: op.layer } : {}) });
    }
    return { results, nonTargetRecordCount: nonTargetRecords(before, affected).length, nonTargetRecordsUnchanged: rawUnchanged, nonTargetGeometryEquivalent: true, normalizedAngles };
  }
  return { validate, parse, circleRecord, patch, verify };
}

export async function keepoutRuntime(eda, request, sha256, normalizeSource, modelFactory) {
  const model = modelFactory();
  const digest = source => [...sha256(new TextEncoder().encode(normalizeSource(source).canonicalText))].map(v => v.toString(16).padStart(2, '0')).join('');
  const guard = async () => {
    const d = await eda.dmt_SelectControl.getCurrentDocumentInfo(), p = await eda.dmt_Project.getCurrentProjectInfo();
    if (d?.uuid !== request.target.documentUuid || d?.documentType !== 3 || p?.uuid !== request.target.projectUuid || d?.tabId !== request.target.tabId) throw Error('Keepout target changed');
  };
  await guard();
  const version = await eda.sys_Environment?.getEditorCurrentVersion?.();
  if (version !== '4.1.60') throw Error('Native keepout adapter requires verified client 4.1.60; got ' + version);
  if (request.plan.operations.some(op => op.prohibitions?.includes('VIA'))) throw Error('Client 4.1.60 drops VIA from native regions; preserve via exclusion with geometry-plan circularKeepouts. No source write performed.');
  const before = await eda.sys_FileManager.getDocumentSource();
  if (typeof before !== 'string' || new TextEncoder().encode(before).length > 33554432 || digest(before) !== request.expectedSourceHash) throw Error('Keepout source is stale/unavailable');
  if (request.readOnly === true) {
    model.validate(request.plan);
    model.parse(before);
    let verification=null;
    try { verification=model.verify(before,before,request.plan); }
    catch(error) {
      if (!/^(Created region missing\/ambiguous|Region delete not applied|Native keepout flags\/layer\/lock mismatch|Keepout polygon changed)$/.test(error.message)) throw error;
    }
    await guard();
    if (digest(await eda.sys_FileManager.getDocumentSource())!==request.expectedSourceHash) throw Error('PCB changed during keepout completion readback');
    return {ok:true,complete:verification!==null,...(verification??{}),wrotePCB:false,clientVersion:version};
  }
  const changed = model.patch(before, request.plan);
  await guard();
  if (digest(await eda.sys_FileManager.getDocumentSource()) !== request.expectedSourceHash) throw Error('PCB changed before keepout write');
  if (await eda.sys_FileManager.setDocumentSource(changed.source) !== true) throw Error('Keepout source write unconfirmed; read actual state');
  await new Promise(resolve => setTimeout(resolve, 200));
  await guard();
  const after = await eda.sys_FileManager.getDocumentSource();
  const verification = model.verify(before, after, request.plan);
  const sourceAfter = { sha256: digest(after) };
  await new Promise(resolve => setTimeout(resolve, 100));
  await guard();
  if (digest(await eda.sys_FileManager.getDocumentSource()) !== sourceAfter.sha256) throw Error('PCB changed after keepout verification');
  return { ok: true, ...verification, sourceBefore: { sha256: request.expectedSourceHash }, sourceAfter, clientVersion: version, nativeTransaction: false, requiresRepour: true, rulesVerifiedFromNativeRecords: true };
}

export async function runKeepoutPlan(loaded, { mode, guard, executionId, bridgeUrl }) {
  const plan = loaded.raw, model = createKeepoutModel(), summary = model.validate(plan), planSha256 = hashObject(plan);
  if (plan.operations.some(op => op.prohibitions?.includes('VIA'))) throw Error('Client 4.1.60 drops VIA from native regions; use five supported native flags and geometry-plan circularKeepouts. No write performed.');
  if (mode === 'validate') return { ok: true, mode, summary, planSha256, wrotePCB: false };
  if (mode === 'prepare') {
    const session = await connectGateway({ target: plan.target, bridgeUrl, requireV2: true });
    const expected = await prepareGatewayState(session);
    return { ok: true, mode, summary, wrotePCB: false, guard: { schema: 'easyeda-pcb-guard/v1', planSha256, target: session.target, expected } };
  }
  if (guard?.schema !== 'easyeda-pcb-guard/v1' || guard.planSha256 !== planSha256 || ['windowId', 'projectUuid', 'documentUuid'].some(k => guard.target?.[k] !== plan.target[k])) throw gatewayError('EPOCH_MISMATCH', 'Keepout plan/target changed since prepare');
  return runGuardedNative({ target: guard.target, expected: guard.expected, executionId, bridgeUrl }, async () => {
    const context=executionContextFor(guard.target);
    const request={target:context.session.target,expectedSourceHash:context.expected.sourceHash,plan,readOnly:true};
    const inspectCode = `return await (${keepoutRuntime.toString()})(eda,${JSON.stringify(request)},(${createPortableSha256.toString()})(),${normalizeDocumentSource.toString()},${createKeepoutModel.toString()});`;
    const existing=await executeBridgeCode(context.session.bridge,inspectCode,180000);
    if (existing.complete===true) {
      const saved=await contextRpc('pcb.save',{}, {write:true});
      return {ok:true,mode,summary,planSha256,...existing,alreadyApplied:true,completedOperationCount:existing.results.length,saved:saved.result?.saved===true,wrotePCB:false,nativeTransaction:false};
    }
    const backup = await exportNativeBackup({ target: guard.target, outputPath: plan.backupPath, scope: 'project', bridgeUrl });
    const applied = await contextVerifiedPublicWrite('pcb.keepoutRecords', async (context, expected) => {
      const request = { target: context.session.target, expectedSourceHash: expected.sourceHash, plan };
      const code = `return await (${keepoutRuntime.toString()})(eda,${JSON.stringify(request)},(${createPortableSha256.toString()})(),${normalizeDocumentSource.toString()},${createKeepoutModel.toString()});`;
      return executeBridgeCode(context.session.bridge, code, 180000);
    });
    const saved = await contextRpc('pcb.save', {}, { write: true });
    return { ok: true, mode, summary, planSha256, backup, ...applied, saved: saved.result?.saved === true, completedOperationCount: applied.results.length, wrotePCB: true, nativeTransaction: false };
  });
}

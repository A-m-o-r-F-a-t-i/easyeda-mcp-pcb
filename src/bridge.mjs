import { contextRpc, executionContextFor } from './execution-context.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildBatchCode, buildReadCode } from './runtime.mjs';
import { planSummary, validatePlan } from './plan.mjs';
import { summarizeDrcReport } from './drc-report.mjs';

const MIN_PORT = 49620;
const MAX_PORT = 49629;
const DEFAULT_TIMEOUT_MS = 65_000;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;

function fail(message, details) {
  const error = new Error(message);
  if (details !== undefined) error.details = details;
  throw error;
}

export function normalizeBridgeUrl(value) {
  if (value == null || value === '') return null;
  let parsed;
  try { parsed = new URL(value); } catch { fail('bridgeUrl must be a valid URL'); }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT ||
      parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    fail(`bridgeUrl must be http://127.0.0.1:${MIN_PORT}-${MAX_PORT} (localhost is also accepted)`);
  }
  return parsed.origin;
}

export async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const maximumResponseBytes = 64 * 1024 * 1024;
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maximumResponseBytes) { await response.body?.cancel?.(); fail('Bridge response exceeds byte limit'); }
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > maximumResponseBytes) { await reader.cancel(); fail('Bridge response exceeds byte limit'); } chunks.push(Buffer.from(value)); } }
      finally { reader.releaseLock(); }
      text = Buffer.concat(chunks).toString('utf8');
    } else { text = await response.text(); if (Buffer.byteLength(text, 'utf8') > maximumResponseBytes) fail('Bridge response exceeds byte limit'); }
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { fail(`Bridge returned non-JSON data from ${url}`, { preview: text.slice(0, 300) }); }
    if (!response.ok) { const payload = body?.error; const error = new Error(`Bridge HTTP ${response.status}: ${String(payload?.message ?? payload ?? body?.message ?? 'request failed').slice(0, 1500)}`); error.code = payload?.code ?? 'BRIDGE_HTTP_ERROR'; error.details = payload?.details ?? body; throw error; }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') { const timeout = new Error(`Bridge request timed out after ${timeoutMs} ms: ${url}`); timeout.code = 'REQUEST_TIMEOUT'; timeout.details = { outcome: 'unknown', requiresReadbackBeforeRetry: true }; throw timeout; }
    throw error;
  } finally { clearTimeout(timer); }
}

export async function resolveBridge({ bridgeUrl = null, windowId = null, requireEda = true } = {}) {
  const explicit = normalizeBridgeUrl(bridgeUrl ?? process.env.EASYEDA_BRIDGE_URL ?? null);
  const candidates = explicit ? [explicit] : Array.from({ length: MAX_PORT - MIN_PORT + 1 }, (_, i) => `http://127.0.0.1:${MIN_PORT + i}`);
  const failures = [];
  for (const baseUrl of candidates) {
    try {
      const health = await fetchJson(`${baseUrl}/health`, {}, explicit ? 2_500 : 1_200);
      if (health?.service !== 'easyeda-bridge') { failures.push({ baseUrl, error: 'service identifier mismatch' }); continue; }
      if (requireEda && !health.edaConnected) fail('EasyEDA Bridge is running, but no EasyEDA window is connected');
      const listing = requireEda ? await fetchJson(`${baseUrl}/eda-windows`, {}, 2500) : null;
      const connected = listing?.windows?.filter(item => item.connected === true) ?? [];
      if (requireEda && !windowId && connected.length > 1) fail('Multiple EasyEDA windows are connected; target.windowId is required');
      if (requireEda && windowId && !connected.some(item => item.windowId === windowId)) fail('Explicit EasyEDA window is not connected; no active-window fallback', { windowId });
      const resolvedWindowId = windowId ?? (requireEda ? connected[0]?.windowId : null) ?? null;
      if (requireEda && !resolvedWindowId) fail('No connected EasyEDA window; rediscover exact target');
      return { baseUrl, health, windowId: resolvedWindowId };
    } catch (error) {
      if (explicit) throw error;
      failures.push({ baseUrl, error: String(error?.message ?? error) });
    }
  }
  fail(`No EasyEDA Bridge found on 127.0.0.1:${MIN_PORT}-${MAX_PORT}`, { failures });
}

export async function executeBridgeCode(bridge, code, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const body = { code };
  if (bridge.windowId) body.windowId = bridge.windowId;
  const payload = await fetchJson(`${bridge.baseUrl}/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, timeoutMs);
  if (!payload?.success) fail(payload?.error ?? 'EasyEDA Bridge execution failed', payload);
  if (bridge.windowId && payload.windowId && payload.windowId !== bridge.windowId) fail('Bridge response window mismatch; inspect actual state before retry');
  return payload.result;
}

export function assertAllowedTarget(target) {
  const config = process.env.EASYEDA_ALLOWED_PROJECT_UUIDS;
  if (!config) return;
  let allowed;
  try { allowed = JSON.parse(config); } catch { fail('EASYEDA_ALLOWED_PROJECT_UUIDS must be a JSON string array'); }
  if (!Array.isArray(allowed) || !allowed.length || !allowed.every(item => typeof item === 'string' && item.trim())) fail('EASYEDA_ALLOWED_PROJECT_UUIDS must be a nonempty JSON string array');
  if (!target?.projectUuid || !target?.windowId || !allowed.includes(target.projectUuid)) fail('Target outside configured project scope, or missing explicit projectUuid/windowId');
}

export function requiresMcpOwnedRead(request) {
  const directKinds = new Set(['pins', 'auditSnapshot', 'poured', 'polylines']);
  if (directKinds.has(request?.kind)) return true;
  if (request?.kind !== 'snapshot' || !Array.isArray(request.include)) return false;
  return request.include.some(kind => kind === 'poured' || kind === 'polylines');
}

export async function readPcb(request, options = {}) {
  assertAllowedTarget(request?.target);
  const context = request?.target ? executionContextFor(request.target) : null;
  // Read-only pin/audit adapters are MCP-owned so older Gateway runtimes cannot reintroduce raw footprint-hole units.
  if (requiresMcpOwnedRead(request)) {
    const bridge=context?.session.bridge??await resolveBridge({bridgeUrl:options.bridgeUrl,windowId:request.target?.windowId,requireEda:true});
    const result=await executeBridgeCode(bridge,buildReadCode(request),options.timeoutMs??DEFAULT_TIMEOUT_MS);
    return {bridge:{baseUrl:bridge.baseUrl,windowId:bridge.windowId},readImplementation:'mcp-owned-geometry-readback',result};
  }
  if (context) return { bridge: { baseUrl: context.session.bridge.baseUrl, windowId: context.session.target.windowId }, result: (await contextRpc('pcb.read', { request })).result };
  if (request?.target?.windowId && request?.target?.projectUuid) {
    const { connectGateway } = await import('./gateway-client.mjs');
    const session = await connectGateway({ target: request.target, bridgeUrl: options.bridgeUrl });
    if (session.protocolVersion === 2) return { bridge: { baseUrl: session.bridge.baseUrl, windowId: session.target.windowId, protocolVersion: 2 }, result: (await session.rpc('pcb.read', { request })).result };
  }
  const bridge = await resolveBridge({ bridgeUrl: options.bridgeUrl, windowId: request?.target?.windowId ?? options.windowId, requireEda: true });
  return {
    bridge: { baseUrl: bridge.baseUrl, windowId: bridge.windowId },
    result: await executeBridgeCode(bridge, buildReadCode(request), options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
}

export async function loadPlanSource({ planPath, plan }, {maxBytes=MAX_PLAN_BYTES}={}) {
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>33554432) fail('Invalid JSON source size limit');
  if ((planPath == null) === (plan == null)) fail('Provide exactly one of planPath or plan');
  if (plan != null) {let serialized;try{serialized=JSON.stringify(plan);}catch{fail('Inline JSON source is not serializable');}if(typeof serialized!=='string')fail('Inline JSON source is not serializable');if(Buffer.byteLength(serialized,'utf8')>maxBytes)fail(`JSON source exceeds ${maxBytes} bytes`);return { source: 'inline', raw: plan };}
  if (typeof planPath !== 'string' || !planPath.trim()) fail('planPath must be a non-empty path');
  const absolutePath = path.resolve(planPath);
  if (path.extname(absolutePath).toLowerCase() !== '.json') fail('planPath must point to a .json file');
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) fail('planPath must point to a regular file');
  if (stat.size > maxBytes) fail(`JSON source exceeds ${maxBytes} bytes`);
  const bytes = await fs.readFile(absolutePath);
  if(bytes.length>maxBytes)fail(`JSON source exceeds ${maxBytes} bytes after read`);
  const text=bytes.toString('utf8').replace(/^\uFEFF/,'');
  let raw;
  try { raw = JSON.parse(text); } catch (error) { fail(`Plan JSON parsing failed: ${error.message}`); }
  return { source: absolutePath, raw };
}

export async function validatePlanSource(source) {
  const loaded = await loadPlanSource(source);
  const normalized = validatePlan(loaded.raw);
  return { loaded, normalized, summary: planSummary(normalized) };
}

function batchesOf(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

export async function saveDocument(bridge, target) {
  assertAllowedTarget(target);
  if (executionContextFor(target)) return (await contextRpc('pcb.save', {}, { write: true })).result.saved;
  const code = `const d=await eda.dmt_SelectControl.getCurrentDocumentInfo();if(d?.uuid!==${JSON.stringify(target.documentUuid)}||d?.documentType!==3)throw new Error('PCB document/type mismatch before save');if(${JSON.stringify(target.projectUuid ?? null)}&&(await eda.dmt_Project.getCurrentProjectInfo())?.uuid!==${JSON.stringify(target.projectUuid ?? null)})throw new Error('PCB project mismatch before save');return await eda.pcb_Document.save(${JSON.stringify(target.documentUuid)});`;
  const saved = await executeBridgeCode(bridge, code);
  if (!saved) fail('EasyEDA save returned false');
  return saved;
}

export async function executePlanSource(source, { bridgeUrl = null } = {}) {
  const { loaded, normalized, summary } = await validatePlanSource(source);
  assertAllowedTarget(normalized.target);
  const bridge = await resolveBridge({ bridgeUrl, windowId: normalized.target.windowId, requireEda: true });
  const preflight = await executeBridgeCode(bridge, buildReadCode({ kind: 'status', target: normalized.target }));
  const batches = batchesOf(normalized.operations, normalized.options.batchSize);
  const results = [];
  let requiresRepour = false;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batchResult = await executeBridgeCode(bridge, buildBatchCode({
      target: normalized.target, toleranceMil: normalized.options.toleranceMil, operations: batches[batchIndex],
    }));
    results.push(...(batchResult?.results ?? []));
    requiresRepour ||= Boolean((batchResult?.results ?? []).some(item => item.requiresRepour));
    if (!batchResult?.ok) fail(`PCB plan stopped in batch ${batchIndex + 1}: ${batchResult?.error?.message ?? 'unknown operation error'}`, {
      source: loaded.source, summary, batchIndex, completedOperationCount: results.length, results, error: batchResult?.error ?? null,
    });
    if (normalized.options.saveAfterBatch) await saveDocument(bridge, normalized.target);
  }
  if (!normalized.options.saveAfterBatch) await saveDocument(bridge, normalized.target);
  return {
    ok: true, source: loaded.source, bridge: { baseUrl: bridge.baseUrl, windowId: bridge.windowId }, preflight, summary,
    batchCount: batches.length, completedOperationCount: results.length,
    resultCounts: results.reduce((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {}),
    requiresRepour, results,
  };
}

export async function saveAndCheck({ target, bridgeUrl = null, save = true, runDrc = true }) {
  if (!target?.documentUuid) fail('target.documentUuid is required');
  assertAllowedTarget(target);
  const bridge = await resolveBridge({ bridgeUrl, windowId: target.windowId, requireEda: true });
  const status = await executeBridgeCode(bridge, buildReadCode({ kind: 'status', target }));
  let saved = null;
  if (save) saved = await saveDocument(bridge, target);
  let drc = null;
  if (runDrc) {
    const code = `const d=await eda.dmt_SelectControl.getCurrentDocumentInfo();if(d?.uuid!==${JSON.stringify(target.documentUuid)}||d?.documentType!==3)throw new Error('PCB document/type mismatch before DRC');if(${JSON.stringify(target.projectUuid ?? null)}&&(await eda.dmt_Project.getCurrentProjectInfo())?.uuid!==${JSON.stringify(target.projectUuid ?? null)})throw new Error('PCB project mismatch before DRC');return await eda.pcb_Drc.check(true,false,true);`;
    drc = executionContextFor(target) ? (await contextRpc('pcb.drc')).result : await executeBridgeCode(bridge, code, 120_000);
    if (!Array.isArray(drc)) fail('Invalid verbose DRC response: expected an error array', {responseType:typeof drc,response:drc,saved});
    await executeBridgeCode(bridge, buildReadCode({kind:'status',target}));
  }
  const report = runDrc ? summarizeDrcReport(drc) : null;
  return { ok: true, bridge: { baseUrl: bridge.baseUrl, windowId: bridge.windowId }, status, saved, drc, drcVerified:report?.verified??false, drcErrorCount:report?.total??null, drcPassed:report?report.total===0:null, drcItems:report?.items??null, drcSummary:report?{topLevelCount:report.topLevelCount,groupCount:report.groupCount,countsByCategory:report.countsByCategory,countsByRule:report.countsByRule}:null };
}

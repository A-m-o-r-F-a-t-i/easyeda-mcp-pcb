import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exactTarget = { windowId: 'window-smoke', projectUuid: 'project-smoke', documentUuid: 'pcb-doc-smoke' };
const expectedDefault = [
  'pcb_audit_geometry',
  'pcb_capture_inspection_view',
  'pcb_compare_associated_netlists',
  'pcb_execute_plan',
  'pcb_execute_text_plan',
  'pcb_export',
  'pcb_import_schematic_changes',
  'pcb_inspect_pinmap',
  'pcb_inspect_silkscreen',
  'pcb_list_targets',
  'pcb_manage_constraint_group',
  'pcb_open_target',
  'pcb_pick',
  'pcb_read',
  'pcb_read_constraints',
  'pcb_rebuild_pours',
  'pcb_render_inspection_svg',
  'pcb_save_and_drc',
  'pcb_status',
  'pcb_verify_api_gates',
].sort();
const expectedLegacy = [
  'pcb_audit_geometry',
  'pcb_capabilities',
  'pcb_capture_inspection_view',
  'pcb_capture_snapshot',
  'pcb_capture_view',
  'pcb_compare_associated_netlists',
  'pcb_compare_snapshots',
  'pcb_execute_plan',
  'pcb_execute_text_plan',
  'pcb_export_backup',
  'pcb_export_manufacturing',
  'pcb_import_schematic_changes',
  'pcb_inspect_pinmap',
  'pcb_inspect_silkscreen',
  'pcb_list_targets',
  'pcb_manage_constraint_group',
  'pcb_open_target',
  'pcb_pick',
  'pcb_prepare_schematic_sync',
  'pcb_read',
  'pcb_read_constraints',
  'pcb_realtime_drc',
  'pcb_rebuild_pours',
  'pcb_render_inspection_svg',
  'pcb_save_and_drc',
  'pcb_status',
  'pcb_validate_plan',
  'pcb_validate_text_plan',
  'pcb_verify_api_gates',
].sort();
const expectedDiagnostics = ['pcb_capture_snapshot', 'pcb_compare_snapshots', 'pcb_realtime_drc'].sort();

async function connectProfile(profile) {
  const client = new Client({ name: `easyeda-pcb-mcp-smoke-${profile}`, version: '2.4.6' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.mjs'],
    cwd: root,
    env: { ...process.env, EASYEDA_PCB_PROFILE: profile },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

const sessions = [];
try {
  const production = await connectProfile('default');
  sessions.push(production);
  const listed = await production.client.listTools();
  const names = listed.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, expectedDefault);
  assert.equal(new Set(names).size, expectedDefault.length);
  assert.ok(listed.tools.every(tool => tool.description.length < 260));

  const plan = {
    schema: 'easyeda-pcb-plan/v2',
    intent: 'MCP smoke validation',
    target: exactTarget,
    units: 'mil',
    phase: 'route',
    constraints: { minTrackWidth: 4, minViaHole: 8, minAnnularRing: 3, allowedLayers: ['TOP', 'BOTTOM'] },
    operations: [{ id: 'l1', type: 'line.create', net: 'N1', layer: 'TOP', start: [10, 10], end: [50, 10], width: 8 }],
  };
  const result = await production.client.callTool({ name: 'pcb_execute_plan', arguments: { plan, mode: 'validate' } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.ok, true);
  assert.equal(result.structuredContent?.wrotePCB, false);
  assert.equal(result.structuredContent?.summary?.expandedOperationCount, 1);
  assert.equal(result.structuredContent?.workflowReceipt?.disposition, 'NO_BOARD_CHANGE');
  assert.equal(result.structuredContent?.workflowReceipt?.boardProgressCredited, false);

  const textPlan = {
    schema: 'easyeda-pcb-text-plan/v1',
    intent: 'MCP text smoke validation',
    target: exactTarget,
    units: 'mil',
    operations: [{ id: 'text-1', type: 'string.create', state: { layer: 'TOP_SILKSCREEN', x: 10, y: 20, text: 'UART1', fontFamily: 'default', fontSize: 45, lineWidth: 6, alignMode: 'CENTER', rotation: 0, reverse: false, expansion: 0, mirror: false, primitiveLock: false } }],
  };
  const textResult = await production.client.callTool({ name: 'pcb_execute_text_plan', arguments: { plan: textPlan, mode: 'validate' } });
  assert.equal(textResult.isError, undefined);
  assert.equal(textResult.structuredContent?.ok, true);
  assert.equal(textResult.structuredContent?.wrotePCB, false);
  assert.equal(textResult.structuredContent?.summary?.sourceOperationCount, 1);

  const snapshot = { units: 'mil', pads: [], vias: [], lines: [
    { primitiveId: 'a', net: 'N', layer: 1, startX: 0, startY: 0, endX: 100, endY: 0, lineWidth: 8 },
    { primitiveId: 'b', net: 'N', layer: 1, startX: 100, startY: 0, endX: 100, endY: 100, lineWidth: 8 },
  ] };
  const audited = await production.client.callTool({ name: 'pcb_audit_geometry', arguments: { snapshot, detailLimit: 5 } });
  assert.equal(audited.isError, undefined);
  assert.equal(audited.structuredContent?.geometry?.counts?.ordinaryBadJoints, 1);
  assert.equal(audited.structuredContent?.geometry?.engineeringRelease, 'NOT_EVALUATED');
  const invalid = await production.client.callTool({ name: 'pcb_audit_geometry', arguments: { snapshot, target: exactTarget } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.structuredContent?.error, /exactly one/i);

  const legacy = await connectProfile('legacy');
  sessions.push(legacy);
  const legacyNames = (await legacy.client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(legacyNames, expectedLegacy);

  const diagnostics = await connectProfile('diagnostics');
  sessions.push(diagnostics);
  const diagnosticNames = (await diagnostics.client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(diagnosticNames, expectedDiagnostics);

  await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(production.stderr(), /easyeda-pcb 2\.4\.1 profile=default tools=20/);
  assert.match(legacy.stderr(), /easyeda-pcb 2\.4\.1 profile=legacy tools=29/);
  assert.match(diagnostics.stderr(), /easyeda-pcb 2\.4\.1 profile=diagnostics tools=3/);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: '2.4.6',
    profiles: { default: names, legacy: legacyNames, diagnostics: diagnosticNames },
  }, null, 2)}\n`);
} finally {
  await Promise.allSettled(sessions.reverse().map(session => session.transport.close()));
}


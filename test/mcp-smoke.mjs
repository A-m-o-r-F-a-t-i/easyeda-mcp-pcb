import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const exactTarget = { windowId: 'window-smoke', projectUuid: 'project-smoke', documentUuid: 'pcb-doc-smoke' };
const expectedDefault = [
  'pcb_audit_geometry',
  'pcb_capture_inspection_view',
  'pcb_compare_associated_netlists',
  'pcb_cleanup_components',
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
  'pcb_cleanup_components',
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
  const client = new Client({ name: `easyeda-pcb-mcp-smoke-${profile}`, version: packageVersion });
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

  const result = await production.client.callTool({name:'pcb_read',arguments:{kind:'operations'}});
  assert.notEqual(result.isError,true);
  assert.equal(result.structuredContent?.schema,'easyeda-pcb-edit/v3');
  const edit=listed.tools.find(t=>t.name==='pcb_execute_plan').inputSchema;
  assert.ok(edit.properties.operations.items);
  assert.equal(edit.properties.guard,undefined);
  assert.equal(edit.properties.mode,undefined);

  const snapshot = { units: 'mil', pads: [], vias: [], lines: [
    { primitiveId: 'a', net: 'N', layer: 1, startX: 0, startY: 0, endX: 100, endY: 0, lineWidth: 8 },
    { primitiveId: 'b', net: 'N', layer: 1, startX: 100, startY: 0, endX: 100, endY: 100, lineWidth: 8 },
  ] };
  const audited = await production.client.callTool({ name: 'pcb_audit_geometry', arguments: { snapshot, detailLimit: 5 } });
  assert.notEqual(audited.isError, true);
  assert.equal(audited.structuredContent?.geometry?.counts?.ordinaryBadJoints, 1);
  assert.equal(audited.structuredContent?.geometry?.engineeringRelease, 'NOT_EVALUATED');
  const invalid = await production.client.callTool({ name: 'pcb_audit_geometry', arguments: { snapshot, target: exactTarget } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.structuredContent?.error?.message ?? invalid.structuredContent?.error, /exactly one/i);

  const legacy = await connectProfile('legacy');
  sessions.push(legacy);
  const legacyNames = (await legacy.client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(legacyNames, expectedLegacy);

  const diagnostics = await connectProfile('diagnostics');
  sessions.push(diagnostics);
  const diagnosticNames = (await diagnostics.client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(diagnosticNames, expectedDiagnostics);

  await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(production.stderr(), new RegExp(`easyeda-pcb ${packageVersion.replaceAll('.', '\\.')} profile=default tools=21`));
  assert.match(legacy.stderr(), new RegExp(`easyeda-pcb ${packageVersion.replaceAll('.', '\\.')} profile=legacy tools=30`));
  assert.match(diagnostics.stderr(), new RegExp(`easyeda-pcb ${packageVersion.replaceAll('.', '\\.')} profile=diagnostics tools=3`));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: packageVersion,
    profiles: { default: names, legacy: legacyNames, diagnostics: diagnosticNames },
  }, null, 2)}\n`);
} finally {
  await Promise.allSettled(sessions.reverse().map(session => session.transport.close()));
}


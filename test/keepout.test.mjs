import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createKeepoutModel, keepoutRuntime } from '../src/keepout.mjs';
import { normalizeDocumentSource } from '../src/source-fingerprint.mjs';
import { createPortableSha256 } from '../src/portable-sha256.mjs';
import { validatePublicWriteTransition } from '../src/execution-context.mjs';
import { runPlan } from '../src/guarded-plan.mjs';

const target = { documentUuid: '0123456789abcdef', projectUuid: 'project', windowId: 'window', tabId: 'tab' };
const flags = ['COMPONENT', 'TRACK', 'FILL', 'COPPER', 'PLANE'];
const plan = () => ({ schema: 'easyeda-pcb-keepout-plan/v1', units: 'mm', intent: 'Keep all copper and components out of a screw envelope', target, backupPath: 'C:\\backups\\new.epro', operations: [{ type: 'region.circle.create', primitiveId: '1111111111111111', name: 'MH1_CLEARANCE', center: [14.1421356, 14.1421356], diameter: 6, layer: 12, prohibitions: flags, expected: null }] });
const record = (type, id, body, ticket = 1) => JSON.stringify({ type, ...(id ? { id, ticket } : {}) }) + '||' + JSON.stringify(body) + '|\n';
const source = record('DOCHEAD', null, { docType: 'PCB', uuid: target.documentUuid }) + record('CANVAS', 'CANVAS', { originX: 0, originY: 0 }) + record('COMPONENT', '2222222222222222', { designator: 'U1', x: 1, y: 2 }) + record('PAD', '3333333333333333', { net: 'GND', number: '1' });
const model = createKeepoutModel();
const hash = s => crypto.createHash('sha256').update(normalizeDocumentSource(s).canonicalText).digest('hex');
const mutateRegion = (text, fn) => text.split('\n').map(line => { if (!line.includes('"type":"REGION"')) return line; const i = line.indexOf('||'), h = line.slice(0, i), b = JSON.parse(line.endsWith('|') ? line.slice(i + 2, -1) : line.slice(i + 2)); fn(b); return h + '||' + JSON.stringify(b) + (line.endsWith('|') ? '|' : ''); }).join('\n');

test('K01 keepout plan validates through the existing geometry tool without contacting the client', async () => {
  const result = await runPlan({ plan: plan() }, { mode: 'validate' });
  assert.equal(result.wrotePCB, false); assert.equal(result.summary.createCount, 1);
});
test('K02 supported native flags survive patch and verification', () => {
  const p = plan(), changed = model.patch(source, p);
  assert.deepEqual(changed.added[0].body.prohibitType, flags);
  assert.equal(model.verify(source, changed.source, p).nonTargetRecordsUnchanged, true);
});
test('K03 unchanged source cannot be accepted as completed creation', () => {
  assert.throws(() => model.verify(source, source, plan()), /missing/);
});
test('K04 model verification rejects a stripped requested VIA even when other rules survive', () => {
  const p = plan(); p.operations[0].prohibitions = [...flags,'VIA']; const changed = model.patch(source,p).source;
  assert.throws(() => model.verify(source, mutateRegion(changed, b => b.prohibitType = b.prohibitType.filter(x => x !== 'VIA')), p), /flags/);
});
test('K05 a change to an unrelated pad net is rejected', () => {
  const p = plan(), changed = model.patch(source, p).source.replace('"net":"GND"', '"net":"VCC"');
  assert.throws(() => model.verify(source, changed, p), /Non-target/);
});
test('K06 duplicate create IDs and names cannot be replayed silently', () => {
  const p = plan(), changed = model.patch(source, p).source;
  assert.throws(() => model.patch(changed, p), /already exists/);
  p.operations.push({ ...p.operations[0], primitiveId: '4444444444444444' });
  assert.throws(() => model.validate(p), /name/);
});
test('K07 only REGION objects with exact old values may be removed', () => {
  const p = plan(); p.operations = [{ type: 'region.delete', primitiveId: '3333333333333333', expected: { net: 'GND', number: '1' } }];
  assert.throws(() => model.patch(source, p), /old-state/);
});
test('K08 circle polygon encloses the full requested disk after native rounding', () => {
  const op = plan().operations[0], path = model.circleRecord(op).path[0], xy = [...path.slice(0, 2), ...path.slice(3)];
  const c = op.center.map(x => x / 0.0254);
  for (let i = 0; i < xy.length - 2; i += 2) {
    const [ax, ay, bx, by] = xy.slice(i, i + 4);
    const distance = Math.abs((bx - ax) * (ay - c[1]) - (by - ay) * (ax - c[0])) / Math.hypot(bx - ax, by - ay);
    assert.ok(distance * 0.0254 >= 3);
  }
});
test('K09 reordered polygon vertices are rejected; winding reversal is accepted', () => {
  const p = plan(), patched = model.patch(source, p).source;
  const rewound = mutateRegion(patched, b => { const a = [...b.path[0].slice(0, 2), ...b.path[0].slice(3)], pts = []; for (let i=0;i<a.length-2;i+=2) pts.push(a.slice(i,i+2)); pts.reverse(); b.path = [[...pts[0],'L',...pts.slice(1).flat(),...pts[0]]]; });
  assert.equal(model.verify(source, rewound, p).results[0].verified, true);
  const crossed = mutateRegion(patched, b => { const p = b.path[0]; [p[3],p[5]] = [p[5],p[3]]; [p[4],p[6]]=[p[6],p[4]]; });
  assert.throws(() => model.verify(source, crossed, p), /polygon/);
});
function fixture({ ignore = false, wrongNet = false, drift = false } = {}) {
  let current = source, writes = 0;
  return { eda: {
    sys_Environment: { getEditorCurrentVersion: async () => '4.1.60' },
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: drift && writes ? 'other' : target.documentUuid, documentType: 3, tabId: 'tab' }) },
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: target.projectUuid }) },
    sys_FileManager: { getDocumentSource: async () => current, setDocumentSource: async next => { writes++; if (!ignore) current = wrongNet ? next.replace('"net":"GND"','"net":"VCC"') : next; return true; } },
  }, writes: () => writes };
}
const execute = f => keepoutRuntime(f.eda, { target, plan: plan(), expectedSourceHash: hash(source) }, createPortableSha256(), normalizeDocumentSource, createKeepoutModel);
test('K10 actual source mutation is independently verified by the client runtime', async () => {
  const f = fixture(), result = await execute(f); assert.equal(f.writes(),1); assert.equal(result.ok,true); assert.notEqual(result.sourceBefore.sha256,result.sourceAfter.sha256);
});
test('K11 API true without mutation fails', async () => { await assert.rejects(execute(fixture({ignore:true})), /missing/); });
test('K12 unexpected pad modification fails without automatic rollback', async () => { const f=fixture({wrongNet:true}); await assert.rejects(execute(f), /Non-target/); assert.equal(f.writes(),1); });
test('K13 target drift after write fails without blind replay', async () => { const f=fixture({drift:true}); await assert.rejects(execute(f), /target changed/); assert.equal(f.writes(),1); });
test('K14 verified public write advances expected source only when independently observed', () => {
  const before={generationId:'g',bridgeGenerationId:'b',changeEpoch:1,sourceHash:'1'.repeat(64)}, result={ok:true,sourceBefore:{sha256:before.sourceHash},sourceAfter:{sha256:'2'.repeat(64)}}, observed={...before,changeEpoch:2,sourceHash:'2'.repeat(64)};
  assert.equal(validatePublicWriteTransition(before,result,observed).sourceHash,observed.sourceHash);
  assert.throws(()=>validatePublicWriteTransition(before,result,{...observed,sourceHash:'3'.repeat(64)}), /differs/);
  assert.throws(()=>validatePublicWriteTransition(before,result,{...observed,generationId:'restart'}), /restarted/);
});
test('K15 public runtime and model serialize without Node references', () => {
  const code=keepoutRuntime.toString()+createKeepoutModel.toString(); assert.doesNotMatch(code,/node:|Buffer\.|process\./);
});

test('K16 unsupported native VIA fails before any source write', async () => { const f=fixture(), p=plan();p.operations[0].prohibitions=[...flags,'VIA'];await assert.rejects(keepoutRuntime(f.eda,{target,plan:p,expectedSourceHash:hash(source)},createPortableSha256(),normalizeDocumentSource,createKeepoutModel), /drops VIA/);assert.equal(f.writes(),0); });
test('K17 native record serializer separates an original undelimited last record', () => {const changed=model.patch(source.replace(/\|\n$/, ''),plan()).source;const lines=changed.split('\n');assert.ok(lines.slice(0,-1).every(l=>l.endsWith('|')));assert.equal(lines.at(-1).endsWith('|'),false);assert.equal(model.parse(changed).length,model.parse(source).length+1);});

test('K18 equivalent component angles remain explicit evidence rather than a silent unchanged claim',()=>{const b=source.replace('"x":1,"y":2','"x":1,"y":2,"angle":270'),after=model.patch(b,plan()).source.replace('"angle":270','"angle":-90');const r=model.verify(b,after,plan());assert.equal(r.nonTargetRecordsUnchanged,false);assert.equal(r.nonTargetGeometryEquivalent,true);assert.deepEqual(r.normalizedAngles,[{primitiveId:'2222222222222222',before:270,after:-90}]);});
test('K19 actual angle changes and tiny coordinate moves still fail strict non-target protection',()=>{const b=source.replace('"x":1,"y":2','"x":1,"y":2,"angle":270');const next=model.patch(b,plan()).source;assert.throws(()=>model.verify(b,next.replace('"angle":270','"angle":-89'),plan()),/Non-target/);assert.throws(()=>model.verify(b,next.replace('"x":1','"x":1.0001'),plan()),/Non-target.*x/);});
test('K20 read-only completion verifies an already applied region without another source write',async()=>{const f=fixture();await execute(f);const state=await f.eda.sys_FileManager.getDocumentSource();const n=f.writes();const r=await keepoutRuntime(f.eda,{target,plan:plan(),expectedSourceHash:hash(state),readOnly:true},createPortableSha256(),normalizeDocumentSource,createKeepoutModel);assert.equal(r.complete,true);assert.equal(r.wrotePCB,false);assert.equal(f.writes(),n);});
test('K21 read-only pending detection cannot count a missing region as complete',async()=>{const f=fixture();const r=await keepoutRuntime(f.eda,{target,plan:plan(),expectedSourceHash:hash(source),readOnly:true},createPortableSha256(),normalizeDocumentSource,createKeepoutModel);assert.equal(r.complete,false);assert.equal(f.writes(),0);});
test('K22 a completed subset cannot be reported as an entirely applied plan',async()=>{const f=fixture();await execute(f);const state=await f.eda.sys_FileManager.getDocumentSource();const p=plan();p.operations.push({...p.operations[0],primitiveId:'5555555555555555',name:'SECOND',center:[-10,-10]});const n=f.writes();const r=await keepoutRuntime(f.eda,{target,plan:p,expectedSourceHash:hash(state),readOnly:true},createPortableSha256(),normalizeDocumentSource,createKeepoutModel);assert.equal(r.complete,false);assert.equal(f.writes(),n);});
test('K23 already applied verification rejects a stale source guard before any write',async()=>{const f=fixture();await execute(f);await assert.rejects(keepoutRuntime(f.eda,{target,plan:plan(),expectedSourceHash:hash(source),readOnly:true},createPortableSha256(),normalizeDocumentSource,createKeepoutModel),/stale/);assert.equal(f.writes(),1);});

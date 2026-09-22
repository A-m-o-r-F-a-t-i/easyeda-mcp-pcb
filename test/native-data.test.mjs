import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeBoardInfo } from '../src/native-board-info.mjs';
import { parseDsnScene, parseSExpression, tokenizeSExpression } from '../src/dsn.mjs';
import { decodeUtf8Envelope, hashBytes } from '../src/gateway-client.mjs';

const zh = `工程标题: fixture
板子标题: Board1
PCB 标题: PCB1
时间: 2026-01-01 00:00:00
板子尺寸: 84.836mm x 54.991mm
层: 总计 24, 铜箔层 4
器件: 39
封装: 38
元件: 总计 107,顶层 86,底层 21
焊盘: 总计 440, 顶面表贴 242,底面表贴 140,金属化孔 58, 非金属化孔 0
网络: 总计 110, 未布线 0
测试点: 网络总数 110, 有测试点的网络 2, 测试点覆盖率 1.82%
 总计 2, 顶面测试点 2, 底面测试点 0
挖槽区域: 12
过孔: 总计 871, 通孔 871, 盲埋孔 0
铺铜区域: 32
导线长度: 4483.215mm
`;
const en = `Project Title: fixture
Board Title: Board1
PCB Title: PCB1
Time: 2026-01-01
Board Size: 100mil x 200mil
Layers: Total 24, Copper Layers 4
Devices: 2
Footprints: 2
Components: Total 3, Top 2, Bottom 1
Pads: Total 4, Top SMD 2, Bottom SMD 1, Plated Holes 1, Non-Plated Holes 0
Nets: Total 2, Unrouted 1
Vias: Total 1, Through 1, Blind/Buried 0
Copper Pour Regions: 0
Trace Length: 1in
`;
export const dsn = `(PCB "fixture board"
(parser (string_quote ") (host_cad "test"))
(resolution mil 1000)
(structure (boundary (path signal 0 0 0 3340 0 3340 2165 0 2165 0 0))
  (layer TopLayer (type signal)) (layer BottomLayer (type signal))
  (rule (width 10)) (rule (clear 6)))
(placement (component image1 (place U1 0 0 front 0)))
(library
 (image image1 (pin pad1 1 100 100) (pin pad1 2 200 100))
 (padstack pad1 (shape (rect TopLayer -10 -10 10 10)))
 (padstack via1 (shape (circle TopLayer 24)) (shape (circle BottomLayer 24))))
(network (net "NET A" (pins U1-1 U1-2)))
(wiring (wire (path TopLayer 10 100 100 200 100) (net "NET A"))
 (via via1 150 100 (net "NET A"))))`;

test('Chinese PCB Info preserves device and component distinctions', () => {
  const value = parseNativeBoardInfo(zh);
  assert.equal(value.deviceCount, 39);
  assert.equal(value.componentCount, 107);
  assert.equal(value.padCount, 440);
  assert.equal(value.copperLayerCount, 4);
  assert.equal(value.nativeUnroutedCount, 0);
  assert.equal(value.testPointCount, 2);
  assert.equal(value.parsingComplete, true);
  assert.equal(value.boardSizeMm.width, 84.836);
});
test('English fixture normalizes explicit length units', () => {
  const value = parseNativeBoardInfo(en);
  assert.equal(value.componentCount, 3);
  assert.equal(value.nativeUnroutedCount, 1);
  assert.equal(value.boardSizeMm.width, 2.54);
  assert.equal(value.traceLengthMm, 25.4);
  assert.equal(value.parsingComplete, true);
});
test('unknown lines, missing units and conflicting repeated fields are disclosed', () => {
  const unknown = parseNativeBoardInfo(zh + 'New metric: 99\n');
  assert.equal(unknown.parsingComplete, false);
  assert.ok(unknown.unparsedLines.includes('New metric: 99'));
  const missing = parseNativeBoardInfo(zh.replace('84.836mm x 54.991mm', '84.836 x 54.991'));
  assert.ok(missing.missingFields.includes('boardSizeMm'));
  const conflicting = parseNativeBoardInfo(zh + '网络: 总计 111, 未布线 0\n');
  assert.equal(conflicting.issues[0].code, 'CONFLICTING_FIELD');
});
test('DSN parser preserves resolution without dividing physical coordinates', () => {
  const scene = parseDsnScene(dsn);
  assert.equal(scene.sourceUnits, 'mil');
  assert.equal(scene.resolution, 1000);
  assert.equal(scene.boardOutline[0].points[1][0], 84.836);
  assert.equal(scene.pads[0].x, 2.54);
  assert.equal(scene.tracks[0].width, 0.254);
  assert.deepEqual(scene.summary, { layerCount: 2, placementCount: 1, padCount: 2, netCount: 1, segmentCount: 1, viaCount: 1, unresolvedPinCount: 0, warningCount: 0 });
  assert.equal(scene.apiCoordinateTransform, null);
});
test('quoted strings, custom quote declaration and comments are parsed structurally', () => {
  assert.deepEqual(parseSExpression('(root "a (b)" "a\\\"b" ; comment\n (child 1))'), ['root', 'a (b)', 'a"b', ['child', '1']]);
  assert.deepEqual(parseSExpression('(root (string_quote #) #a b#)'), ['root', ['string_quote', '#'], 'a b']);
});
test('malformed and resource-exhausting DSN expressions fail explicitly', () => {
  assert.throws(() => parseSExpression('(root (a)'), /Unclosed/);
  assert.throws(() => parseSExpression('(root "a)'), /Unterminated/);
  assert.throws(() => parseSExpression('(a)(b)'), /one root/);
  assert.throws(() => parseSExpression('('.repeat(129) + ')'.repeat(129)), /nesting/);
  assert.throws(() => tokenizeSExpression('(a b c)', { maximumTokens: 2 }), /token limit/);
});
test('DSN duplicate identities and multiple-net pin assignments are not silently merged', () => {
  assert.throws(() => parseDsnScene(dsn.replace('(net "NET A" (pins U1-1 U1-2))', '(net "NET A" (pins U1-1 U1-2)) (net B (pins U1-1))')), /multiple nets/);
  assert.throws(() => parseDsnScene(dsn.replace('(pin pad1 2 200 100)', '(pin pad1 1 200 100)')), /Duplicate DSN pin/);
});
test('unverified back-side transforms remain unresolved', () => {
  const scene = parseDsnScene(dsn.replace('front 0', 'back 90'));
  assert.equal(scene.pads[0].transformResolved, false);
  assert.equal(scene.pads[0].x, undefined);
  assert.ok(scene.coverage.warnings.some(x => x.code === 'BACK_SIDE_TRANSFORM_UNVERIFIED'));
});
test('UTF-8 transfer verifies BOM, exact byte length and SHA-256', () => {
  const text = '\uFEFF测试DSN';
  const bytes = Buffer.from(text, 'utf8');
  const envelope = { encoding: 'utf8', text, byteLength: bytes.length, sha256: hashBytes(bytes) };
  assert.deepEqual(decodeUtf8Envelope(envelope, 1024), bytes);
  assert.throws(() => decodeUtf8Envelope({ ...envelope, text: text + 'x' }, 1024), /mismatch/);
  assert.throws(() => decodeUtf8Envelope(envelope, 1), /Invalid/);
});

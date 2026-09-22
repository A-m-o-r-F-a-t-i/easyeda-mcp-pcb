import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION as PLAN_VERSION } from '../src/plan.mjs';
import { VERSION as SERVER_VERSION } from '../src/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

test('MCP package, lockfile, plan and server versions stay identical', () => {
  assert.equal(packageVersion, '2.4.11');
  assert.equal(lock.version, packageVersion);
  assert.equal(lock.packages[''].version, packageVersion);
  assert.equal(PLAN_VERSION, packageVersion);
  assert.equal(SERVER_VERSION, packageVersion);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { getToolRegistry } from '../src/server.mjs';

test('native DRC and the combined API gate expose the same bounded page contract', () => {
  for (const profile of ['default', 'legacy']) {
    for (const name of ['pcb_save_and_drc', 'pcb_verify_api_gates']) {
      const field = getToolRegistry(profile).get(name).definition.inputSchema.drcDetailLimit;
      assert.equal(field.parse(undefined), 100);
      assert.equal(field.safeParse(0).success, true);
      assert.equal(field.safeParse(250).success, true);
      assert.equal(field.safeParse(251).success, false);
      assert.equal(field.safeParse(-1).success, false);
    }
  }
});

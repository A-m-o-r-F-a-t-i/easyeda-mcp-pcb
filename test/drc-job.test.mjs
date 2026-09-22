import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDrcStartCode,
  buildDrcStatusCode,
  waitForDrcJob,
  DRC_JOB_REGISTRY_KEY,
  DRC_JOB_MAX_RUNTIME_MS,
  DRC_JOB_TERMINAL_TTL_MS,
} from '../src/drc-job.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const target = { windowId: 'window-1', projectUuid: 'project-1', documentUuid: 'pcb-1' };
const leaf = id => ({
  globalIndex: id,
  visible: true,
  errorType: 'Clearance Error',
  errorObjType: 'Pad to Pad',
  ruleName: 'Clearance',
  ruleTypeName: 'Spacing',
  layer: 'Top Layer',
  objs: [`a-${id}`, `b-${id}`],
});

function controlledPromise() {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => { resolve = resolve_; reject = reject_; });
  return { promise, resolve, reject };
}

function createEda(check) {
  return {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: target.documentUuid, documentType: 3 }) },
    dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: target.projectUuid }) },
    pcb_Drc: { check },
  };
}

async function execute(code, eda, globalScope) {
  return new AsyncFunction('eda', 'globalThis', code)(eda, globalScope);
}

test('native DRC promise continues after start and returns a bounded page', async () => {
  const native = controlledPromise();
  const globalScope = {};
  const eda = createEda(() => native.promise);
  const started = await execute(buildDrcStartCode({ target, jobId: 'job-a' }), eda, globalScope);
  assert.equal(started.state, 'RUNNING');
  assert.equal(started.nativeCallStarted, true);

  native.resolve([{ name: 'Clearance Error', list: Array.from({ length: 7 }, (_, i) => leaf(String(i))) }]);
  await native.promise;
  await Promise.resolve();

  const result = await execute(buildDrcStatusCode({ target, jobId: 'job-a', offset: 2, limit: 3 }), eda, globalScope);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.report.total, 7);
  assert.equal(result.report.items.length, 3);
  assert.equal(result.report.items[0].findingIndex, 2);
  assert.equal(result.report.page.nextOffset, 5);
  assert.equal(result.rawNativeReportOmitted, true);
  assert.equal(Object.hasOwn(result, 'result'), false);
});

test('a second start reuses the running job for the same target', async () => {
  const native = controlledPromise();
  const globalScope = {};
  const eda = createEda(() => native.promise);
  const first = await execute(buildDrcStartCode({ target, jobId: 'job-first' }), eda, globalScope);
  const second = await execute(buildDrcStartCode({ target, jobId: 'job-second' }), eda, globalScope);
  assert.equal(first.jobId, 'job-first');
  assert.equal(second.jobId, 'job-first');
  assert.equal(second.reused, true);
  native.resolve([]);
  await native.promise;
});

test('native rejection is retained as an explicit failed job', async () => {
  const native = controlledPromise();
  const globalScope = {};
  const eda = createEda(() => native.promise);
  await execute(buildDrcStartCode({ target, jobId: 'job-failed' }), eda, globalScope);
  native.reject(new Error('native checker crashed'));
  await assert.rejects(native.promise, /native checker crashed/);
  await Promise.resolve();
  const result = await execute(buildDrcStatusCode({ target, jobId: 'job-failed' }), eda, globalScope);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error.code, 'NATIVE_DRC_FAILED');
  assert.match(result.error.message, /native checker crashed/);
});

test('a non-array native result can never become a zero-violation pass', async () => {
  const globalScope = {};
  const eda = createEda(() => Promise.resolve(true));
  await execute(buildDrcStartCode({ target, jobId: 'job-malformed' }), eda, globalScope);
  await Promise.resolve();
  await Promise.resolve();
  const result = await execute(buildDrcStatusCode({ target, jobId: 'job-malformed' }), eda, globalScope);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error.code, 'INVALID_VERBOSE_DRC_RESPONSE');
});

test('released and unknown jobs return a specific missing state', async () => {
  const globalScope = {};
  const eda = createEda(() => Promise.resolve([]));
  await execute(buildDrcStartCode({ target, jobId: 'job-release' }), eda, globalScope);
  await Promise.resolve();
  await Promise.resolve();
  const completed = await execute(buildDrcStatusCode({ target, jobId: 'job-release', release: true }), eda, globalScope);
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.released, true);
  const missing = await execute(buildDrcStatusCode({ target, jobId: 'job-release' }), eda, globalScope);
  assert.equal(missing.state, 'MISSING');
  assert.equal(missing.error.code, 'DRC_JOB_NOT_FOUND');
});

test('bounded waiter returns RUNNING without inventing a result', async () => {
  let polls = 0;
  const result = await waitForDrcJob({
    initial: { state: 'RUNNING' },
    poll: async () => { polls += 1; return { state: 'RUNNING' }; },
    waitMs: 0,
    pollIntervalMs: 100,
  });
  assert.equal(result.state, 'RUNNING');
  assert.equal(polls, 0);
});

test('timed-out jobs cannot be revived or overwritten by late native callbacks', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const native = controlledPromise();
    const globalScope = {};
    const eda = createEda(() => native.promise);
    const jobId = `late-${outcome}`;
    await execute(buildDrcStartCode({ target, jobId }), eda, globalScope);
    const job = globalScope[DRC_JOB_REGISTRY_KEY].jobs[jobId];
    job.startedAt = Date.now() - DRC_JOB_MAX_RUNTIME_MS - 1000;
    const timedOut = await execute(buildDrcStatusCode({ target, jobId }), eda, globalScope);
    assert.equal(timedOut.state, 'FAILED');
    assert.equal(timedOut.error.code, 'NATIVE_DRC_JOB_TIMEOUT');
    if (outcome === 'resolve') {
      native.resolve([]);
      await native.promise;
    } else {
      native.reject(new Error('late rejection'));
      await assert.rejects(native.promise, /late rejection/);
    }
    await Promise.resolve();
    const result = await execute(buildDrcStatusCode({ target, jobId }), eda, globalScope);
    assert.equal(result.state, 'FAILED');
    assert.equal(result.error.code, 'NATIVE_DRC_JOB_TIMEOUT');
    assert.equal(job.result, null);
    assert.equal(result.completedAt, timedOut.completedAt);
  }
});

test('native completion after the runtime limit fails even without an intervening poll', async () => {
  const native = controlledPromise();
  const globalScope = {};
  const eda = createEda(() => native.promise);
  await execute(buildDrcStartCode({ target, jobId: 'late-unpolled' }), eda, globalScope);
  globalScope[DRC_JOB_REGISTRY_KEY].jobs['late-unpolled'].startedAt = Date.now() - DRC_JOB_MAX_RUNTIME_MS - 1000;
  native.resolve([]);
  await native.promise;
  const result = await execute(buildDrcStatusCode({ target, jobId: 'late-unpolled' }), eda, globalScope);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error.code, 'NATIVE_DRC_JOB_TIMEOUT');
});

test('missing native DRC capability is distinguished from a checker failure', async () => {
  for (const capability of [undefined, {}, { check: false }]) {
    const eda = createEda(() => []);
    eda.pcb_Drc = capability;
    const result = await execute(buildDrcStartCode({ target, jobId: 'missing-api' }), eda, {});
    assert.equal(result.state, 'FAILED');
    assert.equal(result.nativeCallStarted, false);
    assert.equal(result.error.code, 'NATIVE_DRC_API_UNAVAILABLE');
  }
});

test('synchronous checker exceptions retain evidence that the native call was attempted', async () => {
  const eda = createEda(() => { throw new Error('synchronous checker failure'); });
  const result = await execute(buildDrcStartCode({ target, jobId: 'sync-failure' }), eda, {});
  assert.equal(result.state, 'FAILED');
  assert.equal(result.nativeCallStarted, true);
  assert.equal(result.error.code, 'NATIVE_DRC_FAILED');
  assert.match(result.error.message, /synchronous checker failure/);
});

test('expired terminal jobs are unavailable rather than verified empty reports', async () => {
  const globalScope = {};
  const eda = createEda(() => []);
  await execute(buildDrcStartCode({ target, jobId: 'expired' }), eda, globalScope);
  globalScope[DRC_JOB_REGISTRY_KEY].jobs.expired.completedAt = Date.now() - DRC_JOB_TERMINAL_TTL_MS - 1000;
  const result = await execute(buildDrcStatusCode({ target, jobId: 'expired' }), eda, globalScope);
  assert.equal(result.state, 'MISSING');
  assert.equal(result.error.code, 'DRC_JOB_NOT_FOUND');
  assert.equal(Object.hasOwn(result, 'report'), false);
});

test('a retained job cannot be read from another PCB target', async () => {
  const globalScope = {};
  const eda = createEda(() => []);
  await execute(buildDrcStartCode({ target, jobId: 'owned-job' }), eda, globalScope);
  const otherTarget = { ...target, documentUuid: 'pcb-2' };
  eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: otherTarget.documentUuid, documentType: 3 });
  const result = await execute(buildDrcStatusCode({ target: otherTarget, jobId: 'owned-job' }), eda, globalScope);
  assert.equal(result.state, 'MISMATCH');
  assert.equal(result.error.code, 'DRC_JOB_TARGET_MISMATCH');
  assert.equal(Object.hasOwn(result, 'report'), false);
});

test('malformed native grouping returns a parse error instead of an empty result', async () => {
  const globalScope = {};
  const eda = createEda(() => [{ name: 'Clearance', list: null }]);
  await execute(buildDrcStartCode({ target, jobId: 'bad-group' }), eda, globalScope);
  const result = await execute(buildDrcStatusCode({ target, jobId: 'bad-group' }), eda, globalScope);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error.code, 'DRC_REPORT_PARSE_FAILED');
  assert.equal(Object.hasOwn(result, 'report'), false);
});

test('synchronous native arrays still produce verified totals and details', async () => {
  const globalScope = {};
  const eda = createEda(() => [leaf('synchronous')]);
  const started = await execute(buildDrcStartCode({ target, jobId: 'sync-array' }), eda, globalScope);
  assert.equal(started.state, 'COMPLETED');
  const result = await execute(buildDrcStatusCode({ target, jobId: 'sync-array' }), eda, globalScope);
  assert.equal(result.report.verified, true);
  assert.equal(result.report.total, 1);
  assert.equal(result.report.items[0].globalIndex, 'synchronous');
});

test('the bounded waiter stops polling once a native result completes', async () => {
  let polls = 0;
  const result = await waitForDrcJob({
    initial: { state: 'RUNNING' },
    poll: async () => { polls += 1; return { state: 'COMPLETED' }; },
    waitMs: 200,
    pollIntervalMs: 100,
  });
  assert.equal(result.state, 'COMPLETED');
  assert.equal(polls, 1);
});

test('a nonzero bounded wait returns RUNNING when the native job remains pending', async () => {
  let polls = 0;
  const result = await waitForDrcJob({
    initial: { state: 'RUNNING' },
    poll: async () => { polls += 1; return { state: 'RUNNING' }; },
    waitMs: 100,
    pollIntervalMs: 100,
  });
  assert.equal(result.state, 'RUNNING');
  assert.ok(polls >= 1 && polls <= 2);
});

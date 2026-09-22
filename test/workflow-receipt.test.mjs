import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationDetails, summarizeBoardDelta } from '../src/guarded-plan.mjs';
import {
  createRecoveryDirective,
  createWorkflowReceipt,
  RECOVERY_DIRECTIVE_SCHEMA,
  WORKFLOW_RECEIPT_SCHEMA,
} from '../src/workflow-receipt.mjs';

const normalized = {
  operations: [
    { id: 'move-u1', kind: 'component' },
    { id: 'route-gate-a', kind: 'line' },
  ],
};

test('changed plan result credits board progress and directs the next board action', () => {
  const boardDelta = summarizeBoardDelta(normalized, [
    { id: 'move-u1', status: 'modified', primitiveId: 'component-u1' },
  ]);
  const receipt = createWorkflowReceipt({ mode: 'execute', boardDelta });
  assert.equal(receipt.schema, WORKFLOW_RECEIPT_SCHEMA);
  assert.equal(receipt.disposition, 'CONTINUE_BOARD');
  assert.equal(receipt.replayPolicy, 'NEXT_DEPENDENCY_READY');
  assert.equal(receipt.boardProgressCredited, true);
  assert.equal(receipt.broadAuditAllowed, false);
  assert.equal(receipt.returnToParentStage, true);
});

test('no-op result is not PCB progress and cannot trigger broad re-audit or replay', () => {
  const boardDelta = summarizeBoardDelta(normalized, [
    { id: 'move-u1', status: 'already_modified', primitiveId: 'component-u1' },
  ]);
  const receipt = createWorkflowReceipt({ mode: 'execute', boardDelta });
  assert.equal(receipt.disposition, 'NO_BOARD_CHANGE');
  assert.equal(receipt.replayPolicy, 'DO_NOT_REPLAY');
  assert.equal(receipt.boardProgressCredited, false);
  assert.equal(receipt.minimumReadScope.kind, 'EXACT_OPERATION_OR_OBJECT');
  assert.deepEqual(receipt.minimumReadScope.operationIds, ['move-u1']);
});

test('partial continuation preserves the verified prefix and requests exact suffix reconciliation', () => {
  const continuation = continuationDetails(normalized, [
    { id: 'move-u1', status: 'modified', primitiveId: 'component-u1' },
  ], 'route-gate-a');
  assert.deepEqual(continuation.remainingOperationIds, ['route-gate-a']);
  assert.equal(continuation.workflowReceipt.disposition, 'RECONCILE_EXACT_OPERATION');
  assert.equal(continuation.workflowReceipt.replayPolicy, 'DO_NOT_REPLAY');
  assert.equal(continuation.workflowReceipt.resumePolicy, 'REBUILD_REMAINING_SUFFIX');
  assert.deepEqual(continuation.workflowReceipt.minimumReadScope.operationIds, ['route-gate-a']);
  assert.equal(continuation.workflowReceipt.boardProgressCredited, true);
});

test('validate and prepare explicitly report that no PCB progress occurred', () => {
  const validated = createWorkflowReceipt({ mode: 'validate' });
  const prepared = createWorkflowReceipt({ mode: 'prepare' });
  assert.equal(validated.disposition, 'NO_BOARD_CHANGE');
  assert.equal(validated.resumePolicy, 'PREPARE_VALIDATED_PLAN');
  assert.equal(prepared.disposition, 'NO_BOARD_CHANGE');
  assert.equal(prepared.resumePolicy, 'EXECUTE_PREPARED_PLAN');
  assert.equal(validated.boardProgressCredited, false);
  assert.equal(prepared.boardProgressCredited, false);
});

test('transient Bridge recovery is bounded and returns to the saved parent action', () => {
  const directive = createRecoveryDirective({
    errorCode: 'REQUEST_TIMEOUT',
    executionId: 'execution-1',
    failedOperationId: 'route-gate-a',
    remainingOperationIds: ['route-gate-a'],
    confirmedOperationNames: ['pcb.applyGeometryBatch'],
  });
  assert.equal(directive.schema, RECOVERY_DIRECTIVE_SCHEMA);
  assert.equal(directive.disposition, 'RECONCILE_EXACT_OPERATION');
  assert.equal(directive.replayPolicy, 'DO_NOT_REPLAY');
  assert.equal(directive.returnToParentStage, true);
  assert.equal(directive.resumeSavedBoardAction, true);
  assert.equal(directive.localBridgeFastPath.applicable, true);
  assert.equal(directive.localBridgeFastPath.healthProbeLimit, 2);
  assert.equal(directive.localBridgeFastPath.directedRepairLimit, 1);
  assert.equal(directive.broadAuditAllowed, false);
});

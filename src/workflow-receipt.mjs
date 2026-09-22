export const WORKFLOW_RECEIPT_SCHEMA = 'easyeda-pcb-workflow-receipt/v1';
export const RECOVERY_DIRECTIVE_SCHEMA = 'easyeda-pcb-recovery-directive/v1';

const transientBridgeCodes = new Set([
  'REQUEST_TIMEOUT',
  'BRIDGE_UNAVAILABLE',
  'WINDOW_NOT_FOUND',
  'TARGET_CHANGED',
  'GENERATION_MISMATCH',
]);

function uniqueIds(values = []) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
}

function exactReadScope(failedOperationId, operationIds = []) {
  const ids = uniqueIds([failedOperationId, ...operationIds]);
  if (ids.length) return { kind: 'EXACT_OPERATION_OR_OBJECT', operationIds: ids };
  return {
    kind: 'GUARDED_TARGET_STATE',
    fields: ['generationId', 'bridgeGenerationId', 'changeEpoch', 'sourceHash'],
  };
}

/** Return one stable continuation contract for validate, prepare, execute and partial outcomes. */
export function createWorkflowReceipt({
  mode = 'execute',
  boardDelta = null,
  failedOperationId = null,
  remainingOperationIds = [],
} = {}) {
  const remaining = uniqueIds(remainingOperationIds);
  const boardProgressCredited = boardDelta?.visibleBoardChange === true;
  if (failedOperationId || remaining.length) {
    return {
      schema: WORKFLOW_RECEIPT_SCHEMA,
      mode,
      disposition: 'RECONCILE_EXACT_OPERATION',
      replayPolicy: 'DO_NOT_REPLAY',
      resumePolicy: 'REBUILD_REMAINING_SUFFIX',
      boardProgressCredited,
      broadAuditAllowed: false,
      returnToParentStage: true,
      minimumReadScope: exactReadScope(failedOperationId),
      failedOperationId,
      remainingOperationIds: remaining,
      requiredNextAction: 'Read only the failed operation or its exact live object, remove confirmed IDs, prepare a new guard, and execute only the remaining suffix. Then resume the saved parent PCB action.',
    };
  }
  if (mode === 'validate') {
    return {
      schema: WORKFLOW_RECEIPT_SCHEMA,
      mode,
      disposition: 'NO_BOARD_CHANGE',
      replayPolicy: 'NOT_APPLICABLE',
      resumePolicy: 'PREPARE_VALIDATED_PLAN',
      boardProgressCredited: false,
      broadAuditAllowed: false,
      returnToParentStage: true,
      minimumReadScope: { kind: 'NONE' },
      failedOperationId: null,
      remainingOperationIds: [],
      requiredNextAction: 'Prepare the validated plan against the same target; validation is not PCB progress.',
    };
  }
  if (mode === 'prepare') {
    return {
      schema: WORKFLOW_RECEIPT_SCHEMA,
      mode,
      disposition: 'NO_BOARD_CHANGE',
      replayPolicy: 'NOT_APPLICABLE',
      resumePolicy: 'EXECUTE_PREPARED_PLAN',
      boardProgressCredited: false,
      broadAuditAllowed: false,
      returnToParentStage: true,
      minimumReadScope: { kind: 'NONE' },
      failedOperationId: null,
      remainingOperationIds: [],
      requiredNextAction: 'Execute the prepared plan with its returned guard; preparation is not PCB progress.',
    };
  }
  if (boardProgressCredited) {
    return {
      schema: WORKFLOW_RECEIPT_SCHEMA,
      mode,
      disposition: 'CONTINUE_BOARD',
      replayPolicy: 'NEXT_DEPENDENCY_READY',
      resumePolicy: 'EXECUTE_NEXT_BOARD_ACTION',
      boardProgressCredited: true,
      broadAuditAllowed: false,
      returnToParentStage: true,
      minimumReadScope: { kind: 'NONE' },
      failedOperationId: null,
      remainingOperationIds: [],
      requiredNextAction: 'Record the changed PCB objects and execute the next dependency-ready board action. Delay broad audits until the stage boundary.',
    };
  }
  return {
    schema: WORKFLOW_RECEIPT_SCHEMA,
    mode,
    disposition: 'NO_BOARD_CHANGE',
    replayPolicy: 'DO_NOT_REPLAY',
    resumePolicy: 'EXECUTE_NEXT_BOARD_ACTION',
    boardProgressCredited: false,
    broadAuditAllowed: false,
    returnToParentStage: true,
    minimumReadScope: exactReadScope(null, boardDelta?.unchangedOperationIds),
    failedOperationId: null,
    remainingOperationIds: [],
    requiredNextAction: 'Do not report PCB progress or repeat broad reads. Reconcile the unchanged exact objects once, then execute the next dependency-ready board action or switch to an independent region.',
  };
}

/** Tell callers how to reconcile an unknown native outcome without expanding into a broad audit. */
export function createRecoveryDirective({
  errorCode = 'UNKNOWN',
  executionId = null,
  failedOperationId = null,
  remainingOperationIds = [],
  confirmedOperationNames = [],
} = {}) {
  const remaining = uniqueIds(remainingOperationIds);
  return {
    schema: RECOVERY_DIRECTIVE_SCHEMA,
    disposition: 'RECONCILE_EXACT_OPERATION',
    replayPolicy: 'DO_NOT_REPLAY',
    resumePolicy: remaining.length ? 'REBUILD_REMAINING_SUFFIX' : 'RESUME_SAVED_BOARD_ACTION',
    boardProgressCredited: false,
    broadAuditAllowed: false,
    returnToParentStage: true,
    resumeSavedBoardAction: true,
    errorCode,
    executionId,
    failedOperationId,
    remainingOperationIds: remaining,
    confirmedOperationNames: uniqueIds(confirmedOperationNames),
    minimumReadScope: exactReadScope(failedOperationId),
    localBridgeFastPath: {
      applicable: transientBridgeCodes.has(errorCode),
      healthProbeLimit: 2,
      directedRepairLimit: 1,
      restartPolicy: 'ONLY_AFTER_FAILED_HEALTH_OR_TARGET_PROBE',
      healthyProbeAction: 'RECONCILE_EXACT_STATE_AND_RESUME_PARENT',
    },
    requiredNextAction: 'Read the minimum exact live state needed to determine side effects. Never replay the unknown operation. Rebuild only unfinished work, then resume the saved parent PCB action.',
  };
}

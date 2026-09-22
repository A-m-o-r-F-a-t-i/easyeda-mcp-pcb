import { assertAllowedTarget, saveAndCheck } from './bridge.mjs';
import { prepareSchematicSync } from './advanced.mjs';
import { compareAssociatedNetlists } from './netlist-compare.mjs';

export async function verifyApiGates({ target, expectedSchematicUuid, drcDetailLimit = 100, netlistDetailLimit = 100, bridgeUrl = null }) {
  assertAllowedTarget(target);
  if (!target?.documentUuid || !target?.projectUuid || !target?.windowId) throw Error('API gate verification requires exact project/document/window');
  if (!Number.isInteger(drcDetailLimit) || drcDetailLimit < 0 || drcDetailLimit > 1000) throw Error('drcDetailLimit must be 0..1000');
  if (!Number.isInteger(netlistDetailLimit) || netlistDetailLimit < 0 || netlistDetailLimit > 1000) throw Error('netlistDetailLimit must be 0..1000');

  const before = await prepareSchematicSync({ target, bridgeUrl });
  if (expectedSchematicUuid && before.association.schematicUuid !== expectedSchematicUuid) throw Error('Associated schematic UUID does not match expectedSchematicUuid');
  const netlist = await compareAssociatedNetlists({
    target,
    expectedSchematicUuid: expectedSchematicUuid ?? before.association.schematicUuid,
    offset: 0,
    limit: netlistDetailLimit,
    bridgeUrl,
  });
  const drc = await saveAndCheck({ target, bridgeUrl, save: false, runDrc: true, drcDetailLimit });
  const after = await prepareSchematicSync({ target, bridgeUrl });

  const stateStableAcrossChecks = before.digest === after.digest;
  const associationStable = JSON.stringify(before.association) === JSON.stringify(after.association)
    && before.association.schematicUuid === netlist.association.schematicUuid;
  const gates = {
    exactTargetVerified: true,
    twoPassStateReadsBefore: true,
    twoPassStateReadsAfter: true,
    stateStableAcrossChecks,
    associationStable,
    drcVerified: drc.drcVerified === true,
    drcPassed: drc.drcPassed === true,
    associatedNetlistCompared: netlist.stableReads === 2,
    associatedNetlistInSync: netlist.inSync === true,
  };
  const verificationComplete = gates.stateStableAcrossChecks && gates.associationStable && gates.drcVerified && gates.associatedNetlistCompared;
  const allApiGatesPassed = verificationComplete && gates.drcPassed && gates.associatedNetlistInSync;
  return {
    ok: true,
    bridge: before.bridge,
    verificationComplete,
    allApiGatesPassed,
    engineeringRelease: allApiGatesPassed ? 'API_GATES_PASSED_VISUAL_AND_ENGINEERING_REVIEW_REQUIRED' : 'API_GATES_FAILED',
    gates,
    target: { projectUuid: target.projectUuid, documentUuid: target.documentUuid, windowId: target.windowId },
    association: after.association,
    state: {
      beforeDigest: before.digest,
      afterDigest: after.digest,
      stableAcrossChecks: stateStableAcrossChecks,
      beforeCounts: before.counts,
      afterCounts: after.counts,
    },
    drc: {
      state: drc.drcState,
      jobId: drc.drcJobId,
      verified: drc.drcVerified,
      passed: drc.drcPassed,
      total: drc.drcErrorCount,
      detailLimit: drcDetailLimit,
      offset: drc.drcItemsOffset ?? 0,
      items: Array.isArray(drc.drcItems) ? drc.drcItems : [],
      hasMore: drc.drcItemsHasMore === true,
      nextOffset: drc.drcItemsNextOffset ?? null,
      summary: drc.drcSummary,
      nextAction: drc.nextAction ?? null,
    },
    netlist: {
      stableReads: netlist.stableReads,
      inSync: netlist.inSync,
      total: netlist.total,
      counts: netlist.counts,
      detailLimit: netlistDetailLimit,
      items: netlist.items,
      hasMore: netlist.hasMore,
    },
    pcbModified: false,
    limitations: [
      'These gates cover stable typed PCB state, native DRC, and associated schematic/PCB logical netlist equality.',
      'They do not independently count ratlines or prove routed copper topology, current capacity, thermal behavior, signal integrity, mechanical fit, connector mating view, silkscreen glyph clearance, 3D assembly, or manufacturing output quality.',
      'A passing result therefore remains an API verification milestone, not unconditional engineering release.',
    ],
  };
}

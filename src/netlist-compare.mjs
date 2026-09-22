import { assertAllowedTarget, executeBridgeCode, resolveBridge } from './bridge.mjs';

// Serialized into the EasyEDA extension context. Keep this function free of Node-only APIs.
export async function compareAssociatedNetlistsRuntime(eda, request) {
  if (!request?.target?.documentUuid || !request?.target?.projectUuid) throw Error('Netlist comparison requires exact project/document');
  if (!Number.isInteger(request.offset) || request.offset < 0) throw Error('Invalid comparison offset');
  if (!Number.isInteger(request.limit) || request.limit < 0 || request.limit > 1000) throw Error('Invalid comparison limit');

  const guard = async () => {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    if (document?.uuid !== request.target.documentUuid || document?.documentType !== 3) throw Error('PCB document/type changed during netlist comparison');
    if (project?.uuid !== request.target.projectUuid) throw Error('PCB project changed during netlist comparison');
    const matches = (project?.data ?? []).filter(item => item?.pcb?.uuid === document.uuid);
    if (matches.length !== 1 || !matches[0]?.schematic?.uuid) throw Error('Exactly one associated schematic is required for the target PCB');
    const board = matches[0];
    const association = {
      projectUuid: project.uuid,
      projectName: project.name ?? null,
      boardName: board.name ?? null,
      pcbUuid: board.pcb.uuid,
      pcbName: board.pcb.name ?? null,
      schematicUuid: board.schematic.uuid,
      schematicName: board.schematic.name ?? null,
    };
    if (request.expectedSchematicUuid && association.schematicUuid !== request.expectedSchematicUuid) throw Error('Associated schematic UUID does not match expectedSchematicUuid');
    return { document, association };
  };

  if (typeof eda.sys_Tool?.netlistComparison !== 'function') throw Error('Public netlistComparison API unavailable');
  const normalize = (raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(`Invalid netlist difference at index ${index}; valueType=${Array.isArray(raw) ? 'array' : typeof raw}`);
    const nativeType = typeof raw.type === 'string' ? raw.type.toUpperCase() : null;
    const type = nativeType === 'NET' ? 'Net' : nativeType === 'COMPONENT' ? 'Component' : null;
    if (!type || typeof raw.object !== 'string') throw Error(`Invalid netlist difference identity at index ${index}; keys=${Object.keys(raw).sort().join(',')}; type=${String(raw.type)}`);
    const left = raw.netlist1Name ?? raw.net1;
    const right = raw.netlist2Name ?? raw.net2;
    if (!Array.isArray(left) || !Array.isArray(right) || left.some(value => typeof value !== 'string') || right.some(value => typeof value !== 'string')) throw Error(`Invalid netlist difference entries at index ${index}; keys=${Object.keys(raw).sort().join(',')}`);
    return {
      type,
      object: raw.object,
      schematicEntries: [...new Set(left)].sort(),
      pcbEntries: [...new Set(right)].sort(),
    };
  };
  const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item);
  const state = (object, key) => {
    if (object == null) return undefined;
    const getter = object['getState_' + key[0].toUpperCase() + key.slice(1)];
    return typeof getter === 'function' ? getter.call(object) : object[key];
  };
  const normalizedNetName = object => {
    if (typeof object !== 'string') return null;
    if (object.length >= 2 && object.startsWith("'") && object.endsWith("'")) return object.slice(1, -1);
    return object;
  };
  const readPcbNetMembership = async () => {
    if (typeof eda.pcb_PrimitiveComponent?.getAll !== 'function' || typeof eda.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId !== 'function') return null;
    const components = await eda.pcb_PrimitiveComponent.getAll();
    if (!Array.isArray(components)) return null;
    const membership = new Map();
    for (const component of components) {
      const componentId = state(component, 'primitiveId');
      const designator = state(component, 'designator');
      if (typeof componentId !== 'string' || !componentId || typeof designator !== 'string' || !designator) continue;
      const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId);
      if (!Array.isArray(pins)) return null;
      for (const pin of pins) {
        const padNumber = state(pin, 'padNumber');
        const net = state(pin, 'net');
        if (padNumber == null || String(padNumber) === '' || typeof net !== 'string' || !net) continue;
        if (!membership.has(net)) membership.set(net, new Set());
        membership.get(net).add(designator + '.' + String(padNumber));
      }
    }
    return new Map([...membership].map(([net, entries]) => [net, [...entries].sort()]));
  };
  const reconcileNetDifferences = async differences => {
    const membership = await readPcbNetMembership();
    if (!membership) return { differences, pcbNetMembershipVerified: false };
    const reconciled = [];
    for (const difference of differences) {
      if (difference.type !== 'Net') {
        reconciled.push(difference);
        continue;
      }
      const netName = normalizedNetName(difference.object);
      if (!membership.has(netName)) {
        reconciled.push(difference);
        continue;
      }
      const pcbEntries = membership.get(netName);
      if (stable(difference.schematicEntries) === stable(pcbEntries)) continue;
      reconciled.push({ ...difference, pcbEntries });
    }
    return { differences: reconciled, pcbNetMembershipVerified: true };
  };
  const take = async () => {
    const { association } = await guard();
    const raw = await eda.sys_Tool.netlistComparison(association.schematicUuid, request.target.documentUuid);
    if (!Array.isArray(raw)) throw Error('Invalid netlistComparison response: expected an array');
    const nativeDifferences = raw.map(normalize).sort((a, b) => a.type.localeCompare(b.type) || a.object.localeCompare(b.object) || stable(a).localeCompare(stable(b)));
    const reconciled = await reconcileNetDifferences(nativeDifferences);
    const differences = reconciled.differences.sort((a, b) => a.type.localeCompare(b.type) || a.object.localeCompare(b.object) || stable(a).localeCompare(stable(b)));
    await guard();
    return { association, differences, nativeDifferenceCount: nativeDifferences.length, pcbNetMembershipVerified: reconciled.pcbNetMembershipVerified };
  };

  const first = await take();
  const second = await take();
  if (stable(first) !== stable(second)) throw Error('Schematic/PCB netlist comparison changed during two reads');
  const total = second.differences.length;
  const counts = second.differences.reduce((output, item) => {
    output[item.type === 'Net' ? 'net' : 'component'] += 1;
    return output;
  }, { net: 0, component: 0 });
  return {
    association: second.association,
    comparison: { netlist1: 'associated-schematic', netlist2: 'target-pcb' },
    stableReads: 2,
    nativeDifferenceCount: second.nativeDifferenceCount,
    pcbNetMembershipVerified: second.pcbNetMembershipVerified,
    total,
    counts,
    inSync: total === 0,
    offset: request.offset,
    limit: request.limit,
    items: second.differences.slice(request.offset, request.offset + request.limit),
    hasMore: request.offset + request.limit < total,
    limitations: [
      'Native net differences are reconciled against actual PCB component-pin net readback when that API is available; component differences remain native comparison results.',
      'This validates logical component/pin net membership, not routed copper connectivity, power integrity, signal integrity, current capacity, placement, or silkscreen.',
    ],
  };
}

export async function compareAssociatedNetlists({ target, expectedSchematicUuid, offset = 0, limit = 100, bridgeUrl = null }) {
  assertAllowedTarget(target);
  if (!target?.documentUuid || !target?.projectUuid || !target?.windowId) throw Error('Netlist comparison requires exact project/document/window');
  if (!Number.isInteger(offset) || offset < 0) throw Error('offset must be a nonnegative integer');
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) throw Error('limit must be 0..1000');
  const bridge = await resolveBridge({ bridgeUrl, windowId: target.windowId, requireEda: true });
  const request = { target, expectedSchematicUuid: expectedSchematicUuid ?? null, offset, limit };
  const result = await executeBridgeCode(bridge, `return await (${compareAssociatedNetlistsRuntime.toString()})(eda,${JSON.stringify(request)});`, 180_000);
  return { ok: true, bridge: { baseUrl: bridge.baseUrl, windowId: bridge.windowId }, ...result };
}

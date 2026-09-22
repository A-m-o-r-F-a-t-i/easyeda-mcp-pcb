// Serialized into the EasyEDA extension context. Keep this file free of Node imports.
export async function componentCleanupRuntime(eda, job) {
  const target = job.target;
  const componentFields = ['primitiveId', 'uniqueId', 'designator', 'x', 'y', 'rotation', 'layer', 'primitiveLock'];
  const attributeFields = ['primitiveId', 'parentPrimitiveId', 'layer', 'x', 'y', 'key', 'value', 'keyVisible', 'valueVisible', 'fontFamily', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock'];
  const stringFields = ['primitiveId', 'layer', 'x', 'y', 'text', 'fontFamily', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock'];
  const state = (object, key) => {
    if (object == null) return undefined;
    const getter = object[`getState_${key[0].toUpperCase()}${key.slice(1)}`];
    const value = typeof getter === 'function' ? getter.call(object) : object[key];
    return value === undefined && key === 'primitiveLock' ? false : value;
  };
  const plain = (object, fields) => Object.fromEntries(fields.map(key => [key, state(object, key) ?? null]));
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sorted = rows => rows.sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId)));
  const requireArray = (value, label) => {
    if (!Array.isArray(value)) throw new Error(`${label} enumeration unavailable`);
    if (value.length > 5000) throw new Error(`${label} count exceeds guarded cleanup limit`);
    return value;
  };
  const guard = async () => {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (document?.uuid !== target.documentUuid || document?.documentType !== 3) throw new Error('PCB document/type mismatch');
    if (target.projectUuid) {
      const project = await eda.dmt_Project.getCurrentProjectInfo();
      if (project?.uuid !== target.projectUuid) throw new Error('PCB project mismatch');
    }
  };
  const collect = async () => {
    await guard();
    const componentApi = eda.pcb_PrimitiveComponent;
    const attributeApi = eda.pcb_PrimitiveAttribute;
    const stringApi = eda.pcb_PrimitiveString;
    if (!componentApi?.getAll || !attributeApi?.getAll || !stringApi?.getAll) throw new Error('Required component/text enumeration API unavailable');
    const components = sorted(requireArray(await componentApi.getAll(), 'Component').map(item => plain(item, componentFields)));
    const attributes = sorted(requireArray(await attributeApi.getAll(), 'Attribute').map(item => plain(item, attributeFields)));
    const strings = sorted(requireArray(await stringApi.getAll(), 'String').map(item => plain(item, stringFields)));
    const componentIds = new Set(components.map(item => item.primitiveId));
    if (componentIds.has(null) || componentIds.size !== components.length) throw new Error('Component identity is missing or duplicated');
    const attributeIds = new Set(attributes.map(item => item.primitiveId));
    if (attributeIds.has(null) || attributeIds.size !== attributes.length) throw new Error('Attribute identity is missing or duplicated');
    const stringIds = new Set(strings.map(item => item.primitiveId));
    if (stringIds.has(null) || stringIds.size !== strings.length) throw new Error('String identity is missing or duplicated');
    const lockedComponents = components.filter(item => item.primitiveLock === true);
    const designatorAttributes = attributes.filter(item => item.key === 'Designator' && componentIds.has(item.parentPrimitiveId));
    const visibleDesignatorAttributes = designatorAttributes.filter(item => item.keyVisible === true || item.valueVisible === true);
    return {
      components,
      attributes,
      strings,
      lockedComponentIds: lockedComponents.map(item => item.primitiveId),
      designatorAttributeIds: designatorAttributes.map(item => item.primitiveId),
      visibleDesignatorAttributeIds: visibleDesignatorAttributes.map(item => item.primitiveId),
      counts: {
        components: components.length,
        lockedComponents: lockedComponents.length,
        attributes: attributes.length,
        designatorAttributes: designatorAttributes.length,
        visibleDesignatorAttributes: visibleDesignatorAttributes.length,
        hiddenDesignatorAttributes: designatorAttributes.length - visibleDesignatorAttributes.length,
        independentStrings: strings.length,
      },
    };
  };

  const before = await collect();
  if (job.mode === 'preview') return { ok: true, preview: before, wrotePCB: false };
  if (job.mode !== 'execute') throw new Error('Cleanup mode must be preview or execute');
  if (!same(before, job.expectedPreview)) return { ok: false, wrotePCB: false, results: [], completedCount: 0, error: { message: 'Cleanup preview changed before execution' } };

  const unlockComponents = job.unlockComponents !== false;
  const deleteReferenceDesignators = job.deleteReferenceDesignators !== false;
  if (!unlockComponents && !deleteReferenceDesignators) throw new Error('At least one cleanup action is required');
  const componentApi = eda.pcb_PrimitiveComponent;
  const attributeApi = eda.pcb_PrimitiveAttribute;
  const results = [];
  try {
    if (unlockComponents) {
      if (!componentApi?.get || !componentApi?.modify) throw new Error('Component modify API unavailable');
      for (const expected of before.components.filter(item => item.primitiveLock === true)) {
        await guard();
        let current = await componentApi.get(expected.primitiveId);
        if (!current || !same(plain(current, componentFields), expected)) throw new Error(`Component ${expected.primitiveId} changed before unlock`);
        await guard();
        const returned = await componentApi.modify(expected.primitiveId, { primitiveLock: false });
        current = await componentApi.get(state(returned, 'primitiveId') || expected.primitiveId);
        const desired = { ...expected, primitiveLock: false };
        if (!current || !same(plain(current, componentFields), desired)) throw new Error(`Component ${expected.primitiveId} unlock failed readback`);
        results.push({ type: 'component.unlock', status: 'unlocked', primitiveId: expected.primitiveId, designator: expected.designator, verified: true });
      }
    }

    if (deleteReferenceDesignators) {
      if (!attributeApi?.get || !attributeApi?.modify) throw new Error('Attribute modify API unavailable');
      const visibleDesignatorIds = new Set(before.visibleDesignatorAttributeIds);
      for (const expected of before.attributes.filter(item => visibleDesignatorIds.has(item.primitiveId))) {
        await guard();
        let current = await attributeApi.get(expected.primitiveId);
        if (!current || !same(plain(current, attributeFields), expected)) throw new Error(`Designator attribute ${expected.primitiveId} changed before silkscreen removal`);
        const desired = { ...expected, keyVisible: false, valueVisible: false, primitiveLock: false };
        await guard();
        const returned = await attributeApi.modify(expected.primitiveId, { keyVisible: false, valueVisible: false, primitiveLock: false });
        current = await attributeApi.get(state(returned, 'primitiveId') || expected.primitiveId);
        if (!current || !same(plain(current, attributeFields), desired)) throw new Error(`Designator attribute ${expected.primitiveId} silkscreen removal failed readback`);
        results.push({ type: 'attribute.remove-designator-silkscreen', status: 'hidden', primitiveId: expected.primitiveId, parentPrimitiveId: expected.parentPrimitiveId, value: expected.value, verified: true });
      }
    }

    const after = await collect();
    const expectedComponents = before.components.map(item => unlockComponents ? { ...item, primitiveLock: false } : item);
    const hidden = new Set(deleteReferenceDesignators ? before.visibleDesignatorAttributeIds : []);
    const expectedAttributes = before.attributes.map(item => hidden.has(item.primitiveId)
      ? { ...item, keyVisible: false, valueVisible: false, primitiveLock: false }
      : item);
    if (!same(after.components, expectedComponents)) throw new Error('Component identity or geometry changed outside lock cleanup');
    if (!same(after.attributes, expectedAttributes)) throw new Error('Attribute identity or presentation changed outside requested designator silkscreen removal');
    if (!same(after.strings, before.strings)) throw new Error('Independent silkscreen strings changed during cleanup');
    return {
      ok: true,
      wrotePCB: results.length > 0,
      completedCount: results.length,
      results,
      beforeCounts: before.counts,
      afterCounts: after.counts,
      verification: {
        allComponentsUnlocked: !unlockComponents || after.lockedComponentIds.length === 0,
        allComponentDesignatorSilkscreenRemoved: !deleteReferenceDesignators || after.visibleDesignatorAttributeIds.length === 0,
        componentDesignatorIdentityPreserved: true,
        independentStringsUnchanged: true,
        nonDesignatorAttributesUnchanged: true,
        componentIdentityAndGeometryUnchanged: true,
      },
    };
  } catch (error) {
    return {
      ok: false,
      wrotePCB: results.length > 0,
      completedCount: results.length,
      results,
      error: { message: String(error?.message ?? error) },
    };
  }
}

export const buildComponentCleanupCode = job => `return await (${componentCleanupRuntime.toString()})(eda,${JSON.stringify(job)});`;

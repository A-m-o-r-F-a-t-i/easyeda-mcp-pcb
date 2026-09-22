/**
 * Validate and summarize EasyEDA native verbose DRC output.
 *
 * The native response is a nested UI tree. Group nodes are not violations.
 * Every leaf is counted, while only the requested page is copied into items so
 * a large board cannot make one MCP response duplicate the complete native tree.
 */
export function summarizeDrcReport(raw, { offset = 0, limit = 100 } = {}) {
  if (!Array.isArray(raw)) throw new Error('Invalid verbose DRC response: expected an error array');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('DRC detail offset must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new Error('DRC detail limit must be an integer from 0 to 1000');

  const items = [];
  const active = new Set();
  const seenIds = new Set();
  const countsByCategory = Object.create(null);
  const countsByRule = Object.create(null);
  const countsByObjectType = Object.create(null);
  const countsByLayer = Object.create(null);
  const countsByErrorType = Object.create(null);
  const countsByRuleType = Object.create(null);
  let visitedNodes = 0;
  let groupCount = 0;
  let total = 0;
  let visibleFindingCount = 0;
  let hiddenFindingCount = 0;

  const increment = (record, key) => {
    const normalized = String(key ?? 'Unspecified');
    record[normalized] = (record[normalized] ?? 0) + 1;
  };

  const walk = (nodes, path, depth) => {
    if (depth > 32) throw new Error('DRC grouping depth exceeds supported limit');
    for (const node of nodes) {
      if (++visitedNodes > 200000) throw new Error('DRC report exceeds supported node limit');
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid DRC report node');
      if (active.has(node)) throw new Error('Cyclic DRC report');
      active.add(node);

      if (Object.hasOwn(node, 'list')) {
        if (!Array.isArray(node.list)) throw new Error('Invalid DRC group list; cannot treat unreadable entries as empty');
        groupCount += 1;
        walk(node.list, [...path, String(node.name ?? node.title ?? 'unnamed group')], depth + 1);
      } else {
        if (!Object.keys(node).length) throw new Error('Empty DRC finding has no diagnostic identity');
        const id = node.globalIndex;
        if ((typeof id === 'string' || typeof id === 'number') && String(id)) {
          const normalizedId = String(id);
          if (seenIds.has(normalizedId)) throw new Error(`Duplicate DRC finding identity: ${normalizedId}`);
          seenIds.add(normalizedId);
        }

        const findingIndex = total;
        total += 1;
        const category = path[0] ?? node.errorType ?? 'Ungrouped';
        const rule = node.ruleName ?? node.errorObjType ?? node.name ?? 'Unspecified';
        increment(countsByCategory, category);
        increment(countsByRule, rule);
        increment(countsByObjectType, node.errorObjType);
        increment(countsByLayer, node.layer);
        increment(countsByErrorType, node.errorType);
        increment(countsByRuleType, node.ruleTypeName);
        if (node.visible === false) hiddenFindingCount += 1;
        else visibleFindingCount += 1;

        if (findingIndex >= offset && items.length < limit) {
          items.push({ ...node, categoryPath: [...path], findingIndex });
        }
      }
      active.delete(node);
    }
  };

  walk(raw, [], 0);
  const returned = items.length;
  const nextOffset = offset + returned;
  const hasMore = nextOffset < total;
  return {
    verified: true,
    total,
    topLevelCount: raw.length,
    groupCount,
    visitedNodes,
    visibleFindingCount,
    hiddenFindingCount,
    countsByCategory,
    countsByRule,
    countsByObjectType,
    countsByLayer,
    countsByErrorType,
    countsByRuleType,
    items,
    page: {
      offset,
      limit,
      returned,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
      detailsComplete: offset === 0 && !hasMore,
    },
  };
}

# EasyEDA PCB MCP 2.4.10

Typed PCB tools over a local EasyEDA Pro Bridge, exposed as a compact 21-tool production profile plus diagnostics and legacy compatibility profiles. The executor applies explicit design decisions, reads actual results and rejects stale targets or old-state assertions. Version 2.4.9 makes verbose native DRC resumable and bounded: the EasyEDA window retains the native result under a job ID, the MCP returns `RUNNING` instead of timing out, and completed calls return full counts and category/rule/object/layer summaries with paged native violation details instead of duplicating the complete native tree. Invalid, missing, expired or failed native results remain explicitly unverified. Version 2.4.8 fixed the live-client component cleanup adapter while preserving mandatory `Designator` identity. True native circular board outlines, closed polygon outlines, standalone PTH/NPTH round or slot objects, networked terminal pads, `boardDelta`, machine-readable `workflowReceipt`, exact-operation `recoveryDirective` and resumable partial batches remain supported. The service does not expose automatic placement, path search, automatic routing, route clearing, order placement, arbitrary JavaScript or whole-rule-table overwrite.

## Installation and verification

Version 2.4.10 keeps timed-out DRC jobs terminal even when a native callback arrives late, distinguishes an unavailable native API from a failed invocation, and records synchronous checker attempts correctly. Both DRC entry points accept at most 250 detail items per page; complete totals remain independent of the requested page.

Requires Node.js >=22, an already authorized local EasyEDA Bridge and an explicitly selected PCB. Install locked dependencies and run:

```text
npm ci
npm test
npm run smoke
node src/server.mjs
```

The SDK capability-registry tests automatically locate `skills/easyeda-api` in the aggregate repository, a sibling `easyeda-skill-api` clone, or the legacy development directory. For another standalone layout, point `EASYEDA_API_SKILL_ROOT` at the API Skill root or set `EASYEDA_API_REFERENCES_ROOT` directly to its `references` directory.

The server uses stdio; diagnostics go to stderr. Register a new immutable version directory during concurrent work rather than replacing a running production instance. Optional `EASYEDA_ALLOWED_PROJECT_UUIDS` is a JSON array of project IDs in the child-process environment. A constrained instance requires explicit project and window IDs. Never change a shared active window to make a test pass.

## Responsibility split

The MCP owns execution and data verification. `easyeda-pcb-layout-routing` owns layout/routing choices, stackup, current, return paths, silkscreen and engineering acceptance. `easyeda-api` owns generic Bridge/API documentation. Browser control supplies additional views, assembly and unsupported native UI workflows; it is not the default route for functions already implemented by these tools.

## Tools

| Tools | Purpose and limits |
| --- | --- |
| `pcb_list_targets`, `pcb_open_target` | Discover identities without global selection; guarded open within the explicitly selected project/window. |
| `pcb_status`, `pcb_read` | Exact target and typed object data; failed reads are errors, not invented empty collections. |
| `pcb_capabilities`, `pcb_pick` | Method discovery and native/typed geometric queries. Method existence is not a functional test. Capability output also states which high-risk SDK methods remain intentionally unexposed. |
| `pcb_compare_associated_netlists` | Two stable public-API comparisons between the exact associated schematic and PCB. Reports logical component/net differences without ECO UI; does not prove routed copper connectivity. |
| `pcb_validate_plan`, `pcb_execute_plan` | Explicit `easyeda-pcb-plan/v2` native circular or closed polygon outlines, standalone PTH/NPTH round or slot pads, networked terminal pads, component moves, lines, through-vias and pour boundaries with guarded modifications/deletions. Partial failures preserve a verified prefix and return the remaining suffix. |
| `pcb_validate_text_plan`, `pcb_execute_text_plan` | `easyeda-pcb-text-plan/v1` strings and attribute presentation. Attribute key/value changes are rejected; use separate functional labels. |
| `pcb_cleanup_components` | Preflight or execute one guarded bulk cleanup that unlocks components and removes only the visible reference-designator silkscreen. It preserves the mandatory attached `Designator` attribute ID/value, ordinary strings, non-designator attributes, component identity and geometry. |
| `pcb_rebuild_pours` | Native repour plus actual fill association, missing/unverified fills and non-target fill-change reporting. |
| `pcb_read_constraints`, `pcb_manage_constraint_group` | Canonical rules and guarded net-class, differential, equal-length and pad-pair operations. |
| `pcb_realtime_drc`, `pcb_save_and_drc`, `pcb_verify_api_gates` | Native status/control and resumable verbose DRC. `COMPLETED` reports the full violation total and summaries with a bounded detail page; `RUNNING` returns `drcJobId` for `save=false` continuation. The read-only gate still requires visual, topology, current, SI, mechanical and manufacturing review. |
| `pcb_prepare_schematic_sync`, `pcb_import_schematic_changes` | Associated source, stable PCB digest, guarded import and before/after readback. No selective native ECO preview. |
| `pcb_audit_geometry` | Straight-segment directions and ordinary/pad/via/branch joints. No electrical or thermal approval. |
| `pcb_inspect_silkscreen` | Default page inspection; `scope="all"` compares all selected visible BBoxes across pages after two consistent full reads. |
| `pcb_inspect_pinmap` | Explicit IDs or unique designators, real pad numbers/nets/positions, stable double read, optional expected mappings. |
| `pcb_capture_snapshot` | All twelve supported primitive categories, component and standalone pads, netlist, layers and constraints, saved to a new local JSON with byte verification. |
| `pcb_compare_snapshots` | Complete-array field comparison with missing categories/metadata and sensitive attribute semantics disclosed. |
| `pcb_export_backup`, `pcb_export_manufacturing` | Native EPRO plus bounded Gerber, pick-and-place, BOM, test-point, netlist and IPC-D-356A export to new local files. No overwrite, dialog, upload or order action. |
| `pcb_capture_view`, `pcb_capture_inspection_view` | Exact-tab current-viewport PNG transfer without pan, zoom, tab activation or selection changes. The inspection variant may isolate currently enabled layers and returns success only after exact API-visible layer-state restoration. |
| `pcb_render_inspection_svg` | Full-board or explicit-region SVG generated from two matching typed snapshots. Supports visible/all/explicit layers and optional designators without changing editor viewport, focus, selection or layer state. |

## Window reconnect recovery

EasyEDA may rebuild its local Gateway window identity after `openDocument` or a native schematic import. Version 2.3.0 does not replay an operation whose response was lost. `pcb_open_target` polls connected windows and succeeds only when exactly one window exposes the same project UUID and PCB document UUID. Duplicate matches remain an error.

For guarded schematic import, the MCP-owned confirmation runtime may write outside the older typed Gateway adapter. Version 2.3.1 advances the guarded state only after Protocol v2 independently observes the same generation with a newer document epoch and a changed source hash; save and final guards then use that adopted state. A lost native response can still be reconciled only when the recovered exact PCB has a changed synchronization digest, the expected associated schematic, all supplied ECO postconditions, zero remaining associated-netlist differences, a successful save when requested, and a stable final readback. The result reports `recoveredAfterWindowReconnect`, `replayAvoided`, the old/new window IDs and `verified-reconnect-readback`. Any missing condition preserves the unknown outcome and requires inspection before retry.

## Important execution contracts

Mutations re-read expected object/group state after asynchronous preflight, as well as validating target identity. Public APIs do not provide a cross-client transaction lock; final readback remains necessary.

### Native circular board outline

Use a native circle whenever the required board frame is circular. `diameter` and `position` use the plan-level units:

```json
{
  "id": "board-outline",
  "type": "outline.create",
  "shape": "CIRCLE",
  "position": [0, 0],
  "diameter": 48,
  "width": 0.1,
  "locked": true
}
```

The plan compiler emits `['CIRCLE', cx, cy, radius]` on `BOARD_OUTLINE`. `points` cannot be supplied with the circular form. A polygon with the same bounding box is not equivalent and does not satisfy idempotent readback.

Complete typed snapshots are complete only for the supported fields and categories. Their coverage is explicit and they are not native backups. Snapshot comparison separately reports `missingKinds`, `missingData`, `changedData` and `sensitiveAttributeChangeCount`. Do not infer unchanged electrical identity from the name of an attribute category.

Silkscreen `scope="all"` checks cross-page pairs; `offset` and `limit` paginate the returned details only. Inspect `evaluatedObjectCount`, `warningCounts`, `overlapCount` and `overlapDetailsTruncated`. BBoxes identify candidates, not precise glyph collisions, solder-mask clearance or assembly readability.

Pin maps return board/API coordinates and actual side/rotation. They do not infer the connector mating view. `allExpectedMatch=null` means no expected mapping was supplied; a successfully executed mismatch check remains an electrical mismatch.

Pour polygons use simple-ring geometric equivalence under cyclic vertex shifts and reversed winding, with coordinate tolerance. Equal BBoxes are not sufficient. Unknown curves/multiple rings are not silently treated as equivalent.

A pour create may specify `priorityPolicy:"native"` without a priority number to accept editor-assigned ordering. Omitting both priority fields has the same meaning. Supplying a numeric `priority` keeps an exact requirement. Native mode returns `actualPriorities` and `requiresPriorityReview`; overlapping pours still need review. A native policy plus a numeric priority is rejected.

Pad-pair endpoints are normalized as an unordered pair. Duplicate/reversed additions are no-ops; only true member deltas are sent. Removal uses the current native stored endpoint order. This normalization does not alter differential-pair positive/negative roles.

### Standalone holes, slots and terminal pads

Mechanical NPTH objects use `hole.create`. They compile to standalone `MULTI` pads with no copper annulus, no network and `metallization:false`:

```json
{
  "id": "mount-ne",
  "type": "hole.create",
  "position": [14.1421, 14.1421],
  "hole": { "type": "ROUND", "diameter": 2.8 },
  "locked": true
}
```

A rounded slot uses the same operation with `type:"SLOT"`, explicit diameter and total length. Rotate the complete pad with `rotation`; `holeRotation` is limited to 0 or 90 degrees. `hole.create` rejects electrical fields. Use `pad.create` for plated or networked terminals:

```json
{
  "id": "motor-u-terminal",
  "type": "pad.create",
  "layer": "MULTI",
  "padNumber": "U",
  "position": [0, -20],
  "shape": { "type": "OVAL", "width": 3.0, "height": 6.0 },
  "net": "MOTOR_U",
  "hole": { "type": "SLOT", "diameter": 1.5, "length": 4.0 },
  "metallization": true,
  "locked": true
}
```

All dimensions use the plan-level `units`. Plated pads must satisfy the plan annular-ring minimum; NPTH objects cannot carry a network. `pad.modify` and `pad.delete` require the complete expected old state, including pad and hole arrays, so a different connector or mechanical object cannot be changed by a stale plan.

EasyEDA Pro 4.1.60 stores the outer shape and `x`/`y` position of standalone pads on a 0.1 mil grid and may report a round drill as `['ROUND', diameter, diameter]` instead of the plan form `['ROUND', diameter]`. Bare NPTH objects may additionally canonicalize their non-electrical pad number by uppercasing and removing separators. Version 2.3.6 accepts these representations only for `hole.create` bare NPTH verification and the independent create verification of `pad.create` networked plated terminals. Position and outer-shape values must equal the exact decimal-grid rounding of the requested value; an adjacent 0.1 mil grid point is rejected even when it is close to the general geometry tolerance. A three-field round drill is accepted only when both native dimensions equal the requested diameter within the existing plan tolerance; typed reads return the canonical two-field form and preserve the original representation in `nativeHoleRaw`. Exact half-grid values such as 196.85 mil use the same decimal-grid rule as the client, avoiding a binary floating-point tie from being read back as the adjacent lower grid value. Layer, network, metallization, lock state, pad number, pad type and all other electrical identity fields remain independently required. Other client versions and standalone-pad modification/deletion guards keep exact comparison.

### Partial-batch continuation

When a batch stops after independently verifying earlier operations, the error returns `confirmedPlanOperations`, `failedOperationId`, `remainingOperationIds` and `nextAction`. Save/readback is retained for the verified prefix. Read the failed live object, remove already confirmed IDs, prepare a new guard and execute only the remaining suffix. Never replay the original full plan.

Every validation, preparation, successful geometry plan and partial prefix returns `workflowReceipt`. Its `disposition`, `replayPolicy`, `resumePolicy`, `minimumReadScope`, `boardProgressCredited` and `returnToParentStage` fields define the next safe action. Completed writes also return `boardDelta`: changed and unchanged operation counts, status counts, changed primitive count, changed kinds and operation IDs, remaining IDs, `visibleBoardChange`, `progressClass` and a next-action hint. Only `created`, `modified` and `deleted` operations count as board changes. `already_exists`, `already_modified`, `already_absent`, validate/prepare phases, tests and package deployment do not count as PCB progress.

When a guarded native operation fails before its outcome is known, `recoveryDirective` requires exact state reconciliation and sets `replayPolicy:"DO_NOT_REPLAY"`. For transient Bridge/target failures it also publishes a bounded fast path: at most two lightweight health/target probes and one directed repair, followed by exact reconciliation and return to the saved parent board action. The MCP does not authorize broad project audits, service reinstalls or unrelated tool-chain work as a substitute for that continuation.

## Observed EasyEDA Pro 3.2.186 boundaries

These are version-specific live observations, not universal SDK guarantees.

- Scalar pour `get(id)` may return an object for a nonexistent ID. Pour mutation/deletion verification uses the complete native list and exact IDs.
- The editor renumbers pour priorities and did not apply non-default outline widths in these tests. Exact numeric priority requests and outline widths other than 0.2 mil are rejected before writing on this client. Outline width is not copper-neck ampacity.
- A partial repour may change a non-requested fill. Use an all-boundary request or explicitly set `allowCollateralRebuild:true` after reviewing scope. Results expose `nonTargetFillChanges` and `scopeChangedOutsideRequest` alongside native identity anomalies.
- Constraint color alpha is normalized 0..1 at the tool boundary and converted for native creation. Net-class/equal-length member edits reset color to opaque black; accepting that side effect requires `allowColorReset:true`.
- Real-time DRC start/stop returned false and are not operational on the tested sample. The tool preserves the failure and before/after evidence; use full native DRC. `drcVerified`, `drcErrorCount` and `drcPassed` must be read separately from tool-call success.
- Native EPRO export can time out inside the Bridge even with a longer outer MCP timeout. Read target/file state before retrying, never overwrite an existing backup.
- The public parameter-free `dmt_EditorControl.zoomTo` viewport read fails on the tested 3.2.186 runtime, and the public API exposes no separate exact viewport-bounds getter. The MCP therefore does not claim reversible fit-all/fit-board/region viewport operations: current-view PNG never changes zoom, while full-board and regional inspection use two stable typed snapshots rendered to SVG.

## Tests and live regression

`npm test` runs the current offline/synthetic regression suite, including closed-outline, standalone-pad, physical-drill, partial-continuation and board-delta cases. `npm run smoke` verifies the real stdio protocol and the 21-tool production, 30-tool legacy and 3-tool diagnostics profiles. Neither command certifies every parameter combination in an actual editor.

The opt-in `test/live-read-probe.mjs`, `test/live-write-probe.mjs` and `test/live-eco-probe.mjs` use an explicit target JSON and existing output directory. The write/ECO probes require the `--disposable-board` argument and must only run on an authorized disposable board with a verified native backup. Read the script first. Test evidence includes failures and cleanup, not just successful calls.

Native source backups, private board data, font files, node_modules and machine-specific diagnostic fixtures are excluded from the portable source release. Install dependencies with the lockfile. Rolling back MCP code does not roll back a PCB document.

## Explicit ECO goals

`pcb_import_schematic_changes` accepts `expectedAfter.components` (stable source `uniqueId`, optional presence/designator/name) and `expectedAfter.pads` (current pad ID/net). It checks these goals independently after the native call. Unmet goals return an error even when the editor returned true; omitted goals produce `postconditionsVerified:null`. A failed postcondition can follow an already-applied native change: inspect current state before any retry. This is not a selective ECO implementation or source-validation engine.

The live PCB-side reference-difference fixture observed native success with no reference correction. The new goal check detects that mismatch, and the fixture restores the reference. This does not demonstrate all source-side add/remove/footprint/pin-change imports. Snapshot comparison accepts up to 32MiB, matching capture output limits; write plans retain the 8MiB bound.

## 1.6: stable logical pin goals and data quality

The 1.6 profiles exposed 20 production tools, 29 legacy compatibility tools and 3 diagnostics tools. `expectedAfter.pads` accepts either `{primitiveId, net}` or `{componentUniqueId, padNumber, net}`. The logical selector resolves the current source-linked component and explicit pad-parent relationship. Ambiguous source identities, missing associations, duplicate physical IDs and inconsistent multi-shape logical pin nets do not pass. Unknown, repeated or contradictory goals are rejected before Bridge access.

Snapshots reject invalid netlist/layer results and duplicate standalone pads. `coverage.metadataComplete` separates metadata quality from primitive-category coverage. Comparison returns `unverifiedData`, `completeComparison` and nullable `fullSnapshotUnchanged`; equal failed reads never establish complete-snapshot equality. All-silkscreen inspection rejects missing explicitly requested IDs.

Inline and file JSON share the same UTF-8 byte limit, post-read file size is checked, and UTF-8 BOM is accepted without changing the source file. Tests cover logical ID replacement synthetically; a real no-change import verifies current pin resolution but does not certify an actual footprint-replacement ECO.

## 1.7: API-only comparison, export, inspection and release gates

`pcb_compare_associated_netlists` calls the public comparison API twice and refuses unstable results. The first side is always the exact associated schematic and the second side is the target PCB; runtime aliases are normalized before paging. Logical equality is not copper-connectivity approval.

`pcb_export_manufacturing` exposes only Gerber, pick-and-place, BOM, test-point, netlist and IPC-D-356A File getters. Paths must be absolute, type-specific and nonexistent. Transfer size, canonical base64, archive signature where applicable, SHA-256 and local disk readback are checked. The MCP does not expose manufacturing order methods, interactive dialogs, uploads, automatic route/layout data or destructive route clearing.

`pcb_capture_inspection_view` captures the existing exact-tab viewport without panning, zooming, activating a tab or changing selection. It may temporarily isolate currently enabled layers, preserves disabled layers, restores the original visible/hidden/current-layer state and refuses success unless the final layer array matches. A blank or off-board current viewport remains blank by design.

`pcb_render_inspection_svg` replaces fit-all/fit-region browser operations for routine 2D inspection. It reads the complete typed PCB state twice, rejects drift, and renders visible/all/explicit layers plus an optional crop region to a new local SVG without touching editor state. It reconstructs board-outline polylines, traces, pads, holes, vias, pour outlines, actual poured regions, fills, regions and available labels. Native component bodies, glyph-level clearance, 3D, mask, assembly and manufacturing previews remain outside this renderer.

`pcb_verify_api_gates` executes two stable PCB digests before and after native verbose DRC and two stable source-netlist comparisons. `verificationComplete` distinguishes a completed check from `allApiGatesPassed`. Even a pass is reported as `API_GATES_PASSED_VISUAL_AND_ENGINEERING_REVIEW_REQUIRED` because ratline count, copper topology, current, SI, mechanics, connector mating view and manufacturing quality are outside these API gates.

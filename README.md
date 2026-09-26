# EasyEDA PCB MCP 4.1.0

One MIL-only, 17-tool MCP surface built on the direct-edit v4 refactor. The model owns layout, routing choices and analysis timing. MCP resolves native objects, executes explicitly specified geometry, and returns factual results. No automatic placement, route search, design permission gates or legacy profiles.

## Editing

`pcb_edit` accepts ordered operations using designators, `U1.12` pad endpoints and native layer names. All coordinates, dimensions, widths, drill sizes and measurements are mil. Unspecified fields retain their current value. Common operations cover placement, alignment/transform, explicit routes/arcs, vias, pads, holes/slots, outline/fill/pour/region geometry, text, modify/delete and designator cleanup.

New operations are `orient` (aim an explicitly selected pad group at an endpoint on the current side), `copper_path` (construct one copper corridor from the supplied centerline and width), and `via_array` (explicit rotated grid). They do not choose paths, clear obstacles, infer current ratings or delete old copper. The full typed contract is available through `pcb_read(kind="operations")`.

## Physical copper analysis

`pcb_read(kind="topology")` and `pcb_audit_geometry(checks=["topology"])` share the same physical-copper model. Read one scene and select nets, endpoint pairs (`paths`), explicit cross-sections (`sections`) and optional hypothetical removals (`excludeIds`). Reports include pad membership, connected copper components, existing path layer transitions, via dimensions and modeled mandatory single-via links. Copper-only islands are observations, never an automatic deletion instruction.

Actual fills, verified poured contours, concavities and holes participate in contact calculations. Pour boundaries alone are not conductive. Unknown coordinate frames, drill types, blind/buried via spans or missing native data remain explicit coverage gaps. Curves are tessellated with a reported chord-error tolerance. Cross-sections measure only their submitted locations; there is no global minimum-neck or electrical-current-sharing solver. Native DRC, this model, and electrical/thermal validation are distinct.

## Execution receipts

An optional `requestId` binds a durable intent to exactly that request content. Reusing identical content returns the retained result without redispatch; conflicting content fails. `pcb_read(kind="receipt", receiptId="...")` reads a receipt, `kind="receipts"` lists recent records, and `refresh=true` only attempts a native-journal read.

Receipts distinguish confirmed edits, failed/unknown/not-executed operations, save failure and SVG failure. `boardDelta` contains created/modified/deleted IDs. `wrotePcb=null` means an unconfirmed outcome. Intent and progress are persisted before native dispatch. This prevents duplicate dispatch while that state exists; it is not an atomic PCB transaction, automatic rollback or crash-proof exactly-once native execution. Unknown writes are never blindly replayed.

## Reading and feedback

Overview includes actual component/pad/net orientations and dimension provenance. Large results are retained and paged using `pcb_read(kind="result")`; retained file lookup survives MCP-process restart. `pcb_render_svg` supports regions, layers and net highlighting. Compound paths preserve holes with even-odd fill; circular/rotated bounds and copper-only edit regions are handled. Inspection labels never become board silkscreen. `pcb_capture_view` provides the native viewport when actual rendering is needed.

## Configuration and verification

Node.js >=22 is required. Run `npm ci --ignore-scripts`, `npm test`, `npm run smoke`, then `node src/server.mjs`. Only one default server is registered.

| Variable | Purpose |
| --- | --- |
| EASYEDA_BRIDGE_URL | Optional existing loopback Bridge in the documented port range |
| EASYEDA_ALLOWED_PROJECT_UUIDS | Optional explicit project scope |
| EASYEDA_PCB_STATE_DIR | Optional persistent receipt root; otherwise PLUGIN_DATA or the user's .easyeda-pcb directory |
| EASYEDA_PCB_ARTIFACT_DIR | Optional SVG and retained-result directory |

Runtime state and user geometry must not be committed. Tests use synthetic native mocks and graph fixtures. Real-client read-only results and real test-copy writes are reported separately; tool maintenance never uses the production board for mutation tests. Gateway and AgentDock do not require modification for this release.

[中文](README.zh-CN.md)

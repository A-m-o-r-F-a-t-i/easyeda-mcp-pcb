# EasyEDA PCB MCP 3.0.1

MCP-first typed wrappers for common EasyEDA PCB operations. The model supplies design intent; MCP handles object IDs, coordinate conversion, native signatures, bulk calls and factual feedback. No automatic placement or path search, no ordinary prepare/guard chain, and no design-approval gate.

## Default interface

The default registry contains 21 tools. pcb_execute_plan accepts typed operations directly; pcb_execute_text_plan uses the same contract. Use designators, U1.12 pin endpoints and layer names. Coordinate input, overview/pin data, picking, SVG regions and pick-and-place export default to mil; pass `units: "mm"` or `unit: "mm"` explicitly when metric input/output is required. Actual raw native geometry is explicitly labeled mil. Unspecified properties remain unchanged.

Placement, transform/alignment/radial arrays, explicit routes/arcs, vias, holes/slots, pads, outlines, fill/pour/region geometry, text, modify/delete, cleanup, component insertion and copper-layer count are wrapped. Public batch arrays have no small fixed cap; transport byte/time slicing is internal and preserves order.

A unique connected PCB needs no target. Ambiguous multi-board sessions use an exact document UUID or explicit target object. No process-global last-window cache is shared between conversations. Existing permission boundaries and native API argument requirements remain in force.

## Read and feedback

pcb_read(kind=overview) returns component/device/footprint identity, value, pose, physical dimension sources, actual pad/net mappings and same-side orientation maps. Unknown native body/assembly geometry remains null; graphical BBoxes are not physical-body measurements. Raw native arrays retain their labeled units.

pcb_read(kind=operations) publishes the full editing schema. Oversized results are retained with a resultId and complete component index; kind=result pages original data without another PCB read.

Editing view=auto/local/board/none controls SVG feedback. pcb_render_inspection_svg provides top/bottom/both views, regions, explicit layers and net highlighting with optional pin/net labels. SVG overlays are not manufacturing silkscreen. Bottom geometry is mirrored once, with annotation text kept readable. Missing geometry is reported.

## Execution results

Results distinguish applied, failed, partial, unknown and not_executed. Native-returned object state is factual acknowledgement, not PCB quality approval. Save and SVG-generation failures are reported separately from successful edits. Unknown writes are not blindly replayed. Internal execution journals are bounded recovery aids, not atomic transactions or backups.

DRC, netlist comparison, geometry and silkscreen inspection are optional data tools; none grants or revokes editing permission. pcb_verify_api_gates retains its historical name only as a combined data report. Native DRC running jobs and detail pagination remain supported.

## Installation and verification

Node.js >=22 is required. Install locked dependencies, then run:

~~~text
npm ci
npm test
npm run smoke
node src/server.mjs
~~~

Only the default service should be registered. Legacy and diagnostics profiles remain source-level compatibility/testing options, not additional default tool menus. Historical v2 plan helpers retain their old behavior only when explicitly used; they are not the v3 editing contract.

The read-only integration script scripts/read-only-v3.mjs requires an exact document UUID and never edits, saves, runs DRC or changes the viewport. v3 has offline native mocks and real 4.1.60 read-only coverage. These do not establish that every write combination has been tested in a live editor. Do not run old live-write probes on a production board.

Known client differences include canonical-vs-component drill fields, world-coordinate polygon pads, missing body outlines, uncertain native REGION behavior and partial repour side effects. Unknown representations remain disclosed; MCP does not quietly rewrite geometry or rules. See the accompanying PCB Skill for detailed usage.

Common PCB actions use MCP first. Raw API code is only for a specific missing wrapper or diagnosis; add missing common operations to MCP rather than turning fallback scripts into a normal workflow.

[中文说明](README.zh-CN.md)

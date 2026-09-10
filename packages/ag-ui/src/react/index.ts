/**
 * Entry point for the `@b4run/ag-ui/react` subpath.
 *
 * React and `@copilotkit/react-core` are OPTIONAL peer dependencies: importing
 * the root (`@b4run/ag-ui`) or `./sse` entry never loads this module, so a
 * server-only consumer installs nothing extra.
 *
 * Three layers, from drop-in to build-your-own:
 *
 * 1. `b4ActivityRenderers` — the whole set, ready to pass to
 *    CopilotKit's `renderActivityMessages`. This is the one-line default.
 * 2. `b4PlanActivityRenderer` / `b4SubagentActivityRenderer` — the
 *    individual renderers, for clients that want only one of them or that mix
 *    them with their own.
 * 3. `PlanActivityCard`, `SubagentActivityCard`, `ActivityChecklist` plus the
 *    content schemas — plain React components taking `content`, and the
 *    validators behind the renderers, for clients presenting the same
 *    activities their own way (with or without CopilotKit).
 *
 * `cx` is exported for the eject rung. A copied card is not a clean drop-in:
 * each source carries two package-internal specifiers, and they resolve to
 * different entries — `../activities.js` to the package root, `./parts.js` and
 * `./schemas.js` to this one. Exporting `cx` (the only runtime value among
 * them) is what gives those rewrites somewhere to point. The README's rung-4
 * table lists every rewrite per file.
 *
 * The activity type constants and content types (`B4_PLAN_ACTIVITY_TYPE`,
 * `B4PlanActivityContent`, …) live on the root entry and are not re-exported
 * here. The one type this entry does own is `SubagentActivityContentOutput`:
 * the parsed subagent shape, which admits an explicit `undefined` `todos` that
 * the published exact-optional type does not. It is the parameter type of both
 * `SubagentActivityCard` and `b4SubagentActivityRenderer.render`.
 */
export { ActivityChecklist } from "./ActivityChecklist.js"
export { PlanActivityCard } from "./PlanActivityCard.js"
export {
  type B4ActivityClassNames,
  type B4ActivityComponents,
  type B4TodoRowProps,
  type B4ToolRowProps,
  cx,
} from "./parts.js"
export {
  b4ActivityRenderers,
  b4PlanActivityRenderer,
  b4SubagentActivityRenderer,
} from "./renderers.js"
export { SubagentActivityCard } from "./SubagentActivityCard.js"
export {
  planActivityContentSchema,
  type SubagentActivityContentOutput,
  subagentActivityContentSchema,
} from "./schemas.js"

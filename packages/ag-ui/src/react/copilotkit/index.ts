/**
 * `@b4run/ag-ui/react/copilotkit` — the CopilotKit (React) connector for B4.run's
 * activity kit. `react` and `@copilotkit/react-core` (>=1.76, the v2 API) are
 * optional peer dependencies of `@b4run/ag-ui`; this is the only entry that
 * imports CopilotKit.
 */
export {
  B4Activity,
  type B4ActivityContextValue,
  type B4ActivityProps,
  useB4ActivityContext,
} from "./B4Activity.js"
export { mergeTurnMessages } from "./messages.js"
export { type B4ChatSlots, useB4ChatSlots } from "./useB4ChatSlots.js"
export { type UseB4TurnsOptions, type UseB4TurnsResult, useB4Turns } from "./useB4Turns.js"

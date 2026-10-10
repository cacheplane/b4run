import { createUiJsonSchema } from "@hashbrownai/core"
import { briefDefinitions } from "./schema"

/**
 * The JSON Schema every navlog run asks the model's final answer to match:
 * `{ "ui": [{ "<Component>": { "props": { … } } }, …] }`, one entry per
 * component in `schema.ts`. The CopilotKit runtime route sends it as
 * `B4HttpAgent`'s `responseSchema`; the browser parses the streamed answer
 * against the same kit (`components.tsx`) and renders it.
 *
 * React-free on purpose: the route handler imports this on the server.
 */
export const briefJsonSchema: Readonly<Record<string, unknown>> = createUiJsonSchema({
  components: briefDefinitions,
})

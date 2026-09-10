import { defineMemory } from "@b4run/sdk"
import { z } from "zod"
export default defineMemory({
  kind: "semantic",
  scope: ["workspace", "route"],
  schema: z.object({ subject: z.string(), predicate: z.string(), value: z.string() }),
})

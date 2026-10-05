import { z } from "zod"

export default z.object({
  /** Accumulated planning context from tool and subagent results. */
  context: z.string().default(""),
})

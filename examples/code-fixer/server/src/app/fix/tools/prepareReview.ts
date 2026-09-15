import type { B4ToolContext } from "@b4run/sdk"
import { prepareReview } from "../../../review/prepare.js"

/** Verify the source repair independently and return the exact candidate for review. */
export default async function prepare(_input: Record<string, never>, ctx: B4ToolContext) {
  return prepareReview(ctx)
}

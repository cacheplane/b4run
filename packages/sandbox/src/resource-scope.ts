import { createHash } from "node:crypto"

/** Stable provider resource addressing; not an authorization or ownership check. */
export function resourceScope(scope: string): (threadId: string) => string {
  if (typeof scope !== "string" || scope.trim().length === 0) {
    throw new TypeError("Sandbox scope must be a non-empty application/environment identifier")
  }
  return (threadId) =>
    createHash("sha256")
      .update(JSON.stringify(["b4-sandbox-scope-v1", scope, threadId]))
      .digest("hex")
      .slice(0, 40)
}

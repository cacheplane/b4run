import { createRequire } from "node:module"

/** The CLI package version; "0.0.0" when it cannot be read. */
export function readCliVersion(): string {
  try {
    // src/lib/signals and dist/lib/signals are both three levels below the package root.
    const pkg = createRequire(import.meta.url)("../../../package.json") as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

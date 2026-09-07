import type { B4Config } from "./types.js"

/**
 * Typed identity helper for `b4.config.ts`. Purely for IntelliSense — the
 * loader reads `export default`, so `export default config({...})` and a bare
 * `export default {...}` are equivalent at runtime.
 */
export function config(c: B4Config): B4Config {
  return c
}

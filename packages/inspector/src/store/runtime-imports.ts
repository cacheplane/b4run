// RUNTIME-ONLY imports. These packages load the user's b4.config.ts / route
// memory.ts (arbitrary TS through the tsx loader) and open sqlite databases —
// they must execute from real node_modules at runtime, NEVER be bundled by
// Next. pnpm workspace links resolve outside node_modules, which defeats
// serverExternalPackages, so the ignore comments leave these import()s for
// Node itself to resolve.
export function importCore(): Promise<typeof import("@b4run/core")> {
  return import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "@b4run/core")
}

/** The node-only half of core (route discovery, tool typegen). */
export function importCoreNode(): Promise<typeof import("@b4run/core/node")> {
  return import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "@b4run/core/node")
}

export function importMemory(): Promise<typeof import("@b4run/memory")> {
  return import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "@b4run/memory")
}

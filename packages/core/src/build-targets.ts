/**
 * The names `b4 build` accepts in `config.build.targets`.
 *
 * This tuple is the single source of truth for the target names: the
 * {@link BuildTargetName} union that types `B4Config.build.targets` is derived
 * from it, and the CLI's target registry is typed as a `Record` over that
 * union, so adding a target to one side without the other is a compile error
 * rather than a drift that surfaces at build time.
 */
export const BUILD_TARGET_NAMES = ["node", "langsmith", "hono", "vercel"] as const

/** A known `b4 build` target name. See {@link BUILD_TARGET_NAMES}. */
export type BuildTargetName = (typeof BUILD_TARGET_NAMES)[number]

/**
 * Runtime narrowing for names that arrive untyped — a `b4.config.js` author or
 * a JSON config has no compiler to catch `"vercell"`, so the CLI still
 * validates the list and reports the known names.
 */
export function isBuildTargetName(name: string): name is BuildTargetName {
  return (BUILD_TARGET_NAMES as readonly string[]).includes(name)
}

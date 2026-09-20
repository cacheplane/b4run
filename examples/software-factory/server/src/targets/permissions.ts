import type { Target } from "./catalog.js"

/** What the builder's `b4.config.ts` pre-approves, derived from the target alone. */
export interface BuilderPermissions {
  readFile: string[]
  listDir: string[]
  bash: string[]
}

/**
 * What every builder needs beyond its target's own commands: a one-off script, and reading
 * around the workspace. `node ` keeps its trailing space because these are PREFIX matches
 * and a bare `node` would also admit `nodemon`.
 */
const FIXED_BASH = ["node ", "cat", "ls", "head"]

/**
 * The builder's pre-approved surface for one target.
 *
 * The bash entries are the target's FULL build and test invocations, not a two-word head:
 * the match is a prefix, so the full invocation still admits appended flags while a shorter
 * head would silently admit an entirely different command that happens to share it. Each
 * invocation is listed both at the workspace root and under the target's own `cwd`, because
 * the builder is told to run it from there while the scripted lanes run it from the root;
 * anything else surfaces as an interrupt, which is the point.
 *
 * The dependency tree the image provides is readable, never writable.
 */
export function builderPermissions(target: Target): BuilderPermissions {
  const { commands, environmentLinks } = target
  const invocations = [commands.build, commands.test]
    .filter((argv) => argv.length > 0)
    .flatMap((argv) => {
      const invocation = argv.join(" ")
      return commands.cwd === "."
        ? [invocation]
        : [invocation, `cd ${commands.cwd} && ${invocation}`]
    })
  return {
    readFile: environmentLinks.flatMap((link) => [link.target, `${link.target}/`]),
    listDir: environmentLinks.map((link) => link.target),
    // Deduplicated: a target whose build and test invocations coincide must not pre-approve
    // the same prefix twice.
    bash: [...new Set([...invocations, ...FIXED_BASH])],
  }
}

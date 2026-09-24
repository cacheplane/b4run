import type { Target } from "./catalog.js"

/** What the builder's `b4.config.ts` pre-approves, derived from the target alone. */
export interface BuilderPermissions {
  readFile: string[]
  listDir: string[]
  bash: string[]
}

/**
 * The read-only commands a builder reads a workspace with: the drafter's list
 * (`drafter/b4.config.ts`), kept equal by test. `sed -n` and `nl` are what read a large file
 * in ranges; the first live run's builder reached for `sed -n '1,2400p'` after it had
 * truncated a 3,644-line file it read whole, and parked on the permission prompt because the
 * list stopped at `head`. `find` stays off because it carries `-exec` and `-delete`.
 */
export const READ_ONLY_BASH = ["ls", "cat", "head", "tail", "grep", "wc", "sed -n", "nl"] as const

/**
 * What every builder needs beyond its target's own commands: a one-off script, and reading
 * around the workspace. `node ` keeps its trailing space because these are PREFIX matches
 * and a bare `node` would also admit `nodemon`. The list bounds which commands may START a
 * shell line, not what the shell then does; it is not the builder's security boundary (the
 * denied network and the controller's own assembly and verification are).
 */
const FIXED_BASH = ["node ", ...READ_ONLY_BASH]

/**
 * The builder's pre-approved surface for one target.
 *
 * The bash entries are the target's FULL build and test invocations, not a two-word head:
 * the match is a prefix, so the full invocation still admits appended flags while a shorter
 * head would silently admit an entirely different command that happens to share it. Each
 * invocation is listed both at the workspace root and under the target's own `cwd`, because
 * the builder is told to run it from there while the scripted lanes run it from the root.
 * Anything else is refused: the builder app runs its permissions `non-interactive`
 * (`server/b4.config.ts`), so an unlisted command is a tool error the model reads and
 * recovers from, not a prompt parked for a person nobody assigned.
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

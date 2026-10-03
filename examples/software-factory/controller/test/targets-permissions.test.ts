import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { builderPermissions, READ_ONLY_BASH } from "../src/lib/targets/permissions.ts"

/** The entries every builder gets, whatever its target runs: a script, and the read-only list. */
const FIXED = ["node ", "ls", "cat", "head", "tail", "grep", "wc", "sed -n", "nl"]

describe("builderPermissions", () => {
  it("pre-approves the cli-flags target's whole test invocation and nothing resembling a shell", () => {
    const permissions = builderPermissions(loadTask("cli-flags").target)
    // The scripted builder runs exactly `npm test`, and prefix matching admits appended
    // flags; a two-word head would admit a different command sharing it.
    expect(permissions.bash).toEqual(["npm test", ...FIXED])
    expect(permissions.bash.some((pattern) => pattern.includes("rm"))).toBe(false)
    expect(permissions.readFile).toEqual([
      "/opt/targets/cli-flags/node_modules",
      "/opt/targets/cli-flags/node_modules/",
    ])
    expect(permissions.listDir).toEqual(["/opt/targets/cli-flags/node_modules"])
  })

  it("pre-approves the devkit target's full build and test invocations, at the root and under its cwd", () => {
    const { target } = loadTask("devkit-spawn-deadline")
    const { commands, environmentLinks } = target
    // Computed from the manifest's own argv, so this stays true when the target's commands
    // change rather than pinning today's strings.
    const build = commands.build.join(" ")
    const test = commands.test.join(" ")
    expect(commands.cwd).not.toBe(".")
    expect(builderPermissions(target).bash).toEqual([
      build,
      `cd ${commands.cwd} && ${build}`,
      test,
      `cd ${commands.cwd} && ${test}`,
      ...FIXED,
    ])
    expect(builderPermissions(target).readFile).toEqual(
      environmentLinks.flatMap((link) => [link.target, `${link.target}/`]),
    )
  })

  it("lists an invocation once when the target's build and test commands coincide", () => {
    const { target } = loadTask("cli-flags")
    const coinciding = {
      ...target,
      commands: { ...target.commands, build: [...target.commands.test] },
    }
    expect(builderPermissions(coinciding).bash).toEqual(["npm test", ...FIXED])
  })

  it("gives the builder the drafter's read-only commands, so reading in ranges never parks", () => {
    // The drafter's list is literal in its config; the two must not drift apart, or one of
    // them reads a large file whole again.
    const drafterConfig = readFileSync(
      new URL("../../drafter/b4.config.ts", import.meta.url),
      "utf8",
    )
    const listed = /allow: \{ bash: \[([^\]]*)\] \}/.exec(drafterConfig)?.[1]
    expect(listed?.split(",").map((entry) => JSON.parse(entry.trim()))).toEqual([...READ_ONLY_BASH])
    const { bash } = builderPermissions(loadTask("cli-flags").target)
    for (const command of READ_ONLY_BASH) expect(bash).toContain(command)
    expect(bash).not.toContain("find")
  })
})

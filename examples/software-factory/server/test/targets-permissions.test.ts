import { describe, expect, it } from "vitest"
import { loadTask } from "../src/targets/catalog.ts"
import { builderPermissions } from "../src/targets/permissions.ts"

/** The four entries every builder gets, whatever its target runs. */
const FIXED = ["node ", "cat", "ls", "head"]

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
})

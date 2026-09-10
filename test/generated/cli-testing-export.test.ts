import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { spawnProcess } from "../../packages/devkit/src/testing/index.ts"
import { getTestRegistryUrl } from "../harness/local-registry.ts"
import {
  cleanupTrackedTempDirs,
  createTrackedTempDir,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"
import { writeRegistryNpmrc } from "../harness/scaffold-packaging.js"

const tempDirs: TrackedTempDir[] = []

const CONSUMER_PACKAGES = [
  "@b4run/core",
  "@b4run/langchain",
  "@b4run/langgraph",
  "@b4run/permissions",
  "@b4run/sdk",
  "@b4run/sqlite-storage",
  "@b4run/workspace",
  "@b4run/cli",
] as const

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

describe.each([
  { subpath: "@b4run/sdk/testing", label: "sdk" },
  { subpath: "@b4run/cli/testing", label: "cli" },
])("$subpath", ({ subpath, label }) => {
  test("registry consumers can import the published testing helpers", {
    timeout: 60_000,
  }, async () => {
    const consumerDir = await createTrackedTempDir(`b4-${label}-testing-`, tempDirs)

    await writeFile(
      join(consumerDir, "package.json"),
      `${JSON.stringify({ name: `${label}-testing-consumer`, private: true }, null, 2)}\n`,
      "utf8",
    )
    await writeRegistryNpmrc(consumerDir, getTestRegistryUrl())

    await runCommand("pnpm", ["add", ...CONSUMER_PACKAGES], consumerDir)

    const scriptPath = join(consumerDir, "testing-check.mjs")

    await writeFile(
      scriptPath,
      [
        `import { expectError, expectMeta, expectOutput } from "${subpath}";`,
        "const passed = {",
        '  appRoot: "/tmp/b4-app",',
        "  durationMs: 1,",
        '  executionSource: "server",',
        '  finishedAt: "2026-04-13T00:00:01.000Z",',
        '  mode: "graph",',
        "  output: { profile: { tenant: 'acme', region: 'us-west' }, tags: ['alpha', 'beta'] },",
        '  routeId: "/support/[tenant]",',
        '  routePath: "src/app/support/[tenant]/index.ts",',
        '  startedAt: "2026-04-13T00:00:00.000Z",',
        '  status: "passed",',
        "};",
        "expectOutput(passed, { profile: { tenant: 'acme' }, tags: ['alpha', 'beta'] });",
        "expectMeta(passed, { executionSource: 'server', mode: 'graph', routeId: '/support/[tenant]', routePath: 'src/app/support/[tenant]/index.ts' });",
        "const failed = {",
        '  appRoot: "/tmp/b4-app",',
        "  durationMs: 1,",
        "  error: { kind: 'execution_error', message: 'tenant acme exploded while rendering' },",
        '  executionSource: "server",',
        '  finishedAt: "2026-04-13T00:00:01.000Z",',
        '  mode: "graph",',
        '  routeId: "/support/[tenant]",',
        '  routePath: "src/app/support/[tenant]/index.ts",',
        '  startedAt: "2026-04-13T00:00:00.000Z",',
        '  status: "failed",',
        "};",
        "expectError(failed, { kind: 'execution_error', message: { includes: 'acme exploded' } });",
      ].join("\n"),
      "utf8",
    )

    await expect(runCommand("node", [scriptPath], consumerDir)).resolves.toMatchObject({
      stderr: "",
      stdout: "",
    })
  })
})

async function runCommand(command: string, args: readonly string[], cwd: string) {
  const result = await spawnProcess({
    args,
    command,
    cwd,
  })

  if (!result.ok) {
    throw new Error(
      [`${command} ${args.join(" ")} failed`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    )
  }

  return {
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

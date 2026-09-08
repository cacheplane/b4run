import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import { describe, expect, test } from "vitest"
import { parseAllDocuments } from "yaml"
import { REQUIRED_KUBE_PERMISSIONS } from "../../packages/sandbox/src/kubernetes/kube-client.ts"
import { executeCommand } from "../../scripts/kubernetes-compat/command.ts"

function pathEntries(): readonly string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean)
}

function executableExists(name: string): boolean {
  for (const directory of pathEntries()) {
    if (existsSync(join(directory, name))) return true
  }
  return false
}

const helmAvailable = executableExists("helm")
// The root-only compatibility lane does not use Turbo caching.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this opt-in controls a direct Vitest run.
const requireHelm = process.env.B4_REQUIRE_HELM === "1"

describe("b4-orchestrator Role parity", () => {
  test.skipIf(!helmAvailable && !requireHelm)(
    "matches the provider permission declaration exactly",
    async () => {
      expect(helmAvailable, "Helm is required when B4_REQUIRE_HELM=1").toBe(true)
      const rendered = await executeCommand(
        {
          file: "helm",
          args: [
            "template",
            "b4-sandbox-infra",
            "charts/b4-sandbox-infra",
            "--namespace",
            "b4-sandbox",
          ],
        },
        { cwd: process.cwd() },
      )
      const role = parseAllDocuments(rendered.stdout.toString("utf8"))
        .map((document) => document.toJSON() as Record<string, unknown>)
        .find(
          (document) =>
            document.kind === "Role" &&
            (document.metadata as { name?: string } | undefined)?.name === "b4-orchestrator",
        ) as
        | {
            rules?: readonly {
              apiGroups?: readonly string[]
              resources?: readonly string[]
              verbs?: readonly string[]
            }[]
          }
        | undefined

      expect(role).toBeDefined()
      const actual = (role?.rules ?? []).flatMap((rule) =>
        (rule.apiGroups ?? []).flatMap((apiGroup) =>
          (rule.resources ?? []).flatMap((qualifiedResource) => {
            const [resource, subresource] = qualifiedResource.split("/", 2)
            if (resource === undefined || resource.length === 0) {
              throw new Error("Rendered Role contains an empty resource")
            }
            return (rule.verbs ?? []).map((verb) => ({
              apiGroup,
              resource,
              ...(subresource !== undefined ? { subresource } : {}),
              verb,
            }))
          }),
        ),
      )
      const key = (permission: {
        apiGroup: string
        resource?: string
        subresource?: string
        verb: string
      }): string =>
        `${permission.apiGroup}|${permission.resource ?? ""}|${permission.subresource ?? ""}|${permission.verb}`

      expect(actual.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
        [...REQUIRED_KUBE_PERMISSIONS].sort((a, b) => key(a).localeCompare(key(b))),
      )
    },
    // `helm template` takes ~2s on a loaded CI runner and has exceeded the 5s
    // default twice in a row; give the external render a real budget.
    30_000,
  )
})

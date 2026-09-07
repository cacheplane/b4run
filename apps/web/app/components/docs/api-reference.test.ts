import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as apiReferenceExports from "./api-reference"
import {
  API_REFERENCE_GUARD_IDS,
  API_REQUIRED_CONTRACT_KEYS,
  type ApiReferenceArtifact,
  ARTIFACT_REGISTRY,
  artifactAddressFor,
  artifactBoundaryFor,
  GENERATED_ROUTES_ARTIFACT,
  PACKAGE_CATALOG,
  validateApiReferenceRegistries,
} from "./api-reference"
import { API_REFERENCE_PAGES, API_REFERENCE_PARENT } from "./api-reference-pages"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..")
const CHECK_DOCS_PATH = join(REPO_ROOT, "scripts/check-docs.mjs")
const CHANGESET_PATH = join(REPO_ROOT, ".changeset/api-reference-coverage.md")

const EXPECTED_REFERENCE_PAGES = [
  ["@b4run/sdk", "/docs/api/sdk", "@b4run/sdk", ["@b4run/sdk"]],
  ["@b4run/cli", "/docs/api/cli", "@b4run/cli", ["@b4run/cli"]],
  ["@b4run/core", "/docs/api/core", "@b4run/core", ["@b4run/core"]],
  ["@b4run/ag-ui", "/docs/api/ag-ui", "@b4run/ag-ui", ["@b4run/ag-ui"]],
  ["@b4run/memory", "/docs/api/memory", "@b4run/memory", ["@b4run/memory"]],
  [
    "@b4run/memory-pgvector",
    "/docs/api/memory-pgvector",
    "@b4run/memory-pgvector",
    ["@b4run/memory-pgvector"],
  ],
  [
    "@b4run/postgres-storage",
    "/docs/api/postgres-storage",
    "@b4run/postgres-storage",
    ["@b4run/postgres-storage"],
  ],
  ["@b4run/testing", "/docs/api/testing", "@b4run/testing", ["@b4run/testing"]],
  ["@b4run/evals", "/docs/api/evals", "@b4run/evals", ["@b4run/evals"]],
  ["b4:routes", "/docs/api/generated-routes", "b4:routes", ["@b4run/cli", "@b4run/core"]],
  ["@b4run/permissions", "/docs/api/permissions", "@b4run/permissions", ["@b4run/permissions"]],
  ["@b4run/workspace", "/docs/api/workspace", "@b4run/workspace", ["@b4run/workspace"]],
  ["@b4run/sandbox", "/docs/api/sandbox", "@b4run/sandbox", ["@b4run/sandbox"]],
  ["@b4run/langgraph", "/docs/api/langgraph", "@b4run/langgraph", ["@b4run/langgraph"]],
  ["@b4run/langchain", "/docs/api/langchain", "@b4run/langchain", ["@b4run/langchain"]],
  [
    "@b4run/sqlite-storage",
    "/docs/api/sqlite-storage",
    "@b4run/sqlite-storage",
    ["@b4run/sqlite-storage"],
  ],
] as const

const EXPECTED_DETAILED_IMPORTS = [
  ["@b4run/sdk", "."],
  ["@b4run/sdk", "./pure"],
  ["@b4run/sdk", "./testing"],
  ["@b4run/cli", "."],
  ["@b4run/cli", "./fetch"],
  ["@b4run/cli", "./runtime"],
  ["@b4run/cli", "./testing"],
  ["@b4run/core", "."],
  ["@b4run/core", "./node"],
  ["@b4run/ag-ui", "."],
  ["@b4run/ag-ui", "./sse"],
  ["@b4run/ag-ui", "./react"],
  ["@b4run/memory", "."],
  ["@b4run/memory", "./browse"],
  ["@b4run/memory", "./namespace"],
  ["@b4run/memory", "./reconcile"],
  ["@b4run/memory-pgvector", "."],
  ["@b4run/postgres-storage", "."],
  ["@b4run/postgres-storage", "./node"],
  ["@b4run/testing", "."],
  ["@b4run/evals", "."],
  ["@b4run/permissions", "."],
  ["@b4run/permissions", "./node"],
  ["@b4run/workspace", "."],
  ["@b4run/workspace", "./node"],
  ["@b4run/sandbox", "."],
  ["@b4run/sandbox", "./testing"],
  ["@b4run/langgraph", "."],
  ["@b4run/langgraph", "./define-entry"],
  ["@b4run/langgraph", "./route-module"],
  ["@b4run/langchain", "."],
  ["@b4run/langchain", "./package.json"],
  ["@b4run/sqlite-storage", "."],
] as const

const EXPECTED_CATALOG_AND_INTERNAL_IMPORTS = [
  ["@b4run/core", "./internal/compiler", "internal"],
  ["@b4run/ag-ui", "./react/styles.css", "catalog-only"],
  ["@b4run/config-biome", ".", "internal"],
  ["@b4run/config-biome", "./biome", "internal"],
  ["@b4run/config-typescript", ".", "internal"],
  ["@b4run/config-typescript", "./base", "internal"],
  ["@b4run/config-typescript", "./library", "internal"],
  ["@b4run/config-typescript", "./node", "internal"],
  ["@b4run/config-typescript", "./nextjs", "internal"],
  ["@b4run/devkit", ".", "internal"],
  ["@b4run/vite-plugin", ".", "internal"],
] as const

const EXPECTED_OPERATED_ARTIFACTS = [
  [
    "@b4run/cli",
    "bin.b4",
    "executable",
    "./dist/index.js",
    "detailed",
    "node-only",
    "tooling",
    "supported",
  ],
  [
    "create-b4-app",
    "bin.create-b4-app",
    "executable",
    "./dist/bin.js",
    "catalog-only",
    "node-only",
    "tooling",
    "supported",
  ],
  [
    "@b4run/inspector",
    "b4Inspector.server",
    "operated-application",
    ".next/standalone/packages/inspector/server.js",
    "catalog-only",
    "node-only",
    "tooling",
    "supported",
  ],
] as const

const EXPECTED_FINAL_ARTIFACT_POLICIES = [
  [
    "import:@b4run/config-biome:.",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@b4run/config-biome:./biome",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@b4run/config-typescript:.",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@b4run/config-typescript:./base",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@b4run/config-typescript:./library",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@b4run/config-typescript:./node",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@b4run/config-typescript:./nextjs",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@b4run/devkit:.",
    "internal",
    "typescript-runtime",
    "node-only",
    "not-claimed",
    "internal",
    "internal",
  ],
  [
    "import:@b4run/vite-plugin:.",
    "internal",
    "typescript-runtime",
    "node-only",
    "not-claimed",
    "tooling",
    "internal",
  ],
] as const

const EXPECTED_CATALOG_DESTINATIONS = new Map<string, string>([
  ["@b4run/config-biome", "/docs/api#b4runconfig-biome"],
  ["@b4run/config-typescript", "/docs/api#b4runconfig-typescript"],
  ["@b4run/devkit", "/docs/api#b4rundevkit"],
  ["@b4run/inspector", "/docs/api#b4runinspector"],
  ["@b4run/vite-plugin", "/docs/api#b4runvite-plugin"],
  ["create-b4-app", "/docs/api#create-b4-app"],
] as const)

const EXPECTED_REQUIRED_CONTRACT_KEYS = [
  "@b4run/langchain#.:AgentStreamChunk",
  "@b4run/langchain#.:OffloadToolOutputCtx",
  "@b4run/langchain#.:RetryOptions",
  "@b4run/langchain#.:UnwrappedToolResult",
  "@b4run/langchain#.:resolveProvider",
  "@b4run/langchain#.:withRetry",
  "@b4run/langgraph#./define-entry:defineEntry",
  "@b4run/langgraph#./route-module:GraphRouteModule",
  "@b4run/langgraph#./route-module:NormalizedRouteModule",
  "@b4run/langgraph#./route-module:RouteModule",
  "@b4run/langgraph#./route-module:WorkflowRouteModule",
  "@b4run/langgraph#./route-module:assertExactlyOneEntry",
  "@b4run/langgraph#./route-module:normalizeRouteModule",
  "@b4run/ag-ui#./sse:encodeAgUiSse",
  "@b4run/ag-ui#.:B4_PLAN_ACTIVITY_TYPE",
  "@b4run/ag-ui#.:B4_SUBAGENT_ACTIVITY_TYPE",
  "@b4run/ag-ui#.:B4RunInput",
  "@b4run/ag-ui#.:B4PlanActivityContent",
  "@b4run/ag-ui#.:B4SubagentActivityContent",
  "@b4run/ag-ui#.:RunContext",
  "@b4run/ag-ui#.:ToAguiOptions",
  "@b4run/ag-ui#.:fromRunAgentInput",
  "@b4run/ag-ui#.:toAguiEvents",
  "@b4run/cli#.:ServeRuntimeOptions",
  "@b4run/cli#.:serveRuntime",
  "@b4run/core#.:loadB4Config",
  "@b4run/core#.:resolveStateFields",
  "@b4run/evals#.:EvalCase",
  "@b4run/evals#.:EvalDefinition",
  "@b4run/evals#.:EvalReport",
  "@b4run/evals#.:RunEvalOptions",
  "@b4run/evals#.:Scorer",
  "@b4run/evals#.:defineEval",
  "@b4run/evals#.:runEval",
  "@b4run/memory#./namespace:MemoryScopeTuple",
  "@b4run/memory#./namespace:serializeNamespace",
  "@b4run/memory#./reconcile:approveWithReconcile",
  "@b4run/memory#.:BrowsePage",
  "@b4run/memory#.:BrowseQuery",
  "@b4run/memory#.:MemoryQuery",
  "@b4run/memory#.:MemoryRecord",
  "@b4run/memory#.:MemoryStore",
  "@b4run/memory-pgvector#.:PgvectorMemoryStore",
  "@b4run/memory-pgvector#.:pgvectorMemoryStore",
  "@b4run/postgres-storage#./node:NodePostgresPermissionsStoreOptions",
  "@b4run/postgres-storage#./node:NodePostgresStoreOptions",
  "@b4run/postgres-storage#./node:createPostgresPermissionsStore",
  "@b4run/postgres-storage#./node:createPostgresThreadsStore",
  "@b4run/postgres-storage#./node:postgresCheckpointer",
  "@b4run/postgres-storage#.:PostgresPermissionsStoreOptions",
  "@b4run/postgres-storage#.:PostgresStoreOptions",
  "@b4run/postgres-storage#.:createPostgresPermissionsStore",
  "@b4run/postgres-storage#.:createPostgresThreadsStore",
  "@b4run/postgres-storage#.:postgresCheckpointer",
  "@b4run/sandbox#./testing:runProviderConformance",
  "@b4run/sandbox#.:KubeAuthorizationReviewError",
  "@b4run/sandbox#.:KubernetesSandboxOptions",
  "@b4run/sandbox#.:dockerSandbox",
  "@b4run/sandbox#.:kubernetesSandbox",
  "@b4run/permissions#.:PermissionDecision",
  "@b4run/permissions#.:PermissionMode",
  "@b4run/permissions#.:PermissionsFile",
  "@b4run/permissions#.:PermissionsStore",
  "@b4run/sdk#.:AgentConfig",
  "@b4run/sdk#.:ReasoningConfig",
  "@b4run/sdk#.:RetryConfig",
  "@b4run/sdk#.:RouteConfig",
  "@b4run/sdk#.:agent",
  "@b4run/sdk#.:allow",
  "@b4run/sdk#.:defineMemory",
  "@b4run/sdk#.:defineMiddleware",
  "@b4run/sdk#.:isB4Agent",
  "@b4run/sdk#.:reject",
  "@b4run/sdk#.:validateModelId",
  "@b4run/sqlite-storage#.:CreateThreadInput",
  "@b4run/sqlite-storage#.:SqliteCheckpointerOptions",
  "@b4run/sqlite-storage#.:Thread",
  "@b4run/sqlite-storage#.:ThreadStatus",
  "@b4run/sqlite-storage#.:ThreadsStore",
  "@b4run/sqlite-storage#.:ThreadsStoreOptions",
  "@b4run/sqlite-storage#.:createThreadsStore",
  "@b4run/sqlite-storage#.:sqliteCheckpointer",
  "@b4run/testing#.:AgentHarness",
  "@b4run/testing#.:AgentHarnessOptions",
  "@b4run/testing#.:ScriptBuilder",
  "@b4run/testing#.:createAgentHarness",
  "@b4run/testing#.:fakeEmbedder",
  "@b4run/testing#.:loadFixtures",
  "@b4run/testing#.:runCheckpointerConformance",
  "@b4run/testing#.:runMemoryStoreConformance",
  "@b4run/testing#.:runPermissionsStoreConformance",
  "@b4run/testing#.:runThreadsStoreConformance",
  "@b4run/testing#.:writeFixtures",
  "@b4run/workspace#./node:LocalExecOptions",
  "@b4run/workspace#./node:LocalFilesystemOptions",
  "@b4run/workspace#./node:localExec",
  "@b4run/workspace#./node:localFilesystem",
  "@b4run/workspace#.:BackendContext",
  "@b4run/workspace#.:ExecBackend",
  "@b4run/workspace#.:FilesystemBackend",
  "@b4run/workspace#.:SandboxConfig",
  "@b4run/workspace#.:SandboxHandle",
  "@b4run/workspace#.:SandboxPolicy",
  "@b4run/workspace#.:SandboxProvider",
  "@b4run/workspace#.:SandboxSecurityPolicy",
  "@b4run/workspace#.:compose",
] as const

interface ManifestFixture {
  readonly name: string
  exports?: Record<string, unknown>
  bin?: Record<string, string>
  b4Inspector?: { server?: string }
  imports?: Record<string, unknown>
}

function publicPackageNames(): readonly string[] {
  const script = `
    import { readPublicPackages } from ${JSON.stringify(
      new URL("../../../../../scripts/lib/published-artifacts.mjs", import.meta.url).href,
    )};
    console.log(JSON.stringify((await readPublicPackages(${JSON.stringify(REPO_ROOT)})).map(({ packageJson }) => packageJson.name)));
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  })

  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as readonly string[]
}

function publicPackageManifests(): ManifestFixture[] {
  return readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packageJson = JSON.parse(
        readFileSync(join(REPO_ROOT, "packages", entry.name, "package.json"), "utf8"),
      ) as ManifestFixture & { readonly private?: boolean }
      return packageJson.private === true ? [] : [structuredClone(packageJson)]
    })
}

interface ApiReferenceRegistryAnalysis {
  readonly failures: readonly string[]
}

function analyzeApiReferenceRegistry(
  pages: readonly unknown[],
  artifacts: readonly unknown[],
): ApiReferenceRegistryAnalysis {
  const fixture = JSON.stringify({ pages, artifacts })
  const result = spawnSync(
    process.execPath,
    [CHECK_DOCS_PATH, "--analyze-api-reference-registry", fixture],
    { encoding: "utf8" },
  )

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toMatch(/^\{/)
  return JSON.parse(result.stdout) as ApiReferenceRegistryAnalysis
}

function analyzeApiReferenceManifests(
  manifests: readonly ManifestFixture[],
  artifacts: readonly unknown[] = ARTIFACT_REGISTRY,
): ApiReferenceRegistryAnalysis {
  const fixture = JSON.stringify({ manifests, artifacts })
  const result = spawnSync(
    process.execPath,
    [CHECK_DOCS_PATH, "--analyze-api-reference-manifests", fixture],
    { encoding: "utf8" },
  )

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toMatch(/^\{/)
  return JSON.parse(result.stdout) as ApiReferenceRegistryAnalysis
}

function mutatedManifestAnalysis(
  packageName: string,
  mutate: (manifest: ManifestFixture) => void,
): ApiReferenceRegistryAnalysis {
  const manifests = publicPackageManifests()
  const manifest = manifests.find(({ name }) => name === packageName)
  expect(manifest).toBeDefined()
  mutate(manifest as ManifestFixture)
  return analyzeApiReferenceManifests(manifests)
}

function expectRegistryRejection(artifact: Record<string, unknown>, message: RegExp): void {
  expect(() =>
    validateApiReferenceRegistries({
      pages: API_REFERENCE_PAGES,
      artifacts: [...ARTIFACT_REGISTRY, artifact as unknown as ApiReferenceArtifact],
      packages: PACKAGE_CATALOG,
    }),
  ).toThrow(message)
}

// These suites shell out to Node subprocesses (`check-docs.mjs`, bundling
// probes, the sitemap generator), so their runtime tracks machine load rather
// than the work in the test. Under a saturated parallel run they have exceeded
// vitest's 5000ms default and failed as timeouts rather than as anything real.
// The explicit suite timeout leaves room for that without hiding a genuine hang.
describe("API reference page registry", { timeout: 30_000 }, () => {
  it("pins the approved surfaces, destinations, ownership, and parent hub", () => {
    expect(
      API_REFERENCE_PAGES.map(({ label, href, surfaceName, ownerPackageNames }) => [
        label,
        href,
        surfaceName,
        ownerPackageNames,
      ]),
    ).toEqual(EXPECTED_REFERENCE_PAGES)
    expect(API_REFERENCE_PAGES).toHaveLength(16)
    for (const page of API_REFERENCE_PAGES) {
      expect(page.parent).toEqual({ label: "API Reference", href: "/docs/api" })
    }
  })

  it("rejects an address-preserving page-label mutation", () => {
    const pages = API_REFERENCE_PAGES.map((page, index) =>
      index === 0 ? { ...page, label: "SDK Reference" } : page,
    )

    expect(analyzeApiReferenceRegistry(pages, ARTIFACT_REGISTRY).failures).toEqual([
      expect.stringMatching(/page tuple.*@b4run\/sdk/),
    ])
  })

  it("rejects duplicate page labels independently of href uniqueness", () => {
    const pages = API_REFERENCE_PAGES.map((page, index) =>
      index === 1 ? { ...page, label: API_REFERENCE_PAGES[0].label } : page,
    )

    expect(() =>
      validateApiReferenceRegistries({
        pages,
        artifacts: ARTIFACT_REGISTRY,
        packages: PACKAGE_CATALOG,
      }),
    ).toThrow(/duplicate API reference page labels/)
    expect(analyzeApiReferenceRegistry(pages, ARTIFACT_REGISTRY).failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/duplicate API reference page labels/)]),
    )
  })
})

describe("client navigation dependency boundary", { timeout: 30_000 }, () => {
  it("preserves the page registry exports on the server registry entrypoint", () => {
    const exports = apiReferenceExports as Record<string, unknown>
    const registrySource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "api-reference.ts"),
      "utf8",
    )

    expect(exports.API_REFERENCE_PAGES).toBe(API_REFERENCE_PAGES)
    expect(exports.API_REFERENCE_PARENT).toBe(API_REFERENCE_PARENT)
    expect(registrySource).toContain(
      'export type { ApiReferencePage } from "./api-reference-pages"',
    )
  })

  it("loads only the lightweight, side-effect-free API page registry", () => {
    const docsComponentsRoot = dirname(fileURLToPath(import.meta.url))
    const navSource = readFileSync(join(docsComponentsRoot, "nav.ts"), "utf8")
    const pagesPath = join(docsComponentsRoot, "api-reference-pages.ts")
    const registrySource = readFileSync(join(docsComponentsRoot, "api-reference.ts"), "utf8")

    expect(existsSync(pagesPath)).toBe(true)
    if (!existsSync(pagesPath)) return
    const pagesSource = readFileSync(pagesPath, "utf8")
    expect(navSource).toContain('from "./api-reference-pages"')
    expect(navSource).not.toContain('from "./api-reference"')
    expect(pagesSource).not.toMatch(
      /ARTIFACT_REGISTRY|PACKAGE_CATALOG|validateApiReferenceRegistries|api-reference"/,
    )
    expect(registrySource).not.toMatch(
      /\nvalidateApiReferenceRegistries\(\{\n\s*pages: API_REFERENCE_PAGES/,
    )
  })
})

describe("artifact registry", { timeout: 30_000 }, () => {
  it("renders stable public documentation labels without delivery-state coverage names", () => {
    const forbidden = /\b(?:detailed|catalog-only)\b/
    for (const artifact of ARTIFACT_REGISTRY) {
      expect(artifactBoundaryFor(artifact)).not.toMatch(forbidden)
    }
    expect(artifactBoundaryFor(ARTIFACT_REGISTRY[0])).toContain("focused reference")
    expect(
      artifactBoundaryFor(
        ARTIFACT_REGISTRY.find(({ coverage }) => coverage === "catalog-only") ??
          ARTIFACT_REGISTRY[0],
      ),
    ).toContain("catalog summary")
    expect(
      artifactBoundaryFor(
        ARTIFACT_REGISTRY.find(({ coverage }) => coverage === "internal") ?? ARTIFACT_REGISTRY[0],
      ),
    ).toContain("internal only")
  })

  it("assigns executable compatibility guards to every runtime claim", () => {
    const knownGuardIds = new Set(API_REFERENCE_GUARD_IDS)
    const usedGuardIds = new Set<string>()

    for (const artifact of ARTIFACT_REGISTRY) {
      if (
        (artifact.kind === "import" && artifact.surfaceKind === "typescript-runtime") ||
        artifact.kind === "operated"
      ) {
        expect(artifact.guardIds, artifactAddressFor(artifact)).not.toHaveLength(0)
        for (const guardId of artifact.guardIds) {
          expect(knownGuardIds, `${artifactAddressFor(artifact)} uses ${guardId}`).toContain(
            guardId,
          )
          usedGuardIds.add(guardId)
        }

        if (artifact.runtime === "edge-safe") {
          expect(artifact.guardIds).toContain("edge-import-bundle")
        } else if (artifact.kind === "import") {
          expect(artifact.guardIds).toContain("node-import-bundle")
        } else {
          expect(artifact.guardIds).toContain("node-operated-bundle")
        }
        if (artifact.kind === "import" && artifact.purity === "dependency-free") {
          expect(artifact.guardIds).toContain("dependency-free-import-graph")
        }
      } else {
        expect("runtime" in artifact).toBe(false)
        expect("purity" in artifact).toBe(false)
        expect("guardIds" in artifact).toBe(false)
      }
    }

    expect(usedGuardIds).toEqual(knownGuardIds)
    const sandboxTesting = ARTIFACT_REGISTRY.find(
      (artifact) =>
        artifact.kind === "import" &&
        artifact.surfaceKind === "typescript-runtime" &&
        artifact.packageName === "@b4run/sandbox" &&
        artifact.subpath === "./testing",
    )
    expect(
      sandboxTesting && "guardIds" in sandboxTesting ? sandboxTesting.guardIds : undefined,
    ).toContain("browser-import-negative-control")
  })

  it("rejects missing and unknown compatibility guard IDs", () => {
    const runtimeArtifact = ARTIFACT_REGISTRY.find(
      (artifact) => artifact.kind === "import" && artifact.surfaceKind === "typescript-runtime",
    )
    expect(runtimeArtifact).toBeDefined()

    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@b4run/cli",
        subpath: "./missing-guards",
        guardIds: [],
      },
      /compatibility guard/i,
    )
    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@b4run/cli",
        subpath: "./unknown-guard",
        guardIds: ["stale-guard-id"],
      },
      /unknown compatibility guard/i,
    )
    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@b4run/cli",
        subpath: "./wrong-guard-kind",
        runtime: "edge-safe",
        guardIds: ["edge-import-bundle", "node-import-bundle"],
      },
      /inapplicable compatibility guard/i,
    )
    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@b4run/cli",
        subpath: "./duplicate-guard",
        guardIds: ["node-import-bundle", "node-import-bundle"],
      },
      /duplicate compatibility guard/i,
    )
    expectRegistryRejection(
      {
        kind: "import",
        packageName: "@b4run/config-biome",
        subpath: "./guarded-config",
        coverage: "catalog-only",
        surfaceKind: "config-artifact",
        audience: "tooling",
        stability: "supported",
        guardIds: ["edge-import-bundle"],
      },
      /invalid artifact fields.*guardIds/i,
    )
    expect(() =>
      validateApiReferenceRegistries({
        pages: API_REFERENCE_PAGES,
        artifacts: ARTIFACT_REGISTRY.map((artifact) =>
          artifact.kind === "generated"
            ? ({ ...artifact, guardIds: ["edge-import-bundle"] } as unknown as ApiReferenceArtifact)
            : artifact,
        ),
        packages: PACKAGE_CATALOG,
      }),
    ).toThrow(/invalid artifact fields.*guardIds/i)
    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@b4run/cli",
        subpath: "./audience-is-not-runtime",
        runtime: "testing",
      },
      /invalid runtime/i,
    )
    expect(() =>
      validateApiReferenceRegistries({
        pages: API_REFERENCE_PAGES,
        artifacts: ARTIFACT_REGISTRY.map((artifact) =>
          artifactAddressFor(artifact) === "import:@b4run/sdk:./testing"
            ? ({
                ...artifact,
                runtime: "node-only",
                purity: "dependency-free",
                guardIds: ["node-import-bundle", "browser-import-negative-control"],
              } as ApiReferenceArtifact)
            : artifact,
        ),
        packages: PACKAGE_CATALOG,
      }),
    ).toThrow(/dependency-free-import-graph/i)
    const operatedArtifact = ARTIFACT_REGISTRY.find((artifact) => artifact.kind === "operated")
    expect(operatedArtifact).toBeDefined()
    expectRegistryRejection(
      {
        ...operatedArtifact,
        packageName: "@b4run/cli",
        selector: "bin.edge-b4",
        runtime: "edge-safe",
      },
      /operated.*node-only|node-only.*operated/i,
    )
  })

  it("uses unique keys in separate import and operated address spaces", () => {
    const addresses = ARTIFACT_REGISTRY.map(artifactAddressFor)
    expect(new Set(addresses).size).toBe(addresses.length)
    expect(ARTIFACT_REGISTRY.filter(({ kind }) => kind === "import")).toHaveLength(44)
    expect(ARTIFACT_REGISTRY.filter(({ kind }) => kind === "operated")).toHaveLength(3)
    expect(ARTIFACT_REGISTRY.filter(({ kind }) => kind === "generated")).toEqual([
      GENERATED_ROUTES_ARTIFACT,
    ])
    expect(addresses).toContain("import:@b4run/cli:.")
    expect(addresses).toContain("operated:@b4run/cli:bin.b4")
    expect(addresses).not.toContain("import:@b4run/cli:bin.b4")
    expect(addresses).toContain("operated:@b4run/inspector:b4Inspector.server")
    expect(addresses).toContain("generated:b4:routes")
  })

  it("maps the manifest-less generated surface to its canonical page without package fields", () => {
    expect(GENERATED_ROUTES_ARTIFACT).toEqual({
      kind: "generated",
      moduleName: "b4:routes",
      ownerHref: "/docs/api/generated-routes",
      surfaceKind: "generated-types",
      coverage: "detailed",
      audience: "application",
      stability: "supported",
    })
    expect("packageName" in GENERATED_ROUTES_ARTIFACT).toBe(false)
    expect("runtime" in GENERATED_ROUTES_ARTIFACT).toBe(false)
    expect("purity" in GENERATED_ROUTES_ARTIFACT).toBe(false)
    expect(
      API_REFERENCE_PAGES.filter(
        ({ surfaceName, href }) =>
          surfaceName === GENERATED_ROUTES_ARTIFACT.moduleName &&
          href === GENERATED_ROUTES_ARTIFACT.ownerHref,
      ),
    ).toHaveLength(1)
  })

  it("pins the complete detailed, catalog, internal, and operated inventories", () => {
    expect(
      ARTIFACT_REGISTRY.flatMap((artifact) =>
        artifact.kind === "import" && artifact.coverage === "detailed"
          ? [[artifact.packageName, artifact.subpath]]
          : [],
      ),
    ).toEqual(EXPECTED_DETAILED_IMPORTS)
    expect(
      ARTIFACT_REGISTRY.flatMap((artifact) =>
        artifact.kind === "import" &&
        (artifact.coverage === "catalog-only" || artifact.coverage === "internal")
          ? [[artifact.packageName, artifact.subpath, artifact.coverage]]
          : [],
      ),
    ).toEqual(EXPECTED_CATALOG_AND_INTERNAL_IMPORTS)
    expect(
      ARTIFACT_REGISTRY.filter((artifact) => artifact.kind === "operated").map(
        ({
          packageName,
          selector,
          operatedKind,
          manifestTarget,
          coverage,
          runtime,
          audience,
          stability,
        }) => [
          packageName,
          selector,
          operatedKind,
          manifestTarget,
          coverage,
          runtime,
          audience,
          stability,
        ],
      ),
    ).toEqual(EXPECTED_OPERATED_ARTIFACTS)
    expect(
      ARTIFACT_REGISTRY.flatMap((artifact) => {
        const address = artifactAddressFor(artifact)
        if (!EXPECTED_FINAL_ARTIFACT_POLICIES.some(([expected]) => expected === address)) return []
        return [
          [
            address,
            artifact.coverage,
            artifact.kind === "import" ? artifact.surfaceKind : artifact.kind,
            "runtime" in artifact ? artifact.runtime : null,
            "purity" in artifact ? artifact.purity : null,
            artifact.audience,
            artifact.stability,
          ],
        ]
      }),
    ).toEqual(EXPECTED_FINAL_ARTIFACT_POLICIES)
  })

  it("rejects address-preserving artifact policy mutations", () => {
    const coverageMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@b4run/core:./internal/compiler"
        ? { ...artifact, coverage: "detailed" }
        : artifact,
    )
    const kindMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@b4run/core:./internal/compiler"
        ? { ...artifact, surfaceKind: "metadata" }
        : artifact,
    )
    const guardMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@b4run/sdk:./pure"
        ? { ...artifact, guardIds: ["edge-import-bundle"] }
        : artifact,
    )
    const runtimeMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@b4run/sdk:./testing"
        ? { ...artifact, runtime: "testing" }
        : artifact,
    )
    const staticGuardMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@b4run/config-biome:."
        ? { ...artifact, guardIds: ["edge-import-bundle"] }
        : artifact,
    )

    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, coverageMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*internal\/compiler.*coverage/),
    ])
    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, kindMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*internal\/compiler.*surfaceKind/),
    ])
    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, guardMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*sdk.*pure.*guardIds/),
    ])
    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, runtimeMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*sdk.*testing.*runtime/),
    ])
    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, staticGuardMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*config-biome.*guardIds/),
    ])
  })

  it("keeps runtime and purity claims applicable to runtime TypeScript imports", () => {
    for (const artifact of ARTIFACT_REGISTRY) {
      if (artifact.kind === "import" && artifact.surfaceKind === "typescript-runtime") {
        expect(["node-only", "edge-safe"]).toContain(artifact.runtime)
        expect(["dependency-free", "not-claimed"]).toContain(artifact.purity)
      } else if (artifact.kind === "operated") {
        expect(["node-only", "edge-safe"]).toContain(artifact.runtime)
        expect("purity" in artifact).toBe(false)
      } else {
        expect("runtime" in artifact).toBe(false)
        expect("purity" in artifact).toBe(false)
      }
    }
  })

  it("does not recommend catalog-only or internal surfaces to applications", () => {
    for (const artifact of ARTIFACT_REGISTRY) {
      if (artifact.coverage === "catalog-only" || artifact.coverage === "internal") {
        expect(artifact.audience).not.toBe("application")
      }
    }
  })

  it("rejects duplicate addresses and invalid discriminant combinations", () => {
    const retiredCoverage = ["deferred", "to", "pr2"].join("-")
    const retiredCoverageArtifact = {
      ...ARTIFACT_REGISTRY[0],
      coverage: retiredCoverage,
    }
    expect(() =>
      validateApiReferenceRegistries({
        pages: API_REFERENCE_PAGES,
        artifacts: ARTIFACT_REGISTRY.map((artifact, index) =>
          index === 0 ? (retiredCoverageArtifact as unknown as ApiReferenceArtifact) : artifact,
        ),
        packages: PACKAGE_CATALOG,
      }),
    ).toThrow(new RegExp(`invalid coverage: ${retiredCoverage}`))
    expect(
      analyzeApiReferenceRegistry(
        API_REFERENCE_PAGES,
        ARTIFACT_REGISTRY.map((artifact, index) =>
          index === 0 ? retiredCoverageArtifact : artifact,
        ),
      ).failures,
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`invalid coverage: ${retiredCoverage}`)),
      ]),
    )

    expectRegistryRejection({ ...ARTIFACT_REGISTRY[0] }, /duplicate artifact address/)
    expectRegistryRejection(
      {
        kind: "import",
        packageName: "@b4run/cli",
        subpath: "bin.b4",
        coverage: "detailed",
        surfaceKind: "typescript-runtime",
        runtime: "node-only",
        audience: "tooling",
        purity: "not-claimed",
        stability: "supported",
      },
      /operated selector|import subpath/,
    )
    expectRegistryRejection(
      {
        kind: "import",
        packageName: "@b4run/inspector",
        subpath: ".",
        coverage: "catalog-only",
        surfaceKind: "typescript-runtime",
        runtime: "node-only",
        audience: "tooling",
        purity: "not-claimed",
        stability: "supported",
      },
      /operated artifact/,
    )
    expectRegistryRejection(
      {
        kind: "import",
        packageName: "@b4run/config-biome",
        subpath: ".",
        coverage: "catalog-only",
        surfaceKind: "config-artifact",
        runtime: "node-only",
        audience: "tooling",
        stability: "supported",
      },
      /import:@b4run\/config-biome:\.[\s\S]*runtime/,
    )
    expectRegistryRejection(
      {
        kind: "operated",
        packageName: "create-b4-app",
        selector: "bin.create-b4-app",
        operatedKind: "executable",
        coverage: "catalog-only",
        runtime: "node-only",
        audience: "application",
        stability: "supported",
      },
      /application audience/,
    )
  })
})

describe("published manifest address inventory", { timeout: 30_000 }, () => {
  it("matches exports, bins, and the Inspector server while ignoring package imports", () => {
    const manifests = publicPackageManifests()
    expect(analyzeApiReferenceManifests(manifests).failures).toEqual([])

    const langchain = manifests.find(({ name }) => name === "@b4run/langchain")
    expect(langchain).toBeDefined()
    if (!langchain) throw new Error("LangChain manifest fixture is missing")
    langchain.imports = {
      ...(langchain.imports ?? {}),
      "#another-internal-import": "./internal.js",
    }
    expect(analyzeApiReferenceManifests(manifests).failures).toEqual([])
  })

  it.each([
    [
      "added",
      (manifest: ManifestFixture) => {
        if (!manifest.exports) throw new Error("SDK exports fixture is missing")
        manifest.exports["./unexpected"] = "./dist/unexpected.js"
      },
    ],
    [
      "removed",
      (manifest: ManifestFixture) => {
        if (!manifest.exports) throw new Error("SDK exports fixture is missing")
        delete manifest.exports["./testing"]
      },
    ],
    [
      "renamed",
      (manifest: ManifestFixture) => {
        if (!manifest.exports) throw new Error("SDK exports fixture is missing")
        manifest.exports["./test-support"] = manifest.exports["./testing"]
        delete manifest.exports["./testing"]
      },
    ],
  ])("rejects an %s exports subpath", (_name, mutate) => {
    expect(mutatedManifestAnalysis("@b4run/sdk", mutate).failures.join("\n")).toMatch(
      /manifest.*import:@b4run\/sdk/,
    )
  })

  it.each([
    [
      "added",
      (manifest: ManifestFixture) => {
        if (!manifest.bin) throw new Error("CLI bin fixture is missing")
        manifest.bin["b4-extra"] = "./dist/index.js"
      },
    ],
    [
      "removed",
      (manifest: ManifestFixture) => {
        if (!manifest.bin) throw new Error("CLI bin fixture is missing")
        delete manifest.bin.b4
      },
    ],
    [
      "renamed",
      (manifest: ManifestFixture) => {
        if (!manifest.bin) throw new Error("CLI bin fixture is missing")
        manifest.bin.sunrise = manifest.bin.b4 ?? "./dist/index.js"
        delete manifest.bin.b4
      },
    ],
  ])("rejects an %s executable bin", (_name, mutate) => {
    expect(mutatedManifestAnalysis("@b4run/cli", mutate).failures.join("\n")).toMatch(
      /manifest.*operated:@b4run\/cli/,
    )
  })

  it.each([
    [
      "removed",
      (manifest: ManifestFixture) => {
        if (!manifest.b4Inspector) throw new Error("Inspector fixture is missing")
        delete manifest.b4Inspector.server
      },
    ],
    [
      "changed",
      (manifest: ManifestFixture) => {
        if (!manifest.b4Inspector) throw new Error("Inspector fixture is missing")
        manifest.b4Inspector.server = "./different-server.js"
      },
    ],
  ])("rejects a %s Inspector server", (_name, mutate) => {
    expect(mutatedManifestAnalysis("@b4run/inspector", mutate).failures.join("\n")).toMatch(
      /manifest.*operated:@b4run\/inspector/,
    )
  })
})

describe("package catalog", { timeout: 30_000 }, () => {
  // `changeset version` deletes this changeset when the release is cut, and the
  // Version PR runs this suite against the versioned tree — so on a release commit
  // the file is legitimately gone and there is no pending bump list left to pin.
  // Reading it unconditionally made the release, and only the release, red.
  it.skipIf(!existsSync(CHANGESET_PATH))("pins the exact twelve-package patch changeset", () => {
    const source = readFileSync(CHANGESET_PATH, "utf8")
    const entries = [...source.matchAll(/^"([^"]+)": (\w+)$/gm)].map((match) => [
      match[1],
      match[2],
    ])
    expect(entries).toEqual([
      ["@b4run/permissions", "patch"],
      ["@b4run/workspace", "patch"],
      ["@b4run/sandbox", "patch"],
      ["@b4run/langgraph", "patch"],
      ["@b4run/langchain", "patch"],
      ["@b4run/sqlite-storage", "patch"],
      ["create-b4-app", "patch"],
      ["@b4run/config-biome", "patch"],
      ["@b4run/config-typescript", "patch"],
      ["@b4run/devkit", "patch"],
      ["@b4run/inspector", "patch"],
      ["@b4run/vite-plugin", "patch"],
    ])
  })

  it("registers every authored high-value signature contract exactly once", () => {
    expect(API_REQUIRED_CONTRACT_KEYS).toEqual(EXPECTED_REQUIRED_CONTRACT_KEYS)
    expect(API_REQUIRED_CONTRACT_KEYS).toHaveLength(106)
    expect(new Set(API_REQUIRED_CONTRACT_KEYS).size).toBe(API_REQUIRED_CONTRACT_KEYS.length)
    expect(API_REQUIRED_CONTRACT_KEYS).toContain("@b4run/sdk#.:agent")
    expect(API_REQUIRED_CONTRACT_KEYS).toContain("@b4run/memory#.:MemoryStore")
    expect(API_REQUIRED_CONTRACT_KEYS).toContain("@b4run/evals#.:runEval")
  })

  it("matches readPublicPackages bidirectionally", () => {
    const catalogNames = PACKAGE_CATALOG.map(({ packageName }) => packageName).sort()
    expect(catalogNames).toHaveLength(21)
    expect(catalogNames).toEqual([...publicPackageNames()].sort())
  })

  it("associates every package and artifact bidirectionally", () => {
    const catalogByName = new Map(PACKAGE_CATALOG.map((entry) => [entry.packageName, entry]))
    const registryAddressesByPackage = new Map<string, string[]>()
    for (const artifact of ARTIFACT_REGISTRY) {
      if (artifact.kind === "generated") continue
      const addresses = registryAddressesByPackage.get(artifact.packageName) ?? []
      addresses.push(artifactAddressFor(artifact))
      registryAddressesByPackage.set(artifact.packageName, addresses)
    }

    for (const entry of PACKAGE_CATALOG) {
      expect(entry.readmePath).toMatch(/^packages\/[^/]+\/README\.md$/)
      expect([...entry.artifactAddresses].sort()).toEqual(
        [...(registryAddressesByPackage.get(entry.packageName) ?? [])].sort(),
      )
    }
    for (const artifact of ARTIFACT_REGISTRY) {
      if (artifact.kind === "generated") continue
      expect(catalogByName.get(artifact.packageName)?.artifactAddresses).toContain(
        artifactAddressFor(artifact),
      )
    }
  })

  it("rejects generated records that bypass their closed registry branch", () => {
    expectRegistryRejection(
      { ...GENERATED_ROUTES_ARTIFACT, packageName: "@b4run/core" },
      /generated artifact|invalid artifact fields|packageName/i,
    )
  })

  it("routes detailed owners to leaves and all other packages to hub anchors", () => {
    const leafByOwner = new Map(
      API_REFERENCE_PAGES.flatMap((page) =>
        page.surfaceName === "b4:routes"
          ? []
          : page.ownerPackageNames.map((packageName) => [packageName, page.href] as const),
      ),
    )

    for (const entry of PACKAGE_CATALOG) {
      const leaf = leafByOwner.get(entry.packageName)
      if (leaf) {
        expect(entry.canonicalReferenceDestination).toBe(leaf)
      } else {
        expect(entry.canonicalReferenceDestination).toBe(
          EXPECTED_CATALOG_DESTINATIONS.get(entry.packageName),
        )
      }
    }
    expect([...EXPECTED_CATALOG_DESTINATIONS]).toHaveLength(6)
  })
})

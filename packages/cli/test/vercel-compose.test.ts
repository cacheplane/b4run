import { join } from "node:path"
import type { B4Config } from "@b4run/core"
import { describe, expect, test } from "vitest"
import {
  composeVercelRoutes,
  DEFAULT_VERCEL_FUNCTION_NAME,
  resolveVercelComposition,
  VERCEL_RUNTIME_ROUTE_SRC,
} from "../src/lib/build/targets/vercel-compose.ts"
import { resolveVercelBuildConfig } from "../src/lib/build/targets/vercel-config.ts"
import { CliError } from "../src/lib/output.ts"

const appRoot = join("/", "app")

describe("resolveVercelComposition", () => {
  test("an absent config resolves to the bare runtime function named b4", () => {
    expect(resolveVercelComposition(undefined, appRoot)).toEqual({
      functionName: DEFAULT_VERCEL_FUNCTION_NAME,
      functions: [],
      routes: [],
    })
    expect(DEFAULT_VERCEL_FUNCTION_NAME).toBe("b4")
  })

  test("the runtime function stays off the root name with no static assets", () => {
    // The Build Output API serves a function named `index` at `/`, so the name
    // is off the root whether or not this build emits anything it could shadow.
    expect(resolveVercelComposition({}, appRoot).functionName).toBe("b4")
    expect(
      resolveVercelComposition({ routes: [{ dest: "/b", src: "/a" }] }, appRoot).functionName,
    ).toBe("b4")
  })

  test("a static dir keeps the same off-root default", () => {
    const resolved = resolveVercelComposition(
      { static: { dir: "../dist/web", spaFallback: "index.html" } },
      appRoot,
    )
    expect(resolved.functionName).toBe(DEFAULT_VERCEL_FUNCTION_NAME)
    expect(resolved.static).toEqual({
      dir: join("/", "dist", "web"),
      spaFallback: "index.html",
    })
  })

  test("an explicit functionName wins over the default", () => {
    expect(resolveVercelComposition({ functionName: "agent" }, appRoot).functionName).toBe("agent")
    expect(
      resolveVercelComposition({ functionName: "agent", static: { dir: "dist" } }, appRoot)
        .functionName,
    ).toBe("agent")
  })

  test("resolves extra functions relative to the app root with the node24 runtime default", () => {
    const resolved = resolveVercelComposition(
      {
        functions: {
          api: { entry: "src/api.ts", maxDuration: 30 },
          hooks: {
            entry: "src/hooks.ts",
            runtime: "nodejs22.x",
            supportsResponseStreaming: true,
          },
        },
      },
      appRoot,
    )
    expect(resolved.functions).toEqual([
      {
        entry: join(appRoot, "src", "api.ts"),
        maxDuration: 30,
        name: "api",
        runtime: "nodejs24.x",
      },
      {
        entry: join(appRoot, "src", "hooks.ts"),
        name: "hooks",
        runtime: "nodejs22.x",
        supportsResponseStreaming: true,
      },
    ])
  })

  test("passes user routes through", () => {
    const routes = [
      { dest: "/api", src: "/api/(.*)" },
      { headers: { "x-a": "1" }, src: "/x" },
    ]
    expect(resolveVercelComposition({ routes }, appRoot).routes).toEqual(routes)
  })

  test.each([
    {
      config: { functionName: "index", static: { dir: "dist" } },
      expected: "build.vercel.functionName",
    },
    { config: { functionName: "" }, expected: "build.vercel.functionName" },
    { config: { functionName: "a/b" }, expected: "build.vercel.functionName" },
    {
      config: { functionName: "api", functions: { api: { entry: "x.ts" } } },
      expected: "build.vercel.functions.api",
    },
    {
      config: { functions: { "bad name": { entry: "x.ts" } } },
      expected: 'build.vercel.functions["bad name"]',
    },
    {
      config: { functions: { api: {} } },
      expected: "build.vercel.functions.api.entry",
    },
    {
      config: { functions: { api: { entry: "x.ts", maxDuration: 0 } } },
      expected: "build.vercel.functions.api.maxDuration",
    },
    {
      config: { functions: { api: { entry: "x.ts", maxDuration: 1.5 } } },
      expected: "build.vercel.functions.api.maxDuration",
    },
    {
      config: { functions: { api: { entry: "x.ts", runtime: "python3" } } },
      expected: "build.vercel.functions.api.runtime",
    },
    {
      config: {
        functions: { api: { entry: "x.ts", supportsResponseStreaming: "yes" } },
      },
      expected: "build.vercel.functions.api.supportsResponseStreaming",
    },
    {
      config: { functions: { api: { entry: "x.ts", extra: 1 } } },
      expected: "build.vercel.functions.api.extra",
    },
    { config: { static: {} }, expected: "build.vercel.static.dir" },
    {
      config: { static: { dir: "dist", spaFallback: "/index.html" } },
      expected: "build.vercel.static.spaFallback",
    },
    {
      config: { static: { dir: "dist", spaFallback: "../index.html" } },
      expected: "build.vercel.static.spaFallback",
    },
    { config: { routes: {} }, expected: "build.vercel.routes" },
    {
      config: { routes: [{ dest: "/x" }] },
      expected: "build.vercel.routes[0].src",
    },
    {
      config: { routes: [{ handle: "filesystem" }] },
      expected: "build.vercel.routes[0].handle",
    },
    {
      config: { routes: [{ src: "/x", extra: true }] },
      expected: "build.vercel.routes[0].extra",
    },
    { config: { unknown: true }, expected: "build.vercel.unknown" },
    { config: [], expected: "build.vercel" },
  ])("rejects $expected", ({ config, expected }) => {
    expect(() => resolveVercelComposition(config, appRoot)).toThrow(CliError)
    expect(() => resolveVercelComposition(config, appRoot)).toThrow(expected)
  })
})

describe("composeVercelRoutes", () => {
  test("the bare runtime keeps the exact catch-all", () => {
    expect(composeVercelRoutes({ functionName: "index", routes: [] })).toEqual([
      { dest: "/index", src: "/(.*)" },
    ])
  })

  test("user routes come first, then the filesystem, then the runtime catch-all", () => {
    expect(
      composeVercelRoutes({
        functionName: "b4",
        routes: [{ dest: "/api", src: "/api/(.*)" }],
      }),
    ).toEqual([
      { dest: "/api", src: "/api/(.*)" },
      { handle: "filesystem" },
      { dest: "/b4", src: "/(.*)" },
    ])
  })

  test("a SPA fallback scopes the runtime to its own surfaces and lands last", () => {
    expect(
      composeVercelRoutes({
        functionName: "b4",
        routes: [{ dest: "/api", src: "/api/(.*)" }],
        spaFallback: "index.html",
      }),
    ).toEqual([
      { dest: "/api", src: "/api/(.*)" },
      { handle: "filesystem" },
      { dest: "/b4", src: VERCEL_RUNTIME_ROUTE_SRC },
      { dest: "/index.html", src: "/(.*)" },
    ])
    expect(VERCEL_RUNTIME_ROUTE_SRC).toBe("/(healthz|readyz|agui|threads|memory)(/.*)?")
  })

  test("a bare runtime with only a static dir still gets the filesystem phase", () => {
    expect(composeVercelRoutes({ functionName: "b4", routes: [], hasStatic: true })).toEqual([
      { handle: "filesystem" },
      { dest: "/b4", src: "/(.*)" },
    ])
  })
})

/**
 * A `b4.config.js` or a JSON config arrives with no compiler behind it, so the
 * runtime rejections below are reached with shapes the typed config forbids.
 */
function untypedBuild(build: unknown): B4Config["build"] {
  return build as B4Config["build"]
}

describe("resolveVercelBuildConfig (one validated build.vercel)", () => {
  test("returns the reconciliation flag and the composition together", () => {
    const resolved = resolveVercelBuildConfig(
      {
        targets: ["vercel"],
        vercel: {
          functions: { api: { entry: "src/api.ts" } },
          reconcileVercelJson: false,
          routes: [{ dest: "/api", src: "/api/(.*)" }],
          static: { dir: "web/dist", spaFallback: "index.html" },
        },
      },
      appRoot,
    )

    expect(resolved.reconcileVercelJson).toBe(false)
    expect(resolved.composition.functionName).toBe(DEFAULT_VERCEL_FUNCTION_NAME)
    expect(resolved.composition.static).toEqual({
      dir: join(appRoot, "web", "dist"),
      spaFallback: "index.html",
    })
    expect(resolved.composition.functions).toHaveLength(1)
    expect(resolved.composition.routes).toEqual([{ dest: "/api", src: "/api/(.*)" }])
  })

  test("composition keys alone leave reconciliation on", () => {
    const resolved = resolveVercelBuildConfig({ vercel: { static: { dir: "web/dist" } } }, appRoot)

    expect(resolved.reconcileVercelJson).toBe(true)
    expect(resolved.composition.functionName).toBe(DEFAULT_VERCEL_FUNCTION_NAME)
  })

  test("the flag alone leaves the bare runtime composition", () => {
    const resolved = resolveVercelBuildConfig({ vercel: { reconcileVercelJson: false } }, appRoot)

    expect(resolved.reconcileVercelJson).toBe(false)
    expect(resolved.composition).toEqual({
      functionName: DEFAULT_VERCEL_FUNCTION_NAME,
      functions: [],
      routes: [],
    })
  })

  test("an absent build section is the default on both axes", () => {
    const resolved = resolveVercelBuildConfig(undefined, appRoot)

    expect(resolved.reconcileVercelJson).toBe(true)
    expect(resolved.composition.functionName).toBe(DEFAULT_VERCEL_FUNCTION_NAME)
  })

  test("an unknown option names every known option, composition keys included", () => {
    expect(() =>
      resolveVercelBuildConfig(untypedBuild({ vercel: { reconcileVercelJSON: false } }), appRoot),
    ).toThrow(/Unknown build\.vercel option\(s\): reconcileVercelJSON/)
    expect(() =>
      resolveVercelBuildConfig(untypedBuild({ vercel: { reconcileVercelJSON: false } }), appRoot),
    ).toThrow(/functionName.*functions.*reconcileVercelJson.*routes.*static/)
  })

  test("a misplaced flag directly on build is still rejected", () => {
    expect(() =>
      resolveVercelBuildConfig(untypedBuild({ reconcileVercelJson: false }), appRoot),
    ).toThrow(/belongs under build\.vercel/)
  })

  test("a non-boolean flag is still rejected", () => {
    expect(() =>
      resolveVercelBuildConfig(untypedBuild({ vercel: { reconcileVercelJson: "false" } }), appRoot),
    ).toThrow(/reconcileVercelJson must be a boolean/)
  })

  test("a composition error surfaces through the same entry point", () => {
    expect(() =>
      resolveVercelBuildConfig(
        { vercel: { functionName: "index", static: { dir: "web/dist" } } },
        appRoot,
      ),
    ).toThrow(/build\.vercel\.functionName/)
  })
})

describe("the scoped runtime route covers every B4.run surface", () => {
  const runtimeRoute = new RegExp(`^${VERCEL_RUNTIME_ROUTE_SRC}$`)

  // Every rooted surface the runtime fetch handler answers. A new one added to
  // the runtime without being added here would silently fall through to the
  // SPA document on a Vercel deployment that configures a fallback.
  test.each([
    "/healthz",
    "/readyz",
    "/threads",
    "/threads/abc",
    "/threads/abc/runs/stream",
    "/agui/route-id",
    "/memory/candidates",
    "/memory/candidates/id/approve",
  ])("routes %s to the runtime function", (path) => {
    expect(runtimeRoute.test(path)).toBe(true)
  })

  test.each(["/", "/index.html", "/assets/app.js", "/about"])(
    "leaves %s for the filesystem and the SPA fallback",
    (path) => {
      expect(runtimeRoute.test(path)).toBe(false)
    },
  )
})

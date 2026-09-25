import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BUILD_TARGET_NAMES } from "@b4run/core"
import { describe, expect, it } from "vitest"
import {
  APP_NAME,
  BUILD_COMMAND,
  BUILD_IDS,
  EDGE_PACKAGES,
  EVAL_COMMAND,
  normalizeTranscript,
  TEST_COMMAND,
} from "../../../../scripts/export-homepage-demos.mjs"
import { DOCS_INDEX } from "../../docs/search-index"
import hono from "./fixtures/targets/hono"
import langsmith from "./fixtures/targets/langsmith"
import node from "./fixtures/targets/node"
import vercel from "./fixtures/targets/vercel"
import {
  buildFor,
  buildOutputs,
  deployTargets,
  describeReplay,
  describeTarget,
  type ReplayId,
  replaySummary,
  SHIP_FIXTURES,
  shipLinks,
  testReplay,
  writtenFiles,
} from "./ship-data"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8")
const TEMPLATE = "packages/devkit/templates/app-basic/"
const runOf = (id: ReplayId) => {
  const run = testReplay.runs.find((candidate) => candidate.id === id)
  if (!run) throw new Error(`No recorded ${id} run`)
  return run
}
const recordings = JSON.stringify([testReplay, buildOutputs])

describe("the recordings are cleaned, and only cleaned", () => {
  it("drops ANSI codes, timings and the temp path, and nothing else", () => {
    const raw = [
      "",
      "\u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv4.1.11 \u001b[39m\u001b[90m/private/var/t/my-agent\u001b[39m",
      "",
      "",
      " \u001b[32m✓\u001b[39m test/agent.test.ts\u001b[2m > \u001b[22mgreets by name\u001b[32m 246\u001b[2mms\u001b[22m\u001b[39m\r",
      "   Start at  12:31:06",
      "   Duration  1.18s (transform 14ms, setup 0ms)",
      "PASS greets by name › ada mean=1.00 [contains(Hello)=1.00]",
      "Build complete: .b4/build (in /var/t/my-agent)",
      "",
    ].join("\n")
    expect(normalizeTranscript(raw, ["/var/t/my-agent", "/private/var/t/my-agent"])).toEqual([
      " RUN  v4.1.11 my-agent",
      "",
      " ✓ test/agent.test.ts > greets by name",
      "PASS greets by name › ada mean=1.00 [contains(Hello)=1.00]",
      "Build complete: .b4/build (in my-agent)",
    ])
  })

  it("leaves no escape codes, timings, absolute paths or model key in either file", () => {
    expect(recordings).not.toContain(String.fromCharCode(27))
    expect(recordings).not.toContain("\\u001b")
    expect(recordings).not.toMatch(/\d+(?:\.\d+)?ms\b|Start at|Duration/)
    expect(recordings).not.toMatch(/\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/|[A-Z]:\\\\/)
    expect(recordings).not.toMatch(/OPENAI_API_KEY|sk-[A-Za-z0-9]/)
    expect([testReplay.app, buildOutputs.app]).toEqual([APP_NAME, APP_NAME])
  })
})

describe("the test replay is the scaffold's own npm test and b4 eval", () => {
  it("records the two commands the page offers, in order", () => {
    expect(testReplay.runs.map((run) => [run.id, run.command])).toEqual([
      ["test", TEST_COMMAND],
      ["eval", EVAL_COMMAND],
    ])
  })

  it("runs the scaffold's test script and passes its one test, by name", () => {
    const script = JSON.parse(read(`${TEMPLATE}package.json.template`)).scripts.test
    const testName = /\bit\("([^"]+)"/.exec(read(`${TEMPLATE}test/agent.test.ts.template`))?.[1]
    expect(testName).toBe("greets by name")
    const { lines } = runOf("test")
    expect(lines).toContain(`> ${script} --reporter=verbose`)
    expect(lines).toContain(` ✓ test/agent.test.ts > ${testName}`)
    expect(lines.filter((line) => /passed/.test(line))).toEqual([
      " Test Files  1 passed (1)",
      "      Tests  1 passed (1)",
    ])
    expect(lines.join("\n")).not.toMatch(/failed|✗|×|FAIL/)
  })

  it("prints the eval's PASS lines in the CLI reporter's own format", () => {
    const smoke = read(`${TEMPLATE}src/app/hello/evals/smoke.eval.ts.template`)
    const [suite, testCase] = [...smoke.matchAll(/\bname: "([^"]+)"/g)].map((match) => match[1])
    expect([suite, testCase]).toEqual(["greets by name", "ada"])
    // The format is the reporter's: these are its two template literals, as source text.
    const reporter = read("packages/cli/src/commands/eval.ts")
    expect(reporter).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the reporter's source text.
      '`${c.passed ? "PASS" : "FAIL"} ${report.name} › ${c.name} mean=${c.mean.toFixed(2)} [${detail}]`',
    )
    expect(reporter).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the reporter's source text.
      '`${verdict} ${report.name} mean=${report.mean.toFixed(2)}${report.reason ? ` (${report.reason})` : ""}`',
    )
    expect(runOf("eval").lines).toEqual([
      `PASS ${suite} › ${testCase} mean=1.00 [contains(Hello)=1.00]`,
      `PASS ${suite} mean=1.00`,
    ])
  })

  it("announces the command and how it ended, and words a repeat differently", () => {
    expect(replaySummary(runOf("test"))).toBe("Tests 1 passed (1)")
    expect(describeReplay(runOf("test"), false)).toBe(
      "Replayed npm test -- --reporter=verbose. Tests 1 passed (1).",
    )
    expect(describeReplay(runOf("eval"), true)).toBe(
      "Replayed npx b4 eval again. PASS greets by name mean=1.00.",
    )
  })
})

describe("the deploy targets are the CLI's own, built for real", () => {
  it("offers every build target the CLI knows, in its order, then Kubernetes", () => {
    expect(deployTargets.map((target) => target.id)).toEqual([...BUILD_TARGET_NAMES, "kubernetes"])
    expect(buildOutputs.command).toBe(BUILD_COMMAND)
    expect(buildOutputs.builds.map((build) => build.id)).toEqual(BUILD_IDS)
    expect(BUILD_IDS).toEqual(["default", ...BUILD_TARGET_NAMES])
  })

  it("builds each target with its own typechecked config, which lists only that target", () => {
    const configs = { node, langsmith, hono, vercel }
    for (const name of BUILD_TARGET_NAMES) {
      expect(configs[name].build?.targets, name).toEqual([name])
      expect(buildFor(name).config, name).toBe(read(`${SHIP_FIXTURES}${name}.ts`))
    }
  })

  it("emits node and langsmith by default, and a build.targets list replaces them", () => {
    expect(buildFor("default").config).toBe(read(`${TEMPLATE}b4.config.ts`))
    expect(buildFor("default").lines).toContain("  targets: node, langsmith")
    expect(writtenFiles(buildFor("default"))).toEqual([
      ...writtenFiles(buildFor("node")),
      ...writtenFiles(buildFor("langsmith")),
    ])
    for (const name of BUILD_TARGET_NAMES) {
      expect(buildFor(name).lines, name).toContain(`  targets: ${name}`)
    }
    expect(read("apps/web/content/docs/deployment.mdx")).toContain(
      "Specifying build targets replaces the defaults.",
    )
  })

  it("writes the files each target's docs page lists", () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      node: [".b4/build/server.mjs", "Dockerfile"],
      langsmith: [".b4/build/langgraph.json"],
      hono: [".b4/build/app.mjs", "wrangler.toml"],
      vercel: [".vercel/output/functions/b4.func/index.mjs", "vercel.json"],
    }
    for (const target of deployTargets) {
      const files = writtenFiles(buildFor(target.build))
      const page = read(`apps/web/content/docs${target.docsHref.split("#")[0]?.slice(5)}.mdx`)
      for (const file of expected[target.build] ?? []) {
        expect(files, target.id).toContain(file)
        if (target.id !== "kubernetes") expect(page, `${target.id} ${file}`).toContain(file)
      }
    }
  })

  it("installs Kubernetes with the docs' own commands, in the docs' order, and the repository's chart", () => {
    const docs = read("apps/web/content/docs/deployment/kubernetes.mdx")
    const kubernetes = deployTargets.find((target) => target.id === "kubernetes")
    expect(kubernetes?.build).toBe("node")
    // Every command in the page's bash blocks, a backslash-continued command as one.
    const commands = [...docs.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((block) =>
      (block[1] ?? "").split(/(?<!\\)\n/).filter(Boolean),
    )
    const from = commands.indexOf("b4 build")
    const to = commands.findIndex((command) => command.startsWith("helm install b4-app "))
    expect([from, to].every((index) => index >= 0)).toBe(true)
    // From `b4 build` to the app's install, skipping only the sandbox chart the
    // scaffold (no kubernetesSandbox) doesn't need.
    const docsOrder = commands
      .slice(from, to + 1)
      .filter((command) => !command.includes("b4-sandbox-infra"))
    expect([buildOutputs.command.replace(/^npx /, ""), ...(kubernetes?.after ?? [])]).toEqual(
      docsOrder,
    )
    expect(docsOrder.map((command) => command.split(" ").slice(0, 2).join(" "))).toEqual([
      "b4 build",
      "docker build",
      "docker push",
      "helm install",
    ])
    expect(read("charts/b4-app/Chart.yaml")).toMatch(/^name: b4-app$/m)
  })

  it("names the packages the edge builds needed, as their docs pages do", () => {
    // The scaffold's route runs gpt-5-mini, an OpenAI model, whose provider package this is.
    expect(read(`${TEMPLATE}src/app/hello/index.ts`)).toMatch(/model: "gpt-5-mini"/)
    expect(read("packages/langchain/src/chat-model-factory.ts")).toMatch(
      /openai: \{\s*packageName: "@langchain\/openai",/,
    )
    expect(EDGE_PACKAGES).toEqual([
      "@b4run/postgres-storage",
      "@neondatabase/serverless",
      "hono",
      "@langchain/openai",
    ])
    const scaffold = JSON.parse(read(`${TEMPLATE}package.json.template`)).dependencies
    for (const target of deployTargets) {
      const edge = target.id === "hono" || target.id === "vercel"
      for (const name of EDGE_PACKAGES) {
        expect(target.summary.includes(name), `${target.id} ${name}`).toBe(edge)
      }
      if (!edge) continue
      const page = read(`apps/web/content/docs${target.docsHref.split("#")[0]?.slice(5)}.mdx`)
      // The docs name every package but the provider, which they call the
      // model-provider package; the scaffold already depends on @b4run/cli.
      expect(page, target.id).toMatch(/model-provider package/)
      for (const name of ["@b4run/cli", ...EDGE_PACKAGES.slice(0, -1)]) {
        expect(page, `${target.id} ${name}`).toContain(`\`${name}\``)
      }
      expect(scaffold).toHaveProperty(["@b4run/cli"])
      for (const name of EDGE_PACKAGES) expect(scaffold).not.toHaveProperty([name])
    }
  })

  it("announces the target and the files its build writes", () => {
    const [first] = deployTargets
    if (!first) throw new Error("No targets")
    expect(describeTarget(first)).toBe(
      "Deploy target node. The full B4 HTTP runtime as a Node server, with a Dockerfile. b4 build writes .b4/build/workspace.json, .b4/build/modules.mjs, .b4/build/server.mjs, Dockerfile.",
    )
  })

  it("links to docs headings that exist", () => {
    for (const href of [
      ...deployTargets.map((target) => target.docsHref),
      ...shipLinks.map((link) => link.href),
    ]) {
      const [path, anchor] = href.split("#")
      const page = DOCS_INDEX.find((entry) => entry.href === path)
      expect(page, href).toBeDefined()
      expect(
        page?.headings.map((heading) => heading.anchor),
        href,
      ).toContain(anchor)
    }
  })
})

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "vitest"
import { createPackedConsumer, runCommand } from "./_helpers/packed-consumer.ts"

const repoRoot = resolve(import.meta.dirname, "../../..")

test("packed route entrypoints work without optional LangChain peers", {
  timeout: 30_000,
}, async () => {
  const { consumerDir, tempRoot } = await createPackedConsumer()
  try {
    const script = join(consumerDir, "isolated.mjs")
    await writeFile(
      script,
      `
import { defineEntry } from "@b4run/langgraph";
import { defineEntry as subpath } from "@b4run/langgraph/define-entry";
import { normalizeRouteModule } from "@b4run/langgraph/route-module";
const entry = defineEntry({ graph: () => "ok" });
if (subpath(entry) !== entry || normalizeRouteModule(entry).kind !== "graph") throw Error("entry failed");
for (const peer of ["@langchain/core", "langchain", "@langchain/langgraph"]) {
  try { import.meta.resolve(peer); throw Error("unexpected optional peer " + peer); }
  catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
}
`,
    )

    const result = await runCommand("node", [script], consumerDir)

    expect(result).toEqual({ stdout: "", stderr: "" })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("packed ui exports executable helpers and public TypeScript signatures", {
  timeout: 30_000,
}, async () => {
  const { consumerDir, tempRoot } = await createPackedConsumer()
  try {
    // Provide only the approved peers from this checkout; their own dependency
    // trees remain intact and no registry/model access is needed by this probe.
    await mkdir(join(consumerDir, "node_modules/@langchain"), { recursive: true })
    for (const peer of ["@langchain/core", "langchain", "@langchain/langgraph"]) {
      const target = await realpath(join(repoRoot, "packages/langgraph/node_modules", peer))
      await symlink(target, join(consumerDir, "node_modules", peer))
    }
    const script = join(consumerDir, "ui.mjs")
    await writeFile(
      script,
      `
import { emitToolStep, toolStepMiddleware } from "@b4run/langgraph/ui";
import { RunnableLambda } from "@langchain/core/runnables";
if (typeof toolStepMiddleware().wrapToolCall !== "function") throw Error("no packed middleware");
const step = { v: 1, kind: "server", status: "running", toolCallId: "packed" };
const runnable = RunnableLambda.from(async (_, config) => { await emitToolStep(config, step); return "ok"; });
const events = [];
for await (const event of runnable.streamEvents("input", { version: "v2" })) events.push(event);
if (events.find(event => event.event === "on_custom_event")?.data.toolCallId !== "packed") throw Error("no packed step");
`,
    )
    const types = join(consumerDir, "types.mts")
    await writeFile(
      types,
      `
import { emitToolStep, toolStepMiddleware, type ToolStepDisplay, type ToolStepMiddlewareOptions } from "@b4run/langgraph/ui";
import type { B4ToolStep } from "@b4run/sdk";
import type { RunnableConfig } from "@langchain/core/runnables";
const step: B4ToolStep & { toolCallId: string } = { v: 1, kind: "server", status: "running", toolCallId: "typed" };
const config: RunnableConfig = {};
const emitted: Promise<void> = emitToolStep(config, step);
// @ts-expect-error CUSTOM producers must supply identity
emitToolStep(config, { v: 1, kind: "server", status: "running" });
const display: ToolStepDisplay = {
  running: args => String(args.query),
  done: (_args, message) => String(message.content),
  failed: (_args, errorText) => errorText,
  sources: message => [{ id: message.tool_call_id, kind: "url", title: "Source", href: "https://example.com" }],
  icon: "app-icon",
};
const options: ToolStepMiddlewareOptions = { display: { lookup: display } };
const middleware = toolStepMiddleware(options);
void middleware;
void emitted;
`,
    )

    const runtime = await runCommand("node", [script], consumerDir)
    const typesResult = await runCommand(
      join(repoRoot, "node_modules/.bin/tsc"),
      [
        "--noEmit",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "--skipLibCheck",
        types,
      ],
      consumerDir,
    )

    expect(runtime).toEqual({ stdout: "", stderr: "" })
    expect(typesResult).toEqual({ stdout: "", stderr: "" })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("npm installs the packed helper alongside compatible newer optional peers", {
  timeout: 30_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "b4-ui-peer-resolution-"))
  const packageRoot = join(repoRoot, "packages/langgraph")
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  const peers = [
    ["@b4run/sdk", manifest.version],
    ["@langchain/core", "1.3.0"],
    ["langchain", "1.6.0"],
    ["@langchain/langgraph", "1.5.2"],
  ] as const
  const dependencies: Record<string, string> = {
    "@b4run/langgraph": `file:${join(tempRoot, `b4run-langgraph-${manifest.version}.tgz`)}`,
  }
  try {
    for (const [index, [name, version]] of peers.entries()) {
      const directory = join(tempRoot, `peer-${index}`)
      await mkdir(directory)
      await writeFile(join(directory, "package.json"), JSON.stringify({ name, version }))
      dependencies[name] = `file:${directory}`
    }
    await writeFile(
      join(tempRoot, "package.json"),
      JSON.stringify({
        name: "peer-resolution-consumer",
        private: true,
        dependencies,
      }),
    )
    await runCommand("pnpm", ["pack", "--pack-destination", tempRoot], packageRoot)

    const result = await runCommand(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--strict-peer-deps",
      ],
      tempRoot,
    )

    expect(result.stderr).not.toContain("ERESOLVE")
    for (const [name, version] of peers) {
      const installed = JSON.parse(
        await readFile(join(tempRoot, "node_modules", name, "package.json"), "utf8"),
      )
      expect(installed.version).toBe(version)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

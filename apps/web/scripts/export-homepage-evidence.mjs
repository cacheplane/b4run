import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    recording: { type: "string" },
    output: { type: "string" },
    replace: { type: "boolean" },
  },
})
if (!values.recording || !values.output) throw new Error("Provide --recording and --output")
const hash = (text) => createHash("sha256").update(text).digest("hex")
const bytes = await readFile(values.recording)
const recordingSha256 = "1a1dd2187554737ef3401e4c63fcd5d4e746c3506b9dc01eb9dfaa3db57c95db"
if (hash(bytes) !== recordingSha256) throw new Error("Unexpected recording bytes")
const run = JSON.parse(bytes.toString())
if (run.mode !== "live" || !run.passed || run.agent.dirty || run.status !== "approval-pending")
  throw new Error("Only the reviewed live approval-pending recording is publishable")
const sourceCommit = "91619fa68522079087f09e9ead792b30a09bd6de"
const prefix = "examples/code-fixer/server/"
const gitSource = (commit, path) =>
  execFileSync("git", ["show", `${commit}:${prefix}${path}`], { encoding: "utf8" })
const paths = {
  agent: "src/app/fix/index.ts",
  config: "b4.config.ts",
  plan: "src/app/fix/plan.md",
  workspace: "src/blueprint/seeded-provider.ts",
  verifier: "src/blueprint/verifier.ts",
  evals: "src/blueprint/evaluate.ts",
  tool: "src/app/fix/tools/exportForReview.ts",
  skill: "src/app/fix/skills/verify-change/SKILL.md",
}
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => {
    const text = run.source[path] ?? gitSource(run.agent.commit, path)
    if (text !== gitSource(sourceCommit, path)) throw new Error(`Source changed at merge: ${path}`)
    return [key, { path, text, sha256: hash(text) }]
  }),
)
const snippet = (source, first, last) => {
  const lines = sources[source].text.trimEnd().split("\n")
  const start = lines.findIndex((line) => line.includes(first)) + 1
  const end =
    last === null
      ? lines.length
      : lines.findIndex((line, index) => index >= start - 1 && line.includes(last)) + 1
  if (start < 1 || end < start) throw new Error(`Missing snippet: ${source}`)
  return { source, start, end, sha256: hash(lines.slice(start - 1, end).join("\n")) }
}
const original = gitSource(run.agent.commit, "fixtures/cli-flags/project/src/cli.ts")
const repaired = run.prepared.changes["src/cli.ts"]
const firstTest = run.run.toolCalls.find(
  (call) => call.name === "runBash" && call.args.command.startsWith("npm"),
)
const firstResult = run.run.toolResults.find((result) => result.name === "runBash")
const content =
  typeof firstResult.content === "string" ? JSON.parse(firstResult.content) : firstResult.content
const failure = content.stdout.match(/error: unknown option '--dry-run'/)?.[0]
if (!failure) throw new Error("Expected reproduced failure absent")
const checks = (name) => {
  const verification = run.prepared.verification[name]
  if (!verification.passed || verification.exitCode !== 0) throw new Error("Failed verifier")
  return verification.receipt.events.map((event) => {
    if (event.type !== "test:pass" || event.skip || event.todo) throw new Error("Incomplete check")
    return event.name
  })
}
const evidence = {
  schemaVersion: 1,
  id: run.id,
  batch: "batch-9377dec7-1792-40f7-a721-645d4caa9959",
  recordingSha256,
  mode: run.mode,
  dirty: run.agent.dirty,
  status: run.status,
  agentCommit: run.agent.commit,
  sourceCommit,
  model: run.agent.model,
  image: run.image,
  fixtureSha256: run.fixture.sha256,
  durationMs: run.durationMs,
  timings: run.timings,
  criteria: run.criteria,
  visible: checks("visible"),
  independent: checks("independent"),
  command: firstTest.args.command,
  failure,
  patch: { path: "src/cli.ts", original, repaired, sha256: hash(`${original}\0${repaired}`) },
  sources,
  snippets: {
    workspace: snippet("workspace", "if (!initialized.has", "return handle"),
    sandbox: snippet("verifier", "export const sandboxPolicy", "timeoutMs:"),
    evals: snippet("evals", "export async function evaluateRun", null),
    approval: snippet("agent", "tools: { approve:", "tools: { approve:"),
  },
}
// Include the closing brace of the contiguous policy excerpt.
evidence.snippets.sandbox.end += 1
const policy = evidence.snippets.sandbox
policy.sha256 = hash(
  sources.verifier.text
    .trimEnd()
    .split("\n")
    .slice(policy.start - 1, policy.end)
    .join("\n"),
)
const output = `${JSON.stringify(evidence, null, 2)}\n`
if (/\/Users\/|\/home\/|sk-proj-/.test(output)) throw new Error("Private data detected")
await mkdir(dirname(values.output), { recursive: true })
await writeFile(values.output, output, { flag: values.replace ? "w" : "wx" })
console.log(`Exported reviewed homepage evidence: ${values.output}`)

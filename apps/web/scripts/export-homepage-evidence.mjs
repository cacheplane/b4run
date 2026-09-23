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
const recordingSha256 = "cbfc5455b732051b53a93399c6e3f7c926271e543f8e17ace1d03303b2a99c13"
if (hash(bytes) !== recordingSha256) throw new Error("Unexpected recording bytes")
const run = JSON.parse(bytes.toString())
if (run.mode !== "live" || !run.passed || run.agent.dirty || run.status !== "approval-pending")
  throw new Error("Only the reviewed live approval-pending recording is publishable")
// The homepage narrative pins this revision; the recorded source must equal it.
const sourceCommit = "bfaf0c2b3030eebb572703c8f70f0e063593b1fa"
const prefix = "examples/code-fixer/server/"
const gitSource = (commit, path) =>
  execFileSync("git", ["show", `${commit}:${prefix}${path}`], { encoding: "utf8" })
const paths = {
  agent: "src/app/fix/index.ts",
  config: "b4.config.ts",
  plan: "src/app/fix/plan.md",
  workspace: "src/project/workspace.ts",
  scoring: "src/app/fix/evals/scoring.ts",
  tool: "src/app/fix/tools/exportForReview.ts",
  skill: "src/app/fix/skills/verify-change/SKILL.md",
}
const sources = Object.fromEntries(
  Object.entries(paths).map(([key, path]) => {
    const text = run.source[path] ?? gitSource(run.agent.commit, path)
    if (text !== gitSource(sourceCommit, path)) throw new Error(`Source differs from pin: ${path}`)
    return [key, { path, text, sha256: hash(text) }]
  }),
)
// Lines from the first line containing `first` through the first line at or
// after it matching `last` (or the end of the file when `last` is null).
const snippet = (source, first, last) => {
  const lines = sources[source].text.trimEnd().split("\n")
  const start = lines.findIndex((line) => line.includes(first)) + 1
  const end =
    last === null
      ? lines.length
      : lines.findIndex((line, index) => index >= start - 1 && last.test(line)) + 1
  if (start < 1 || end < start) throw new Error(`Missing snippet: ${source}`)
  return { source, start, end, sha256: hash(lines.slice(start - 1, end).join("\n")) }
}
const fixtureSource = "sample/project/src/cli.ts"
const original = gitSource(run.agent.commit, fixtureSource)
if (original !== gitSource(sourceCommit, fixtureSource)) throw new Error("Fixture differs from pin")
const repaired = run.prepared.changes["src/cli.ts"]
if (typeof repaired !== "string" || Object.keys(run.prepared.changes).length !== 1)
  throw new Error("Expected a single src/cli.ts change")
const firstTest = run.run.toolCalls.find(
  (call) => call.name === "runBash" && call.args.command.startsWith("npm"),
)
// Tool results carry no call id, so the reproduction must be the first shell command.
if (run.run.toolCalls.find((call) => call.name === "runBash") !== firstTest)
  throw new Error("Expected the first shell command to reproduce the failure")
const firstResult = run.run.toolResults.find((result) => result.name === "runBash")
const content =
  typeof firstResult?.content === "string" ? JSON.parse(firstResult.content) : firstResult?.content
const failure = `${content?.stdout ?? ""}\n${content?.stderr ?? ""}`.match(
  /error: unknown option '--dry-run'/,
)?.[0]
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
  batch: "batch-d1a45c11-c8f7-4652-b452-a61f52c6e8ae",
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
    workspace: snippet("workspace", "export function projectWorkspace", null),
    sandbox: snippet("workspace", "export const sandboxPolicy", /^}$/),
    evals: snippet("scoring", "export function repairCriteria", /^}$/),
    approval: snippet("agent", "tools: { approve:", /tools: \{ approve:/),
  },
}
const output = `${JSON.stringify(evidence, null, 2)}\n`
if (/\/Users\/|\/home\/|\bsk-/.test(output)) throw new Error("Private data detected")
await mkdir(dirname(values.output), { recursive: true })
await writeFile(values.output, output, { flag: values.replace ? "w" : "wx" })
console.log(`Exported reviewed homepage evidence: ${values.output}`)

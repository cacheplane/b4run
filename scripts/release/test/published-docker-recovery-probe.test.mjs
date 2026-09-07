import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { dockerSandboxInstalledProbeSource } from "../../published-artifact-smoke.mjs"

const execute = promisify(execFile)
// Execute the generated ESM script against a full-cgroup Docker model that still
// admits shell builtins. This checks probe control flow, not installed-package correctness.
async function runGeneratedProbe(scenario) {
  const root = await mkdtemp(join(tmpdir(), "dawn-generated-pid-probe-"))
  try {
    const bin = join(root, "bin")
    const sandbox = join(root, "node_modules/@dawn-ai/sandbox")
    await mkdir(bin, { recursive: true })
    await mkdir(sandbox, { recursive: true })
    const statePath = join(root, "state.json")
    await writeFile(
      statePath,
      JSON.stringify({
        scenario,
        keeper: "original-keeper",
        files: {},
        commands: 0,
        recoveryWrites: 0,
      }),
    )
    const stateIo = `
import { readFileSync, writeFileSync } from "node:fs"
const statePath = process.env.DAWN_PID_PROBE_FIXTURE
const load = () => JSON.parse(readFileSync(statePath, "utf8"))
const save = state => writeFileSync(statePath, JSON.stringify(state))
`
    await writeFile(
      join(sandbox, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.mjs" }),
    )
    await writeFile(
      join(sandbox, "index.mjs"),
      `${stateIo}
import assert from "node:assert/strict"
export function dockerSandbox() {
  return {
    async acquire() {
      return {
        workspaceRoot: "/workspace",
        filesystem: {
          async writeFile(path, content) {
            const state = load()
            if (state.saturated) {
              assert.equal(state.statsObserved, true, "recovery write must follow saturation proof")
              assert.equal(state.commands, 0, "recovery write must precede subsequent commands")
              assert.notEqual(path, state.sentinelPath, "recovery write cannot overwrite the original sentinel")
              state.recoveryWrites++
              state.recoveryPath = path
              if (state.scenario !== "unchanged-keeper") state.keeper = "replacement-keeper"
            } else state.sentinelPath = path
            state.files[path] = content
            save(state)
            return { bytesWritten: Buffer.byteLength(content) }
          },
          async readFile(path) {
            const state = load()
            if (state.scenario === "wrong-recovery-content" && path === state.recoveryPath) return "corrupted recovery write"
            if (state.scenario === "lost-original-sentinel" && path === state.sentinelPath) return "lost original sentinel"
            return state.files[path]
          },
        },
        exec: { async runCommand({ command }) {
          const state = load()
          assert.equal(state.statsObserved, true)
          state.commands++
          save(state)
          assert.match(command, /^echo recovered-[0-9]+$/)
          return { exitCode: 0, stdout: command.slice(5) + "\\n", stderr: "" }
        } },
      }
    },
    async destroy() { const state = load(); state.destroyed = true; save(state) },
  }
}
`,
    )
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}
${stateIo}
const args = process.argv.slice(2), state = load()
if (args[0] === "exec" && args[1] === "-d") state.saturated = true
else if (args[0] === "cp") {
  if (!state.saturated) process.exit(1)
  writeFileSync(args[2], JSON.stringify({ status: "ready", code: "ERR_WORKER_INIT_FAILED", message: "EAGAIN", started: 24 }))
} else if (args[0] === "stats") {
  state.statsObserved = true
  console.log("32")
} else if (args[0] === "inspect") {
  if (args[2] === "{{.Id}}") console.log(state.keeper)
  else console.log('"node:22-slim" "sha256:' + "a".repeat(64) + '"')
} else throw new Error("unexpected Docker operation")
save(state)
`,
      { mode: 0o755 },
    )
    await writeFile(
      join(root, "probe.mjs"),
      dockerSandboxInstalledProbeSource(`published-uuid-${"a".repeat(32)}`, {
        imageEvidencePath: "docker-image.json",
      }),
    )
    let result
    try {
      result = {
        ...(await execute(process.execPath, ["probe.mjs"], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            DAWN_PID_PROBE_FIXTURE: statePath,
          },
          timeout: 15000,
        })),
        exitCode: 0,
      }
    } catch (error) {
      result = { exitCode: error.code, stdout: error.stdout, stderr: error.stderr }
    }
    const state = JSON.parse(await readFile(statePath, "utf8"))
    return { ...result, state }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("generated probe forces filesystem PID recovery before subsequent concurrent builtin commands", async () => {
  const result = await runGeneratedProbe("recover")
  assert.equal(result.exitCode, 0, result.stderr)
  assert.match(result.stdout, /T-DOCKER-SANDBOX PASS/)
  assert.equal(result.state.recoveryWrites, 1)
  assert.equal(result.state.commands, 24)
  assert.equal(result.state.keeper, "replacement-keeper")
  assert.equal(result.state.destroyed, true)
})

for (const [scenario, failure] of [
  ["unchanged-keeper", /PID-exhausted keeper was not replaced/],
  ["wrong-recovery-content", /PID recovery write was not preserved/],
  ["lost-original-sentinel", /Original PID sentinel was not preserved/],
])
  test(`generated probe rejects ${scenario}`, async () => {
    const result = await runGeneratedProbe(scenario)
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, failure)
    assert.equal(result.state.destroyed, true)
  })

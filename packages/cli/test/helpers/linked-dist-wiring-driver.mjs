// Real public Vitest configuration/restart coverage. The CLI config is copied
// unchanged; only its setup's single exact builder import is rebound.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"

import { createVitest } from "vitest/node"

const [mode, ownedRoot, setupPath, cliConfigPath, workspacePath] = process.argv.slice(2)
assert.ok(["direct", "workspace", "restart", "cold-failure", "ordinary-failure"].includes(mode))
const failureMode = mode === "cold-failure" || mode === "ordinary-failure"
assert.ok(ownedRoot && setupPath && cliConfigPath && workspacePath)
const root = join(ownedRoot, "wiring-fixture")
assert.ok(!existsSync(root))
const cliRoot = join(root, "cli")
mkdirSync(join(cliRoot, "test"), { recursive: true, mode: 0o700 })
const repoRoot = resolve(dirname(setupPath), "../../..")
symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir")
writeFileSync(join(root, "package.json"), '{"type":"module"}\n')
const eventsPath = join(root, "events.jsonl")
const inputPath = join(root, "input.json")
const releasePath = join(root, "release-reader")
const outputPath = join(root, "report.json")
const packageDir = join(cliRoot, "packages", "mock")
mkdirSync(join(packageDir, "dist"), { recursive: true })
writeFileSync(join(packageDir, "dist", "value.js"), "export const value = 0\n")
const deadline = performance.now() + 24_000
let context
let firstError
let closed = false
let ownedRun
let ownedRestart
let failureTransition
const ownedExpected = []
const runs = []

function event(kind, fields = {}) {
  appendFileSync(eventsPath, JSON.stringify({ kind, ...fields }) + "\n")
}
function events() {
  if (!existsSync(eventsPath)) return []
  return readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row))
}
async function until(predicate, label) {
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "deadline awaiting " + label)
    await setTimeout(10)
  }
}
function input(value, hold = false, fail = false) {
  writeFileSync(inputPath, JSON.stringify({ value, hold, fail }))
}
function capability() {
  const configured = context.config.reporters.filter(
    (reporter) => reporter?.preparationKind === "b4.cli.linked-dist-preparation.v1",
  )
  assert.equal(configured.length, 1)
  assert.deepEqual(
    context.config.reporters.filter(Array.isArray).map(([name]) => name),
    ["default", "json"],
  )
  return configured[0]
}
function assertPassed(result) {
  assert.equal(result.unhandledErrors.length, 0)
  assert.equal(result.testModules.length, 1)
  assert.equal(result.testModules[0].state(), "passed")
}
function observe(promise, label) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => {
      event("owned-operation-rejected", { label, message: error.message })
      firstError ??= { name: error.name, message: error.message, stack: error.stack }
      return { status: "rejected", error }
    },
  )
}
async function expectedRejection(promise, label) {
  const owned = promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => {
      event("expected-operation-rejected", { label, name: error?.name, message: error?.message })
      return { status: "rejected", error }
    },
  )
  ownedExpected.push(owned)
  const outcome = await owned
  assert.equal(outcome.status, "rejected", label + " must reject before workers")
  return outcome.error
}
function unwrap(outcome) {
  if (outcome.status === "rejected") throw outcome.error
  return outcome.value
}
try {
  const binding = 'import { buildLinkedDists } from "./helpers/linked-dists.ts"'
  const source = readFileSync(setupPath, "utf8")
  assert.equal(source.split(binding).length, 2)
  const copied = source.replace(binding, 'import { buildLinkedDists } from "./builder.mjs"')
  writeFileSync(join(cliRoot, "test", "global-setup.ts"), copied)
  const configSource = readFileSync(cliConfigPath, "utf8")
  assert.equal(
    configSource.split('import { installPreparationReporter } from "./test/global-setup.ts"')
      .length,
    2,
  )
  const copiedConfigPath = join(cliRoot, "vitest.config.ts")
  writeFileSync(copiedConfigPath, configSource)
  const workspaceSource = readFileSync(workspacePath, "utf8")
  assert.equal(
    workspaceSource.split('"./packages/cli/vitest.config.ts"').length,
    2,
    "real workspace selects the owning CLI config once",
  )
  event("exact-source-copies", {
    setupSHA256: createHash("sha256").update(source).digest("hex"),
    copiedSetupSHA256: createHash("sha256").update(copied).digest("hex"),
    configSHA256: createHash("sha256").update(configSource).digest("hex"),
    workspaceSHA256: createHash("sha256").update(workspaceSource).digest("hex"),
    changedBuilderBindingOnly: true,
    unchangedCLIConfig: true,
  })
  writeFileSync(
    join(cliRoot, "test", "builder.mjs"),
    [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs"',
      'import { join } from "node:path"',
      "const inputPath = " + JSON.stringify(inputPath),
      "const packageDir = " + JSON.stringify(packageDir),
      "const eventsPath = " + JSON.stringify(eventsPath),
      "let builds = 0",
      "export async function buildLinkedDists() {",
      "  const build = ++builds",
      '  const { value, fail } = JSON.parse(readFileSync(inputPath, "utf8"))',
      '  appendFileSync(eventsPath, JSON.stringify({kind: "writer-start", build, value}) + "\\n")',
      "  try {",
      "    if (fail) {",
      '      writeFileSync(join(packageDir, "dist/value.js"), "export const value = ")',
      '      throw new Error("fixture compiler diagnostic TS9004")',
      "    }",
      '    writeFileSync(join(packageDir, "dist/value.js"), "export const value = " + value + "\\n")',
      '    return [{dir: packageDir, name: "@fixture/mock"}]',
      "  } finally {",
      '    appendFileSync(eventsPath, JSON.stringify({kind: "writer-end", build, value}) + "\\n")',
      "  }",
      "}",
    ].join("\n"),
  )
  writeFileSync(
    join(cliRoot, "test", "reads.test.ts"),
    [
      'import { appendFileSync, existsSync, readFileSync } from "node:fs"',
      'import { setTimeout } from "node:timers/promises"',
      'import { expect, test } from "vitest"',
      'import { value } from "../packages/mock/dist/value.js"',
      "const eventsPath = " + JSON.stringify(eventsPath),
      "const inputPath = " + JSON.stringify(inputPath),
      "const releasePath = " + JSON.stringify(releasePath),
      'test("configuration reader sees prepared output", async () => {',
      '  const control = JSON.parse(readFileSync(inputPath, "utf8"))',
      '  appendFileSync(eventsPath, JSON.stringify({kind: "reader", value}) + "\\n")',
      "  if (control.hold) {",
      '    appendFileSync(eventsPath, JSON.stringify({kind: "reader-held", value}) + "\\n")',
      "    const end = performance.now() + 8000",
      "    while (!existsSync(releasePath)) {",
      '      if (performance.now() > end) throw new Error("fixture reader gate deadline")',
      "      await setTimeout(10)",
      "    }",
      "  }",
      "  expect(value).toBe(control.value)",
      "})",
    ].join("\n"),
  )
  input(1, false, mode === "cold-failure")
  const useWorkspace = mode !== "direct"
  context = await createVitest(
    "test",
    {
      root: useWorkspace ? root : cliRoot,
      config: useWorkspace ? false : copiedConfigPath,
      watch: mode === "restart",
      pool: "forks",
      maxWorkers: 2,
      reporters: [
        "default",
        "json",
        ...(failureMode
          ? [
              {
                onTestModuleQueued(module) {
                  event("module-queued", { moduleId: module.moduleId })
                },
                onTestModuleStart(module) {
                  event("module-started", { moduleId: module.moduleId })
                },
                onTestRunEnd(modules, errors, reason) {
                  runs.push({
                    reason,
                    moduleCount: modules.length,
                    states: modules.map((module) => module.state()),
                    errors: errors.length,
                  })
                },
              },
            ]
          : []),
      ],
      outputFile: outputPath,
    },
    useWorkspace ? { test: { projects: [{ extends: copiedConfigPath, root: cliRoot }] } } : {},
  )
  const initialCapability = capability()
  assert.deepEqual(initialCapability.inspect(), {
    readers: 0,
    signatures: 0,
    writer: false,
    requestedRevision: 0,
    retiring: false,
    terminal: false,
  })
  if (failureMode) {
    const exitBefore = process.exitCode
    assert.ok(
      exitBefore === undefined || exitBefore === 0,
      "failure control requires a clean captured exit prestate",
    )
    failureTransition = { before: exitBefore ?? null }
    let failure
    if (mode === "cold-failure") {
      failure = await expectedRejection(context.start(), "cold compiler failure")
      assert.deepEqual(runs, [{ reason: "failed", moduleCount: 0, states: [], errors: 0 }])
      assert.equal(process.exitCode, 1, "only the intentional empty failed run may set exit1")
    } else {
      assertPassed(await context.start())
      input(2, false, true)
      failure = await expectedRejection(
        context.rerunTestSpecifications(await context.globTestSpecifications()),
        "ordinary compiler failure",
      )
      assert.deepEqual(runs, [{ reason: "passed", moduleCount: 1, states: ["passed"], errors: 0 }])
      assert.equal(
        process.exitCode,
        exitBefore,
        "a failed rerun hook must not mask or invent a test exit",
      )
    }
    assert.ok(failure instanceof Error)
    assert.equal(failure.message, "fixture compiler diagnostic TS9004")
    failureTransition.afterExpectedFailure = process.exitCode ?? null
    const failedExit = process.exitCode
    const failedBuilds = mode === "cold-failure" ? 1 : 2
    const readerCount = mode === "cold-failure" ? 0 : 1
    assert.equal(events().filter((row) => row.kind === "writer-start").length, failedBuilds)
    assert.equal(events().filter((row) => row.kind === "reader").length, readerCount)
    assert.equal(events().filter((row) => row.kind === "module-queued").length, readerCount)
    assert.equal(events().filter((row) => row.kind === "module-started").length, readerCount)
    assert.equal(initialCapability.inspect().readers, 0)
    assert.equal(initialCapability.inspect().terminal, false)
    const specs = await context.globTestSpecifications()
    assert.equal(
      await expectedRejection(
        context.runTestSpecifications(specs),
        "direct specifications after failed preparation",
      ),
      failure,
    )
    failureTransition.afterDirectSpecifications = process.exitCode ?? null
    assert.equal(process.exitCode, failedExit)
    assert.equal(
      await expectedRejection(context.start(), "direct start after failed preparation"),
      failure,
    )
    failureTransition.afterDirectStart = process.exitCode ?? null
    assert.equal(process.exitCode, failedExit)
    assert.equal(initialCapability.inspect().readers, 0)
    assert.equal(initialCapability.inspect().writer, false)
    assert.equal(initialCapability.inspect().terminal, false)
    assert.equal(
      events().filter((row) => row.kind === "writer-start").length,
      failedBuilds,
      "direct denial must not retry compilation",
    )
    assert.equal(
      events().filter((row) => row.kind === "reader").length,
      readerCount,
      "direct denial must precede worker reads",
    )
    assert.equal(
      events().filter((row) => row.kind === "module-queued").length,
      readerCount,
      "direct denial must precede module queueing",
    )
    assert.equal(
      events().filter((row) => row.kind === "module-started").length,
      readerCount,
      "direct denial must precede worker module execution",
    )
    assert.equal(runs.length, 1, "denied starts never manufacture an end or consume a lease")
    event("direct-admissions-denied", { failedBuilds, readerCount, originalErrorRetained: true })
    if (mode === "cold-failure") {
      assert.equal(
        process.exitCode,
        1,
        "retain the exact intentional failed code until all denial checks finish",
      )
      // Restore only this validated cold-failure prestate, before real recovery.
      process.exitCode = exitBefore
    }
    failureTransition.restoredBeforeRecovery = process.exitCode ?? null
    input(2)
    assertPassed(await context.rerunTestSpecifications(specs))
    assert.equal(initialCapability.inspect().requestedRevision, failedBuilds + 1)
    failureTransition.afterRecovery = process.exitCode ?? null
    assert.equal(process.exitCode, exitBefore)
    assert.equal(initialCapability.inspect().readers, 0)
    assert.equal(initialCapability.inspect().terminal, false)
    assert.deepEqual(runs.at(-1), {
      reason: "passed",
      moduleCount: 1,
      states: ["passed"],
      errors: 0,
    })
    event("genuine-preparation-recovered", { builds: failedBuilds + 1, value: 2 })
  } else {
    assertPassed(await context.start())
    assert.equal(initialCapability.inspect().requestedRevision, 1)
  }
  if (mode === "restart") {
    input(1, true)
    ownedRun = observe(
      context.runTestSpecifications(await context.globTestSpecifications()),
      "held reader",
    )
    await until(() => events().some((row) => row.kind === "reader-held"), "actual held worker")
    event("restart-requested")
    // Pinned Vitest replaces this PUBLIC server method with its awaited
    // onServerRestart-listener wrapper before project configuration resolves.
    ownedRestart = observe(context.vite.restart(), "public server restart")
    assert.equal(initialCapability.inspect().retiring, true)
    assert.equal(initialCapability.inspect().readers, 1)
    event("restart-draining-old-reader")
    writeFileSync(releasePath, "", { flag: "wx" })
    assertPassed(unwrap(await ownedRun))
    input(2)
    unwrap(await ownedRestart)
    const freshCapability = capability()
    assert.notEqual(freshCapability, initialCapability)
    assert.deepEqual(freshCapability.inspect(), {
      readers: 0,
      signatures: 0,
      writer: false,
      requestedRevision: 0,
      retiring: false,
      terminal: false,
    })
    event("fresh-coordinator-configured")
    assertPassed(await context.start())
    assert.equal(freshCapability.inspect().requestedRevision, 1)
  } else if (!failureMode) {
    input(2)
    assertPassed(await context.rerunTestSpecifications(await context.globTestSpecifications()))
    assert.equal(capability(), initialCapability)
    assert.equal(initialCapability.inspect().requestedRevision, 2)
  }
  const reads = events()
    .filter((row) => row.kind === "reader")
    .map((row) => row.value)
  assert.deepEqual(reads, mode === "cold-failure" ? [2] : mode === "restart" ? [1, 1, 2] : [1, 2])
} catch (error) {
  firstError ??= { name: error.name, message: error.message, stack: error.stack }
} finally {
  if (!existsSync(releasePath)) writeFileSync(releasePath, "", { flag: "wx" })
  if (ownedRun) await ownedRun
  if (ownedRestart) await ownedRestart
  await Promise.all(ownedExpected)
  event("owned-operations-joined", { expectedOperations: ownedExpected.length })
  if (context) {
    try {
      await context.close()
      closed = true
    } catch (error) {
      firstError ??= { name: error.name, message: error.message, stack: error.stack }
    }
  }
  event("context-closed", { closed })
}
let active = 0
let maximumWriters = 0
for (const row of events()) {
  if (row.kind === "writer-start") maximumWriters = Math.max(maximumWriters, ++active)
  if (row.kind === "writer-end") active -= 1
  if (row.kind === "reader" && active !== 0)
    firstError ??= { message: "configuration reader overlapped writer" }
}
if (!firstError) {
  try {
    assert.equal(active, 0)
    assert.equal(maximumWriters, 1)
    assert.equal(
      events().filter((row) => row.kind === "writer-start").length,
      mode === "ordinary-failure" ? 3 : 2,
    )
    assert.equal(closed, true)
    const json = JSON.parse(readFileSync(outputPath, "utf8"))
    assert.equal(json.success, true)
    assert.ok(json.testResults.length > 0)
    if (failureTransition) {
      failureTransition.afterClose = process.exitCode ?? null
      assert.equal(
        failureTransition.afterClose,
        failureTransition.before,
        "close must not change or mask the validated failure/recovery exit transition",
      )
    }
  } catch (error) {
    firstError = { name: error.name, message: error.message, stack: error.stack }
  }
}
const result = {
  ok: !firstError,
  mode,
  closed,
  maximumWriters,
  events: events(),
  firstError,
  ...(failureTransition ? { failureTransition } : {}),
}
writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2) + "\n")
process.stdout.write("WIRING_RESULT=" + JSON.stringify(result) + "\n")
if (firstError) process.exitCode = 1

// One owned child for the two-project lifecycle regression. No workspace builder
// is imported: only the setup's exact builder import is rebound to this fixture.
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
import { pathToFileURL } from "node:url"

import { createVitest } from "vitest/node"

const [mode, ownedRoot, setupPath] = process.argv.slice(2)
assert.ok(
  ["initial-watch", "failed-build", "programmatic-coalescing", "later-reader-admission"].includes(
    mode,
  ),
)
assert.ok(ownedRoot && setupPath)
const root = join(ownedRoot, "real-fixture")
assert.ok(!existsSync(root), "each driver requires a fresh fixture")
mkdirSync(root, { mode: 0o700 })
const eventsPath = join(root, "events.jsonl")
const controlPath = join(root, "control.json")
const valuePath = join(root, "input.json")
const expectedPath = join(root, "expected.json")
const packageDir = join(root, "packages", "mock")
const distPath = join(packageDir, "dist", "value.js")
const eventEpoch = performance.now()
const deadline = eventEpoch + 24_000
let observerPhase = "setup"
let context
let closed = false
let firstError
let failedBuildTransition
const ownedReruns = []
let rerunRejection
let programmaticReruns
let allowAdmissionA
const admission = { pausedA: false, dispatchedB: false, outcomes: new Map() }
const admissionGateA = new Promise((resolve) => {
  allowAdmissionA = resolve
})

function event(kind, fields = {}) {
  appendFileSync(
    eventsPath,
    JSON.stringify({
      ...fields,
      kind,
      observedByDriver: true,
      atMs: performance.now() - eventEpoch,
      phase: observerPhase,
    }) + "\n",
    { mode: 0o600 },
  )
}
function events() {
  if (!existsSync(eventsPath)) return []
  const raw = readFileSync(eventsPath, "utf8")
  assert.ok(raw.endsWith("\n"), "event producer must write complete records")
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}
async function until(predicate, label) {
  while (!predicate()) {
    if (rerunRejection) throw rerunRejection.error
    assert.ok(performance.now() < deadline, "deadline awaiting " + label)
    await setTimeout(10)
  }
}
function input(value) {
  writeFileSync(valuePath, JSON.stringify({ value }))
  writeFileSync(expectedPath, JSON.stringify({ value }))
}
function release(build) {
  writeFileSync(join(root, "release-" + build), "", { flag: "wx", mode: 0o600 })
}
function count(kind) {
  return events().filter((row) => row.kind === kind).length
}
function noReadsSince(index) {
  assert.ok(
    !events()
      .slice(index)
      .some((row) => row.kind === "reader"),
    "reader entered during build",
  )
}
function assertPassed(result) {
  assert.equal(result.unhandledErrors.length, 0)
  assert.equal(result.testModules.length, 4)
  assert.ok(result.testModules.every((module) => module.state() === "passed"))
}

try {
  mkdirSync(join(packageDir, "dist"), { recursive: true })
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n')
  writeFileSync(distPath, "export const value = 0\n")
  input(1)
  const holds =
    mode === "programmatic-coalescing" ? [2, 3, 4] : mode === "later-reader-admission" ? [3] : [1]
  const failures = mode === "failed-build" ? [1] : []
  writeFileSync(controlPath, JSON.stringify({ holds, failures }))
  const binding = 'import { buildLinkedDists } from "./helpers/linked-dists.ts"'
  const setupSource = readFileSync(setupPath, "utf8")
  assert.equal(setupSource.split(binding).length, 2, "exactly one controlled builder binding")
  const copied = setupSource.replace(binding, 'import { buildLinkedDists } from "./builder.mjs"')
  writeFileSync(join(root, "setup-under-test.ts"), copied)
  event("setup-copy", {
    sourceSHA256: createHash("sha256").update(setupSource).digest("hex"),
    copiedSHA256: createHash("sha256").update(copied).digest("hex"),
    changedBindingOnly: true,
  })
  // All gate files and values live inside the fresh fixture. No subprocess or
  // compiler is available in this builder, even if a test seam is misconfigured.
  writeFileSync(
    join(root, "builder.mjs"),
    [
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"',
      'import { join } from "node:path"',
      'import { setTimeout } from "node:timers/promises"',
      "const root = " + JSON.stringify(root),
      "const packageDir = " + JSON.stringify(packageDir),
      "let build = 0",
      "function event(kind, fields) {",
      '  appendFileSync(join(root, "events.jsonl"), JSON.stringify({kind, ...fields}) + "\\n")',
      "}",
      "export async function buildLinkedDists() {",
      "  const number = ++build",
      '  const value = JSON.parse(readFileSync(join(root, "input.json"), "utf8")).value',
      '  const control = JSON.parse(readFileSync(join(root, "control.json"), "utf8"))',
      '  event("writer-start", {build: number, value})',
      "  try {",
      "    const end = performance.now() + 8000",
      '    while (control.holds.includes(number) && !existsSync(join(root, "release-" + number))) {',
      '      if (performance.now() > end) throw new Error("fixture build gate deadline")',
      "      await setTimeout(10)",
      "    }",
      '    if (control.failures.includes(number)) throw new Error("fixture compiler diagnostic TS9003")',
      '    writeFileSync(join(packageDir, "dist", "value.js"), "export const value = " + value + "\\n")',
      '    event("emitted", {build: number, value})',
      '    return [{dir: packageDir, name: "@fixture/mock"}]',
      "  } finally {",
      '    event("writer-end", {build: number})',
      "  }",
      "}",
      "",
    ].join("\n"),
  )
  writeFileSync(
    join(root, "setup-wrapper.mjs"),
    [
      'import { appendFileSync } from "node:fs"',
      'import { setup as actualSetup } from "./setup-under-test.ts"',
      "const eventsPath = " + JSON.stringify(eventsPath),
      "export async function setup(project) {",
      "  await actualSetup({vitest: project.vitest, onTestsRerun(callback) {",
      "    project.onTestsRerun(async (...args) => {",
      '      appendFileSync(eventsPath, JSON.stringify({kind: "hook-entered"}) + "\\n")',
      "      return callback(...args)",
      "    })",
      "  }})",
      "}",
      "",
    ].join("\n"),
  )
  const repoRoot = resolve(dirname(setupPath), "../../..")
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir")
  const files = []
  const expectedFiles = new Map()
  for (const name of ["owner", "reader"]) {
    const directory = join(root, name)
    mkdirSync(directory)
    for (const index of [0, 1]) {
      const file = join(directory, "reads-" + index + ".test.js")
      files.push(file)
      const expectedForFile =
        mode === "later-reader-admission"
          ? join(root, name, "expected-" + index + ".json")
          : expectedPath
      expectedFiles.set(file, expectedForFile)
      if (mode === "later-reader-admission") writeFileSync(expectedForFile, '{"value":1}')
      writeFileSync(
        file,
        [
          'import { appendFileSync, readFileSync } from "node:fs"',
          'import { expect, test } from "vitest"',
          'import { value } from "../packages/mock/dist/value.js"',
          'test("reads the current emitted module", () => {',
          "  const eventsPath = " + JSON.stringify(eventsPath),
          '  appendFileSync(eventsPath, JSON.stringify({kind: "reader", project: ' +
            JSON.stringify(name) +
            ", file: " +
            JSON.stringify(file) +
            ', value}) + "\\n")',
          "  const expected = JSON.parse(readFileSync(" +
            JSON.stringify(expectedForFile) +
            ', "utf8")).value',
          "  expect(value).toBe(expected)",
          "})",
          "",
        ].join("\n"),
      )
    }
  }
  // Inline project plugins are explicit: root plugins are not inherited here.
  const installationPlugin = {
    name: "controlled-preparation-installation",
    async configureVitest({ project }) {
      const actual = await import(pathToFileURL(join(root, "setup-under-test.ts")).href)
      const present = typeof actual.installPreparationReporter === "function"
      event("preparation-reporter-installation", { present, project: project.name })
      // TEST-only comparison seam; production always installs and requires it.
      if (present) actual.installPreparationReporter(project)
    },
  }
  const projects = ["owner", "reader"].map((name, index) => ({
    ...(index === 0 ? { plugins: [installationPlugin] } : {}),
    test: {
      name,
      root: join(root, name),
      include: ["reads-*.test.js"],
      ...(index === 0 ? { globalSetup: [join(root, "setup-wrapper.mjs")] } : {}),
    },
  }))
  // Keep the fixture config in memory: a delayed file event must not restart it.
  const fixtureConfig = {
    server: { watch: { ignored: ["**/packages/*/dist/**"] }, fs: { allow: [root, repoRoot] } },
    test: { projects },
  }
  const runs = []
  context = await createVitest(
    "test",
    {
      root,
      config: false,
      watch: mode !== "programmatic-coalescing" && mode !== "later-reader-admission",
      pool: "forks",
      maxWorkers: 2,
      reporters: [
        {
          async onTestRunStart(specs) {
            if (
              mode === "later-reader-admission" &&
              specs.length === 1 &&
              specs[0].moduleId === files[0]
            ) {
              event("admission-a-start-paused", {
                runningPromisePresent: Boolean(context.runningPromise),
              })
              admission.pausedA = true
              await admissionGateA
              event("admission-a-start-released")
            }
          },
          onWatcherRerun(changedFiles) {
            if (
              mode === "later-reader-admission" &&
              changedFiles.length === 1 &&
              changedFiles[0] === files[2]
            ) {
              event("admission-b-public-rerun-dispatched")
              admission.dispatchedB = true
            }
          },
          onServerRestart(reason) {
            event("server-restart-observed", { reason: reason ?? null })
          },
          onTestRunEnd(modules, errors, reason) {
            runs.push({
              reason,
              moduleCount: modules.length,
              states: modules.map((module) => module.state()),
              errors: errors.length,
            })
            if (mode === "later-reader-admission" && modules.length === 1) {
              if (modules[0].moduleId === files[0]) event("admission-a-run-end", { reason })
              if (modules[0].moduleId === files[2]) event("admission-b-run-end", { reason })
            }
          },
        },
      ],
    },
    fixtureConfig,
  )
  const installations = events().filter((row) => row.kind === "preparation-reporter-installation")
  assert.equal(installations.length, 1, "owner configureVitest installation must actually execute")
  assert.equal(installations[0].project, "owner")
  if (installations[0].present) {
    assert.equal(
      context.config.reporters.filter(
        (reporter) => reporter?.preparationKind === "b4.cli.linked-dist-preparation.v1",
      ).length,
      1,
      "future installer must append exactly one real capability",
    )
  }
  if (mode === "failed-build") {
    const exitCodeBefore = process.exitCode
    failedBuildTransition = { before: exitCodeBefore ?? null }
    assert.ok(exitCodeBefore === undefined || exitCodeBefore === 0, "driver must start clean")
    const initial = context.start()
    const rejected = initial.then(
      () => undefined,
      (error) => error,
    )
    await until(() => count("writer-start") === 1, "failed initial build")
    assert.equal(count("reader"), 0)
    release(1)
    const expectedRejection = await rejected
    failedBuildTransition.afterExpectedFailure = process.exitCode ?? null
    failedBuildTransition.initialRun = runs[0] ?? null
    assert.ok(expectedRejection instanceof Error)
    assert.equal(expectedRejection.message, "fixture compiler diagnostic TS9003")
    assert.equal(count("reader"), 0)
    assert.deepEqual(runs, [{ reason: "failed", moduleCount: 0, states: [], errors: 0 }])
    assert.equal(process.exitCode, 1, "only the intentional empty failed run sets exit1")
    event("expected-compiler-rejection", { exitTransition: failedBuildTransition })
    const specs = await context.globTestSpecifications()
    assert.equal(
      process.exitCode,
      1,
      "the intentional failure code must remain exact before recovery",
    )
    // Restore only the validated intentional failure, before any recovery work.
    process.exitCode = exitCodeBefore
    failedBuildTransition.restoredBeforeRecovery = process.exitCode ?? null
    assertPassed(await context.rerunTestSpecifications(specs))
    failedBuildTransition.afterRecovery = process.exitCode ?? null
    failedBuildTransition.recoveryRun = runs[1] ?? null
    assert.deepEqual(runs, [
      { reason: "failed", moduleCount: 0, states: [], errors: 0 },
      {
        reason: "passed",
        moduleCount: 4,
        states: ["passed", "passed", "passed", "passed"],
        errors: 0,
      },
    ])
  } else {
    observerPhase = "initial-run"
    const initial = context.start()
    await until(() => count("writer-start") === 1, "initial build")
    if (mode === "initial-watch") {
      assert.equal(count("reader"), 0)
      release(1)
    }
    assertPassed(await initial)
    assert.equal(count("reader"), 4)
    if (mode === "initial-watch") {
      input(2)
      assertPassed(await context.rerunTestSpecifications(await context.globTestSpecifications()))
      assert.equal(count("reader"), 8)
      assert.ok(
        events()
          .filter((row) => row.kind === "reader")
          .slice(-4)
          .every((row) => row.value === 2),
      )
    } else if (mode === "later-reader-admission") {
      observerPhase = "later-reader-admission"
      const specs = await context.globTestSpecifications()
      const specA = specs.find((spec) => spec.moduleId === files[0])
      const specB = specs.find((spec) => spec.moduleId === files[2])
      assert.ok(specA && specB && specA.project !== specB.project)
      function requestAdmissionRerun(spec, label) {
        if (rerunRejection) throw rerunRejection.error
        const request = ownedReruns.length + 1
        event("admission-rerun-requested", { request, label, file: spec.moduleId })
        ownedReruns.push(
          context.rerunTestSpecifications([spec]).then(
            (result) => {
              const outcome = { request, status: "fulfilled", result }
              admission.outcomes.set(label, outcome)
              return outcome
            },
            (error) => {
              rerunRejection ??= { error }
              event("programmatic-rerun-rejected", {
                request,
                error: { name: error.name, message: error.message, stack: error.stack },
              })
              const outcome = { request, status: "rejected", error }
              admission.outcomes.set(label, outcome)
              return outcome
            },
          ),
        )
      }
      input(2)
      writeFileSync(expectedFiles.get(files[0]), '{"value":2}')
      requestAdmissionRerun(specA, "A")
      await until(() => admission.pausedA, "A public reporter start gate")
      const hookBase = count("hook-entered")
      input(3)
      writeFileSync(expectedFiles.get(files[2]), '{"value":3}')
      requestAdmissionRerun(specB, "B")
      await until(
        () => admission.dispatchedB && count("hook-entered") >= hookBase + 1,
        "B public hook invocation",
      )
      // Do not wait for B's writer: a safe lease must let admitted A finish first.
      allowAdmissionA()
      await until(() => admission.outcomes.has("A"), "owned A completion")
      const outcomeA = admission.outcomes.get("A")
      if (outcomeA.status === "rejected") throw outcomeA.error
      assertPassed(outcomeA.result)
      await until(() => count("writer-start") === 3, "B preparation after A admission")
      const trace = events()
      const aEnd = trace.findIndex((row) => row.kind === "admission-a-run-end")
      const bStart = trace.findIndex((row) => row.kind === "writer-start" && row.build === 3)
      assert.ok(aEnd >= 0 && bStart > aEnd, "later writer began before admitted reader A completed")
      release(3)
      await until(() => admission.outcomes.has("B"), "owned B completion")
      const outcomeB = admission.outcomes.get("B")
      if (outcomeB.status === "rejected") throw outcomeB.error
      assertPassed(outcomeB.result)
      const readers = events().filter((row) => row.kind === "reader")
      assert.equal(readers.length, 6)
      assert.equal(readers[4].file, files[0])
      assert.equal(readers[4].value, 2)
      assert.equal(readers[5].file, files[2])
      assert.equal(readers[5].value, 3)
    } else {
      // Public admitted reruns are deterministic; native filesystem watch remains unqualified.
      observerPhase = "programmatic-coalescing"
      const specs = await context.globTestSpecifications()
      assert.equal(specs.length, 4)
      assert.deepEqual(new Set(specs.map((spec) => spec.moduleId)), new Set(files))
      assert.deepEqual(
        new Set(specs.map((spec) => spec.project.name)),
        new Set(["owner", "reader"]),
      )
      function requestRerun() {
        if (rerunRejection) throw rerunRejection.error
        const request = ownedReruns.length + 1
        event("programmatic-rerun-requested", { request })
        // Observe each owned rejection immediately; never mask unrelated native failures.
        ownedReruns.push(
          context.rerunTestSpecifications(specs).then(
            (result) => ({ request, status: "fulfilled", result }),
            (error) => {
              rerunRejection ??= { error }
              event("programmatic-rerun-rejected", {
                request,
                error: { name: error.name, message: error.message, stack: error.stack },
              })
              return { request, status: "rejected", error }
            },
          ),
        )
      }
      input(2)
      const baseline = events().length
      requestRerun()
      await until(() => count("writer-start") === 2, "held programmatic build")
      const hookBase = count("hook-entered")
      input(3)
      requestRerun()
      await until(() => count("hook-entered") >= hookBase + 1, "second admitted programmatic hook")
      input(4)
      requestRerun()
      await until(() => count("hook-entered") >= hookBase + 2, "third admitted programmatic hook")
      noReadsSince(baseline)
      release(2)
      await until(() => count("writer-start") === 3, "coalesced latest build")
      noReadsSince(baseline)
      input(5)
      const moreHooks = count("hook-entered")
      requestRerun()
      await until(() => count("hook-entered") >= moreHooks + 1, "request during final build")
      release(3)
      await until(() => count("writer-start") === 4, "last requested build")
      noReadsSince(baseline)
      release(4)
      const outcomes = await Promise.all(ownedReruns)
      assert.equal(outcomes.length, 4)
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.error
        assertPassed(outcome.result)
      }
      await context.waitForTestRunEnd()
      const readers = events()
        .filter((row) => row.kind === "reader")
        .slice(4)
      assert.equal(readers.length, 16)
      assert.ok(readers.every((row) => row.value === 5))
      assert.deepEqual(new Set(readers.map((row) => row.project)), new Set(["owner", "reader"]))
      assert.deepEqual(new Set(readers.map((row) => row.file)), new Set(files))
    }
  }
  await context.waitForTestRunEnd()
  assert.ok(
    runs.length > 0 &&
      runs.every((run) => run.errors === 0 && run.states.every((s) => s === "passed")),
  )
} catch (error) {
  firstError = { name: error.name, message: error.message, stack: error.stack }
  observerPhase = "failure-caught"
  event("driver-failure-caught", { error: firstError })
} finally {
  if (mode === "programmatic-coalescing" || mode === "later-reader-admission") {
    allowAdmissionA()
    // Release only existing fixture gates before joining already-owned requests.
    observerPhase = "join-owned-reruns"
    try {
      for (const build of mode === "later-reader-admission" ? [3] : [2, 3, 4]) {
        if (!existsSync(join(root, "release-" + build))) release(build)
      }
    } catch (error) {
      firstError ??= { name: error.name, message: error.message, stack: error.stack }
    }
    const outcomes = await Promise.all(ownedReruns)
    programmaticReruns = outcomes.map((outcome) => {
      if (outcome.status === "rejected") {
        const error = {
          name: outcome.error.name,
          message: outcome.error.message,
          stack: outcome.error.stack,
        }
        firstError ??= error
        return { request: outcome.request, status: outcome.status, error }
      }
      return {
        request: outcome.request,
        status: outcome.status,
        moduleCount: outcome.result.testModules.length,
        states: outcome.result.testModules.map((module) => module.state()),
        errors: outcome.result.unhandledErrors.length,
      }
    })
    event("programmatic-reruns-joined", { outcomes: programmaticReruns })
  }
  observerPhase = "close-start"
  event("driver-close-start")
  if (context) {
    try {
      await context.close()
      closed = true
    } catch (error) {
      firstError ??= { name: error.name, message: error.message, stack: error.stack }
    }
  }
  observerPhase = "close-done"
  event("driver-close-done", { closed })
}

let active = 0
let maximumWriters = 0
const actualEvents = events()
for (const row of actualEvents) {
  if (row.kind === "writer-start") maximumWriters = Math.max(maximumWriters, ++active)
  if (row.kind === "writer-end") active -= 1
  if (row.kind === "reader" && active !== 0) firstError ??= { message: "reader overlapped writer" }
  if (active < 0) firstError ??= { message: "writer event order was not balanced" }
}
if (active !== 0 || maximumWriters !== 1 || !closed)
  firstError ??= { message: "writer/closure qualification failed" }
if (failedBuildTransition) failedBuildTransition.afterClose = process.exitCode ?? null
const result = {
  ok: !firstError,
  mode,
  maximumWriters,
  closed,
  events: actualEvents,
  firstError,
  ...(failedBuildTransition ? { failedBuildTransition } : {}),
  ...(programmaticReruns ? { programmaticReruns } : {}),
}
writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
process.stdout.write("CONTROL_RESULT=" + JSON.stringify(result) + "\n")
if (firstError) process.exitCode = 1

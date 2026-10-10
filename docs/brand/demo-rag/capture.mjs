import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createAimock } from "../../../packages/testing/dist/index.js"
import {
  assertLoopbackModelBaseUrl,
  buildChildEnvironment,
  centerInScroller,
  closeBrowserResources,
  createBrowserResources,
  createManagedChildRegistry,
  createVideoTimeline,
  expandLatestTurn,
  expectedRootToolSteps,
  fillActiveWorkbenchComposer,
  frameSurface,
  installCaptureSignalHandlers,
  openReadyWorkbench,
  runManagedCommand,
  sanitizeOperationalEnvironment,
  settleWorkbenchViewport,
  startHttpService,
  startWithAssignedPort,
  validateRunId,
  validateToolchainVersions,
  waitForWorkbenchRunCompletion,
} from "../demo/capture.mjs"
import { DIRECTOR_FONTS, renderDirector } from "../demo/director.mjs"
import { createTrimPlan, encodePoster, encodeVideo } from "../demo/encode.mjs"
import { getAvailableLoopbackPort, stopManaged } from "../demo/processes.mjs"
import { beatSceneName, storyboardPaths } from "../demo/storyboard.mjs"
import { checkRagMedia, ragOutputPaths } from "./check-media.mjs"
import { applyOverlay } from "./overlay.mjs"
import { ragScenario } from "./scenario.mjs"
import { RAG_APP_FOCUS, RAG_POSTER_BEAT, RAG_STORYBOARD } from "./storyboard.mjs"

/**
 * The RAG take's capture. The navlog take's pipeline (`../demo/`) with this
 * take's app, scenario and storyboard:
 *
 * build → scaffold the navlog template → overlay `app/` (`overlay.mjs`) →
 * install → the generated `npm test` → aimock (the only scripted part) → the
 * B4.run server and the Workbench on loopback ports → the director page and a
 * lossless screencast → one scene per beat → encode `rag-loop.{mp4,webm}` and
 * a poster → check them against the media contract.
 *
 * Each app beat's action asserts its evidence in the real Workbench: the plan,
 * root tool steps that carry citation chips, the answer's checklist with met,
 * partial and missing rows, the checker's own chips, and a chip that opens its
 * cited section in the source reader.
 */

const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "../../..")
const VIEWPORT = Object.freeze({ width: 1440, height: 810 })
const DIRECTOR_PATH = "/__b4_demo_director/"
const VISIBLE = Object.freeze({ state: "visible", timeout: 120_000 })
/** The generated test the capture requires by name: it runs the real tools over the real workspace. */
export const REQUIRED_APP_TEST =
  "ranks the plan's communications section first and cites it as a linked chip"
/** The chip the checklist beat opens, by its label. */
export const OPENED_CHIP = "Sample Lakeview County EOP · 5. Communications"
/** Text of the cited section the reader must show once the chip is opened. */
export const OPENED_SECTION_TEXT = "names no backup if the radio system fails"
/** The waits inside the checklist beat, between its camera moves. */
export const CHECKLIST_HOLDS = Object.freeze({ tableMs: 3_000, chipsMs: 2_000 })
/** The prompt at rest in the composer, before the capture clicks Send. */
export const BEFORE_SEND_MS = 1_200

const sleep = (ms, signal) =>
  new Promise((resolvePromise, reject) => {
    signal?.throwIfAborted()
    const timer = setTimeout(resolvePromise, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

function check(result, label) {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (${result.exitCode})\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

/** The settled turn's root tool steps and their chips: every one cites at least one source. */
export async function assertCitedSteps(turn, tools) {
  const expected = expectedRootToolSteps(tools)
  const steps = turn.locator(':scope > ol.b4-turn__steps > li.b4-step[data-kind="tool"]')
  await steps.first().waitFor(VISIBLE)
  const count = await steps.count()
  if (count !== expected.length) {
    throw new Error(
      `The turn rendered ${count} tool steps, expected ${expected.length} (${expected.join(", ")})`,
    )
  }
  for (let index = 0; index < count; index++) {
    const chips = await steps.nth(index).locator(":scope > .b4-step__sources a.b4-chip").count()
    if (chips === 0)
      throw new Error(`Tool step ${index + 1} (${expected[index]}) shows no source chips`)
  }
  return steps
}

/** The answer's checklist: a row per element, with Met, Partial and Missing each present. */
export async function assertChecklist(main, checklist) {
  const table = main.locator("table").filter({ hasText: checklist[0].element }).last()
  await table.waitFor(VISIBLE)
  for (const row of checklist) {
    const tr = table.locator("tr").filter({ hasText: row.element })
    if ((await tr.count()) !== 1)
      throw new Error(`The checklist has no single row for ${row.element}`)
    const text = await tr.innerText()
    if (!text.includes(row.status))
      throw new Error(`The ${row.element} row does not read ${row.status}`)
  }
  for (const status of ["Met", "Partial", "Missing"]) {
    if (!checklist.some((row) => row.status === status)) throw new Error(`No ${status} row`)
  }
  return table
}

/**
 * Scrolls `locator` to the middle of its nearest scrolling ancestor (the
 * transcript), as `centerInScroller` does, but over `durationMs` with an
 * ease, so a move the camera sees reads as a reader's scroll, not a cut.
 */
export async function glideInScroller(locator, durationMs = 650) {
  await locator.evaluate(async (element, duration) => {
    let scroller = element.parentElement
    while (scroller !== null) {
      const { overflowY } = getComputedStyle(scroller)
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        scroller.scrollHeight > scroller.clientHeight
      )
        break
      scroller = scroller.parentElement
    }
    if (scroller === null) return
    const box = element.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    const from = scroller.scrollTop
    const max = scroller.scrollHeight - scroller.clientHeight
    const to = Math.min(
      max,
      Math.max(0, from + box.top - view.top - Math.max(0, (view.height - box.height) / 2)),
    )
    const start = performance.now()
    await new Promise((done) => {
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration)
        const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
        scroller.scrollTop = from + (to - from) * eased
        if (t < 1) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    })
  }, durationMs)
}

/** Opens a collapsed disclosure line (a plan or subagent step); a no-op when open. */
async function openLine(line) {
  if ((await line.getAttribute("aria-expanded")) !== "true") await line.click({ timeout: 60_000 })
}

export async function captureRag({
  repoRoot = DEFAULT_REPO_ROOT,
  recordOnly = false,
  runId = randomUUID(),
  parentEnv = process.env,
} = {}) {
  validateRunId(runId)
  const artifactsDir = join(repoRoot, "docs/brand/demo-rag/artifacts/runs", runId)
  const recordingsDir = join(repoRoot, "docs/brand/demo-rag/raw-recordings/runs", runId)
  const env = sanitizeOperationalEnvironment(parentEnv)
  const registry = createManagedChildRegistry((child) =>
    stopManaged(child, { timeoutMs: 5_000, confirmationTimeoutMs: 2_000 }),
  )
  const signals = installCaptureSignalHandlers()
  const { signal } = signals
  const run = (command, args, cwd) =>
    runManagedCommand(command, args, { cwd, env, signal, childRegistry: registry })
  let workspaceRoot
  let aimock
  let browser
  try {
    validateToolchainVersions({
      node: check(await run("node", ["--version"], repoRoot), "node --version").stdout.trim(),
      pnpm: check(await run("pnpm", ["--version"], repoRoot), "pnpm --version").stdout.trim(),
    })
    check(await run("pnpm", ["build"], repoRoot), "pnpm build")
    workspaceRoot = await mkdtemp(join(tmpdir(), "b4-rag-demo-"))
    const appRoot = join(workspaceRoot, "my-agent")
    check(
      await run(
        "node",
        [
          join(repoRoot, "packages/create-b4-app/dist/bin.js"),
          appRoot,
          "--mode",
          "internal",
          "--template",
          "navlog",
        ],
        repoRoot,
      ),
      "scaffold",
    )
    const overlaid = await applyOverlay({ appRoot })
    check(await run("pnpm", ["install"], appRoot), "pnpm install")
    await mkdir(artifactsDir, { recursive: true })
    await mkdir(recordingsDir, { recursive: true })
    const tested = await run("npm", ["test", "--", "--", "--reporter=verbose"], appRoot)
    await writeFile(join(artifactsDir, "test.log"), `${tested.stdout}\n${tested.stderr}`, "utf8")
    check(tested, "generated npm test")
    if (!tested.stdout.includes(REQUIRED_APP_TEST)) {
      throw new Error(`The generated test output does not name "${REQUIRED_APP_TEST}"`)
    }

    const scenario = ragScenario()
    aimock = await createAimock({ fixtures: scenario.fixtures })
    assertLoopbackModelBaseUrl(aimock.baseUrl)
    const getPort = async (excluded) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const port = await getAvailableLoopbackPort()
        if (!excluded.has(port)) return port
      }
      throw new Error("Could not assign a loopback port")
    }
    const server = await startWithAssignedPort({
      service: "B4.run server",
      excludedPorts: new Set([3002, 3010]),
      getPort,
      start: (port) =>
        startHttpService({
          command: "npm",
          args: ["exec", "--", "b4", "dev", "--port", String(port)],
          cwd: join(appRoot, "server"),
          env: buildChildEnvironment(parentEnv, aimock.baseUrl),
          readyUrl: `http://127.0.0.1:${port}/healthz`,
          service: "B4.run server",
          childRegistry: registry,
          signal,
        }),
    })
    const web = await startWithAssignedPort({
      service: "Workbench",
      excludedPorts: new Set([3002, 3010, server.port]),
      getPort,
      start: (port) =>
        startHttpService({
          command: "npm",
          args: ["exec", "--", "next", "dev", "--hostname", "127.0.0.1", "-p", String(port)],
          cwd: join(appRoot, "web"),
          env: {
            ...env,
            COPILOTKIT_TELEMETRY_DISABLED: "true",
            DO_NOT_TRACK: "1",
            NEXT_TELEMETRY_DISABLED: "1",
            B4_SERVER_URL: `http://127.0.0.1:${server.port}`,
          },
          readyUrl: `http://127.0.0.1:${port}`,
          service: "Workbench",
          childRegistry: registry,
          signal,
        }),
    })
    const workbenchUrl = `http://127.0.0.1:${web.port}`

    const paths = storyboardPaths(RAG_STORYBOARD)
    const files = Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [path, await readFile(join(appRoot, path), "utf8")]),
      ),
    )
    const fonts = Object.fromEntries(
      await Promise.all(
        Object.entries(DIRECTOR_FONTS).map(async ([name, path]) => [
          name,
          await readFile(join(repoRoot, path)),
        ]),
      ),
    )
    const html = renderDirector({ files, storyboard: RAG_STORYBOARD, focus: RAG_APP_FOCUS })

    const { chromium } = await import("@playwright/test")
    browser = await createBrowserResources({
      chromium,
      recordingsDir,
      viewport: { ...VIEWPORT },
      signal,
    })
    const { page } = browser
    const timeline = createVideoTimeline(() => performance.now())
    await page.route(`${workbenchUrl}${DIRECTOR_PATH}**`, (route) => {
      const { pathname } = new URL(route.request().url())
      if (pathname === DIRECTOR_PATH) {
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
      }
      const font = fonts[pathname.slice(`${DIRECTOR_PATH}fonts/`.length)]
      if (font !== undefined)
        return route.fulfill({ status: 200, contentType: "font/ttf", body: font })
      return route.fulfill({ status: 404, body: "" })
    })
    await page.goto(`${workbenchUrl}${DIRECTOR_PATH}`, { waitUntil: "load" })
    await page.waitForFunction(() => window.director?.ready === true, undefined, {
      timeout: 30_000,
    })
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const frame = page.frame({ name: "workbench" })
    if (frame === null) throw new Error("The director page has no workbench frame")
    const wb = frameSurface(page, frame)
    await openReadyWorkbench(wb, workbenchUrl)
    await fillActiveWorkbenchComposer(wb, scenario.prompt)
    await page.evaluate(() => window.director.reset())

    const main = wb.getByRole("main")
    const focus = (name) => page.evaluate((target) => window.director.focus(target), name)
    let turn
    const evidence = {}
    const actions = {
      async ask() {
        await sleep(BEFORE_SEND_MS, signal)
        await wb.getByRole("button", { name: "Send", exact: true }).click({ timeout: 60_000 })
        const plan = main.getByRole("list", { name: "Plan", exact: true })
        await plan.getByText(scenario.todos[0].content, { exact: true }).first().waitFor(VISIBLE)
        await waitForWorkbenchRunCompletion(wb, { turns: 1 })
        turn = await expandLatestTurn(wb)
        await openLine(
          turn.locator(
            ':scope > ol.b4-turn__steps > li.b4-step[data-kind="plan"] > button.b4-step__line',
          ),
        )
        for (const todo of scenario.todos)
          await plan.getByText(todo.content, { exact: true }).first().waitFor(VISIBLE)
        await centerInScroller(plan.first())
        await settleWorkbenchViewport(wb)
        await focus("todos")
      },
      // While the code beat before it holds the frame, so the app layer
      // fades in already on the steps.
      async "prepare cite"() {
        const steps = await assertCitedSteps(turn, scenario.parentTools)
        evidence.rootChips = await turn
          .locator(
            ':scope > ol.b4-turn__steps > li.b4-step[data-kind="tool"] .b4-step__sources a.b4-chip',
          )
          .count()
        await centerInScroller(steps.nth(1))
        await settleWorkbenchViewport(wb)
      },
      async cite() {
        await main.getByText(scenario.answerLead, { exact: true }).first().waitFor(VISIBLE)
        // From the steps down to the answer's verdict, under them.
        await glideInScroller(main.getByText(scenario.answerLead, { exact: true }).first(), 900)
        await settleWorkbenchViewport(wb)
      },
      async "prepare checklist"() {
        const table = await assertChecklist(main, scenario.checklist)
        evidence.checklistRows = scenario.checklist.map(({ element, status }) => ({
          element,
          status,
        }))
        await centerInScroller(table)
        await settleWorkbenchViewport(wb)
      },
      async checklist() {
        await sleep(CHECKLIST_HOLDS.tableMs, signal)
        // The checker's own steps, each with the sections it read as chips.
        const checker = turn.locator(
          ':scope > ol.b4-turn__steps > li.b4-step[data-kind="subagent"]',
        )
        await openLine(checker.locator(":scope > button.b4-step__line"))
        const chip = checker.locator("a.b4-chip", { hasText: OPENED_CHIP }).first()
        await chip.waitFor(VISIBLE)
        evidence.checkerChips = await checker.locator("a.b4-chip").count()
        await Promise.all([glideInScroller(chip, 700), focus("steps")])
        await settleWorkbenchViewport(wb)
        await sleep(CHECKLIST_HOLDS.chipsMs, signal)
        const href = await chip.getAttribute("href")
        await chip.click({ timeout: 60_000 })
        await settleWorkbenchViewport(wb)
        const reader = page
          .frames()
          .find(
            (candidate) => candidate.parentFrame() === frame && candidate.name() !== "workbench",
          )
        if (reader === undefined) throw new Error("The Workbench has no source reader frame")
        await reader.waitForURL((url) => `${url.pathname}${url.hash}` === href, { timeout: 60_000 })
        await reader
          .locator("section:target")
          .getByText(OPENED_SECTION_TEXT, { exact: false })
          .waitFor(VISIBLE)
        await settleWorkbenchViewport(wb)
        evidence.openedSource = href
        await focus("reader")
      },
    }

    for (const [index, beat] of RAG_STORYBOARD.entries()) {
      await timeline.scene(beatSceneName(index, beat), async () => {
        try {
          const prepare = beat.kind === "app" ? actions[`prepare ${beat.action}`] : undefined
          if (prepare !== undefined) await prepare()
          await page.evaluate((i) => window.director.play(i), index)
          if (beat.kind !== "app") return
          await actions[beat.action]()
          await sleep(beat.holdMs, signal)
        } catch (error) {
          throw new Error(`Beat ${index} (${beat.id}): ${error.message}`, { cause: error })
        }
      })
    }
    const recording = await closeBrowserResources({ ...browser, finalize: true, signal })
    browser = undefined
    const manifest = timeline.manifest()
    const summary = {
      schemaVersion: 1,
      runId,
      overlaid,
      prompt: scenario.prompt,
      evidence,
      paths: { recording: recording.videoPath },
      screencast: recording.screencast,
      videoTimeline: {
        ...manifest,
        videoOffsetMs: manifest.startedAtEpochMs - recording.screencast.firstFrameEpochMs,
      },
    }
    const trim = createTrimPlan(summary, {
      storyboard: RAG_STORYBOARD,
      posterBeat: RAG_POSTER_BEAT,
    })
    const first = manifest.scenes[beatSceneName(0, RAG_STORYBOARD[0])].startMs
    summary.beats = RAG_STORYBOARD.map((beat, index) => {
      const scene = manifest.scenes[beatSceneName(index, beat)]
      return {
        id: beat.id,
        startS: (scene.startMs - first) / 1_000,
        endS: (scene.endMs - first) / 1_000,
      }
    })
    summary.trim = trim
    await writeFile(
      join(artifactsDir, "capture-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    if (recordOnly) return summary

    const output = ragOutputPaths(artifactsDir)
    await mkdir(join(artifactsDir, "output"), { recursive: true })
    for (const format of ["mp4", "webm"]) {
      await encodeVideo({
        source: recording.videoPath,
        destination: output[format],
        trim,
        format,
        signal,
      })
    }
    await encodePoster({
      source: output.mp4,
      destination: output.poster,
      time: trim.posterTime,
      signal,
    })
    const failures = await checkRagMedia(artifactsDir)
    if (failures.length > 0)
      throw new Error(`The RAG take failed its media contract:\n${failures.join("\n")}`)
    await writeFile(
      join(repoRoot, "docs/brand/demo-rag/artifacts/latest.json"),
      `${JSON.stringify({ schemaVersion: 1, runId }, null, 2)}\n`,
    )
    summary.output = output
    return summary
  } finally {
    const errors = []
    for (const step of [
      () => (browser === undefined ? undefined : closeBrowserResources({ ...browser })),
      () => registry.stopRemaining(),
      () => aimock?.close(),
      () =>
        workspaceRoot === undefined
          ? undefined
          : rm(workspaceRoot, { recursive: true, force: true }),
      () => signals.restore(),
    ]) {
      try {
        await step()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) console.error("RAG capture cleanup failed:", ...errors)
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--")
  const unknown = args.filter((arg) => arg !== "--record-only")
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(", ")}`)
    process.exitCode = 1
  } else {
    captureRag({ recordOnly: args.includes("--record-only") }).then(
      (summary) => console.log(JSON.stringify(summary, null, 2)),
      (error) => {
        console.error(error instanceof Error ? error.stack : error)
        process.exitCode = 1
      },
    )
  }
}

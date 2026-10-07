import { spawn as nodeSpawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdir as nodeMkdir,
  mkdtemp as nodeMkdtemp,
  readFile as nodeReadFile,
  rename as nodeRename,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from "node:fs/promises"
import { isIP } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createAimock } from "../../../packages/testing/dist/index.js"
import { normalizeLog } from "./normalize-log.mjs"
import { getAvailableLoopbackPort, spawnManaged, stopManaged, waitForHttp } from "./processes.mjs"
import { DEMO_FIXTURES, DEMO_PROMPT } from "./scenario.mjs"
import { GENERATED_PATHS, renderStage } from "./stage.mjs"

const EXPECTED_TOOLS = DEMO_FIXTURES.flatMap(
  (fixture) => fixture.response.toolCalls?.map((toolCall) => toolCall.name) ?? [],
)
const EXPECTED_ANSWER = DEMO_FIXTURES.findLast(
  (fixture) => typeof fixture.response.content === "string",
)?.response.content
if (typeof EXPECTED_ANSWER !== "string") {
  throw new Error("Canonical demo fixtures must end in a text answer")
}
const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "../../..")
const DEFAULT_SCAFFOLD_PORTS = new Set([3002, 3010])
const NODE_MINIMUM_MAJOR = 24
const PNPM_VERSION = "10.33.0"
const VIEWPORT = Object.freeze({ width: 1440, height: 810 })
const DEFAULT_HOLD_DURATIONS = Object.freeze({
  preReloadMs: 1_200,
  restorationMs: 1_800,
})
const DEFAULT_TIMING = Object.freeze({
  now: () => performance.now(),
  sleep: (durationMs, { signal } = {}) =>
    new Promise((resolvePromise, reject) => {
      signal?.throwIfAborted()
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolvePromise()
      }, durationMs)
      const onAbort = () => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", onAbort)
        reject(signal.reason ?? new Error("Capture hold cancelled"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    }),
})
// Child processes receive only local toolchain, package-manager, locale, temp,
// home/cache, and CI settings. Everything else is excluded by construction.
const OPERATIONAL_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CI",
  "PNPM_HOME",
  "COREPACK_HOME",
  "XDG_CACHE_HOME",
  "npm_config_cache",
  "npm_config_store_dir",
  "npm_config_userconfig",
])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}

function assertCommandSucceeded(result, label) {
  if (result.exitCode === 0) return result
  const transcript = [result.stdout, result.stderr].filter(Boolean).join("\n")
  throw new Error(
    `${label} failed with exit code ${result.exitCode}${transcript ? `\n${transcript}` : ""}`,
  )
}

export function validateToolchainVersions({ node, pnpm }) {
  requireString(node, "Node version")
  requireString(pnpm, "pnpm version")
  const nodeMatch = /^v(\d+)\.(\d+)\.(\d+)$/.exec(node)
  if (nodeMatch === null || Number(nodeMatch[1]) < NODE_MINIMUM_MAJOR) {
    throw new Error(`Capture requires Node >=24.0.0; received ${node}`)
  }
  if (pnpm !== PNPM_VERSION) {
    throw new Error(`Capture requires pnpm ${PNPM_VERSION}; received ${pnpm}`)
  }
  return { node, pnpm }
}

export function validateRunId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError("run id must contain only letters, digits, hyphens, and underscores")
  }
  return value
}

function createVideoTimeline(now) {
  if (typeof now !== "function") throw new TypeError("timing.now must be a function")
  const startedAtMonotonicMs = now()
  const scenes = {}
  let previousEnd = 0
  return {
    async scene(name, action) {
      const startMs = now() - startedAtMonotonicMs
      if (startMs < previousEnd) throw new Error("scene clock must be monotonic")
      const value = await action()
      const endMs = now() - startedAtMonotonicMs
      if (endMs < startMs) throw new Error("scene clock must be monotonic")
      scenes[name] = { startMs, endMs }
      previousEnd = endMs
      return value
    },
    manifest() {
      return {
        unit: "milliseconds",
        startedAtMonotonicMs,
        endedAtMonotonicMs: startedAtMonotonicMs + previousEnd,
        scenes: { ...scenes },
      }
    },
  }
}

export function generatedTestCommand() {
  return {
    command: "npm",
    // The first separator reaches the generated root script; the second makes
    // its inner workspace `npm run` forward Vitest's reporter flag.
    args: ["test", "--", "--", "--reporter=verbose"],
  }
}

export function generatedInstallCommand() {
  return { command: "pnpm", args: ["install"] }
}

export function sanitizeOperationalEnvironment(parentEnvironment = process.env) {
  if (!parentEnvironment || typeof parentEnvironment !== "object") {
    throw new TypeError("parentEnvironment must be an object")
  }
  return Object.fromEntries(
    OPERATIONAL_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = parentEnvironment[key]
      return typeof value === "string" ? [[key, value]] : []
    }),
  )
}

export function assertLoopbackModelBaseUrl(value) {
  requireString(value, "model base URL")
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("model base URL must be a loopback HTTP(S) URL")
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const ipFamily = isIP(hostname)
  const isLoopback =
    (ipFamily === 4 && hostname.split(".")[0] === "127") || (ipFamily === 6 && hostname === "::1")
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopback ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TypeError("model base URL must be a loopback HTTP(S) URL")
  }
  return url
}

export function buildChildEnvironment(parentEnvironment, modelBaseUrl) {
  const url = assertLoopbackModelBaseUrl(modelBaseUrl)
  return {
    ...sanitizeOperationalEnvironment(parentEnvironment),
    // `npm exec -- b4 ...` otherwise resolves the unrelated registry package
    // when dependencies were laid out by pnpm instead of npm.
    npm_config_package: "@b4run/cli",
    OPENAI_BASE_URL: url.href,
    OPENAI_API_KEY: "test-not-used",
    COPILOTKIT_TELEMETRY_DISABLED: "true",
    DO_NOT_TRACK: "1",
  }
}

export async function startWithAssignedPort({
  service,
  excludedPorts = new Set(),
  getPort,
  start,
  maxAttempts = 3,
}) {
  requireString(service, "service")
  if (!(excludedPorts instanceof Set)) {
    throw new TypeError("excludedPorts must be a Set")
  }
  if (typeof getPort !== "function") throw new TypeError("getPort must be a function")
  if (typeof start !== "function") throw new TypeError("start must be a function")
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive integer")
  }

  const attemptedPorts = new Set(excludedPorts)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const port = await getPort(attemptedPorts)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${service} port allocator returned an invalid port`)
    }
    if (attemptedPorts.has(port)) {
      throw new Error(`${service} port allocator returned excluded port ${port}`)
    }
    attemptedPorts.add(port)
    try {
      const started = await start(port)
      if (started && typeof started === "object" && Object.hasOwn(started, "child")) {
        return { ...started, port }
      }
      return { child: started, port }
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error
      if (attempt === maxAttempts) {
        throw new Error(`${service} failed after ${maxAttempts} EADDRINUSE attempts`, {
          cause: error,
        })
      }
    }
  }
  throw new Error(`${service} failed to start`)
}

export function createManagedChildRegistry(stopChild) {
  if (typeof stopChild !== "function") {
    throw new TypeError("stopChild must be a function")
  }
  const children = new Set()
  return {
    track(child) {
      children.add(child)
      return child
    },
    release(child) {
      children.delete(child)
    },
    async stop(child) {
      if (!children.has(child)) return
      await stopChild(child)
      children.delete(child)
    },
    async stopRemaining() {
      const errors = []
      for (const child of [...children].reverse()) {
        try {
          await stopChild(child)
          children.delete(child)
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Managed child cleanup failed")
      }
    },
  }
}

export function runManagedCommand(
  command,
  args,
  {
    cwd,
    env,
    spawn = nodeSpawn,
    signal,
    childRegistry = createManagedChildRegistry((child) =>
      stopManaged(child, {
        timeoutMs: 5_000,
        confirmationTimeoutMs: 2_000,
      }),
    ),
  } = {},
) {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = childRegistry.track(
      spawnManaged(command, args, {
        spawn,
        options: { cwd, env },
      }),
    )
    let stdout = ""
    let stderr = ""
    let settled = false
    let aborting = false
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    const cleanup = () => {
      child.off("error", onError)
      child.off("close", onClose)
      if (signal !== undefined) signal.removeEventListener("abort", onAbort)
    }
    const onError = (error) => {
      if (settled || aborting) return
      settled = true
      cleanup()
      childRegistry.release(child)
      reject(error)
    }
    const onClose = (code, childSignal) => {
      if (settled || aborting) return
      settled = true
      cleanup()
      childRegistry.release(child)
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? (childSignal === null ? 1 : 128),
        ...(childSignal !== null ? { signal: childSignal } : {}),
      })
    }
    const onAbort = async () => {
      if (settled || aborting) return
      aborting = true
      const cancellation = signal.reason ?? new Error("Command cancelled")
      let cleanupError
      try {
        await childRegistry.stop(child)
      } catch (error) {
        cleanupError = error
      }
      settled = true
      cleanup()
      if (cleanupError === undefined) reject(cancellation)
      else {
        reject(
          new AggregateError(
            [cancellation, cleanupError],
            `${errorMessage(cancellation)}; command cleanup also failed`,
            { cause: cancellation },
          ),
        )
      }
    }
    child.once("error", onError)
    child.once("close", onClose)
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) void onAbort()
    }
  })
}

function createCommandAdapter({ repoRoot, parentEnvironment }) {
  const environment = sanitizeOperationalEnvironment(parentEnvironment)
  const childRegistry = createManagedChildRegistry((child) =>
    stopManaged(child, {
      timeoutMs: 5_000,
      confirmationTimeoutMs: 2_000,
    }),
  )
  const run = (command, args, options) =>
    runManagedCommand(command, args, { ...options, childRegistry })
  return {
    async checkToolchain({ signal } = {}) {
      const [nodeResult, pnpmResult] = await Promise.all([
        run("node", ["--version"], {
          cwd: repoRoot,
          env: environment,
          signal,
        }),
        run("pnpm", ["--version"], {
          cwd: repoRoot,
          env: environment,
          signal,
        }),
      ])
      assertCommandSucceeded(nodeResult, "node --version")
      assertCommandSucceeded(pnpmResult, "pnpm --version")
      const actual = {
        node: nodeResult.stdout.trim(),
        pnpm: pnpmResult.stdout.trim(),
      }
      return validateToolchainVersions(actual)
    },
    async build({ signal } = {}) {
      assertCommandSucceeded(
        await run("pnpm", ["build"], {
          cwd: repoRoot,
          env: environment,
          signal,
        }),
        "pnpm build",
      )
    },
    async scaffold({ appRoot, signal }) {
      assertCommandSucceeded(
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
          { cwd: repoRoot, env: environment, signal },
        ),
        "internal scaffold",
      )
    },
    async install({ appRoot, signal }) {
      const installCommand = generatedInstallCommand()
      assertCommandSucceeded(
        await run(installCommand.command, installCommand.args, {
          cwd: appRoot,
          env: environment,
          signal,
        }),
        "pnpm install",
      )
    },
    test({ appRoot, signal }) {
      const testCommand = generatedTestCommand()
      return run(testCommand.command, testCommand.args, {
        cwd: appRoot,
        env: environment,
        signal,
      })
    },
    stopRemaining() {
      return childRegistry.stopRemaining()
    },
  }
}

export async function startHttpService({
  command,
  args,
  cwd,
  env,
  readyUrl,
  service,
  childRegistry,
  signal,
  spawn = nodeSpawn,
  waitUntilReady = waitForHttp,
}) {
  signal?.throwIfAborted()
  const child = childRegistry.track(spawnManaged(command, args, { spawn, options: { cwd, env } }))
  const monitor = createManagedServiceMonitor({ child, service })
  try {
    await waitUntilReady(readyUrl, child, {
      timeoutMs: 90_000,
      intervalMs: 150,
      signal,
    })
    monitor.arm()
    return monitor
  } catch (error) {
    monitor.markExpectedExit()
    let cleanupError
    try {
      await childRegistry.stop(child)
    } catch (caught) {
      cleanupError = caught
    }
    const transcript = monitor.transcript()
    const wrapped = new Error(
      `${service} did not become ready: ${errorMessage(error)}${transcript ? `\n${transcript}` : ""}`,
      { cause: error },
    )
    if (/EADDRINUSE/.test(transcript) || error?.code === "EADDRINUSE") {
      wrapped.code = "EADDRINUSE"
    }
    if (cleanupError !== undefined) wrapped.cleanupError = cleanupError
    throw wrapped
  }
}

export function createManagedServiceMonitor({ child, service, maxTranscriptLength = 8_000 }) {
  requireString(service, "service")
  if (!child || typeof child.once !== "function") {
    throw new TypeError("child must be an event emitter")
  }
  let output = ""
  let armed = false
  let expectedExit = false
  let rejectUnexpected
  const unexpectedExit = new Promise((_, reject) => {
    rejectUnexpected = reject
  })
  unexpectedExit.catch(() => {})
  const append = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-maxTranscriptLength)
  }
  child.stdout?.setEncoding?.("utf8")
  child.stderr?.setEncoding?.("utf8")
  child.stdout?.on("data", append)
  child.stderr?.on("data", append)
  const rejectExit = (detail) => {
    if (!armed || expectedExit) return
    const transcript = output.length === 0 ? "" : `\n${output}`
    rejectUnexpected(new Error(`${service} exited unexpectedly (${detail})${transcript}`))
  }
  child.once("exit", (code, signal) =>
    rejectExit(code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`),
  )
  child.once("error", (error) => rejectExit(`error ${errorMessage(error)}`))
  return {
    child,
    unexpectedExit,
    arm() {
      armed = true
      if (child.exitCode !== null && child.exitCode !== undefined) {
        rejectExit(`code ${child.exitCode}`)
      } else if (child.signalCode !== null && child.signalCode !== undefined) {
        rejectExit(`signal ${child.signalCode}`)
      }
    },
    markExpectedExit() {
      expectedExit = true
    },
    transcript() {
      return output
    },
  }
}

export async function raceCapturePhase(label, action, services = [], signal) {
  requireString(label, "phase label")
  if (typeof action !== "function") throw new TypeError("phase action must be a function")
  let onAbort
  const cancellation =
    signal === undefined
      ? []
      : [
          new Promise((_, reject) => {
            onAbort = () => reject(signal.reason ?? new Error(`${label} cancelled`))
            if (signal.aborted) onAbort()
            else signal.addEventListener("abort", onAbort, { once: true })
          }),
        ]
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      ...services
        .filter((service) => service?.unexpectedExit instanceof Promise)
        .map((service) => service.unexpectedExit),
      ...cancellation,
    ])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort)
  }
}

async function runOwnedAbortablePhase({
  label,
  action,
  services,
  abortController,
  onInterrupt,
  disposeResult,
}) {
  abortController.signal.throwIfAborted()
  const operation = Promise.resolve().then(action)
  try {
    return await raceCapturePhase(label, () => operation, services, abortController.signal)
  } catch (error) {
    // The operation owns any resource or child it creates and must settle after
    // observing this signal. Waiting prevents a rejected race from orphaning work.
    if (!abortController.signal.aborted) abortController.abort(error)
    const interruption =
      typeof onInterrupt === "function"
        ? Promise.resolve().then(() => onInterrupt(error))
        : Promise.resolve()
    const [operationSettlement, interruptionSettlement] = await Promise.all([
      operation.then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ reason, status: "rejected" }),
      ),
      interruption.then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ reason, status: "rejected" }),
      ),
    ])
    const ownershipErrors = []
    if (interruptionSettlement.status === "rejected") {
      ownershipErrors.push(interruptionSettlement.reason)
    }
    if (operationSettlement.status === "fulfilled" && typeof disposeResult === "function") {
      try {
        await disposeResult(operationSettlement.value)
      } catch (cleanupError) {
        ownershipErrors.push(cleanupError)
      }
    }
    if (ownershipErrors.length > 0) {
      throw new AggregateError(
        [error, ...ownershipErrors],
        `${errorMessage(error)}; interrupted operation cleanup also failed`,
        { cause: error },
      )
    }
    throw error
  }
}

function createProcessSignalAdapter() {
  return {
    on: (signal, handler) => process.on(signal, handler),
    off: (signal, handler) => process.off(signal, handler),
    forceExit(signal) {
      process.exit(signal === "SIGINT" ? 130 : 143)
    },
  }
}

export function installCaptureSignalHandlers({
  signalAdapter = createProcessSignalAdapter(),
  abortController = new AbortController(),
} = {}) {
  for (const method of ["on", "off", "forceExit"]) {
    if (typeof signalAdapter?.[method] !== "function") {
      throw new TypeError(`signalAdapter.${method} must be a function`)
    }
  }
  let receivedSignal = false
  let restored = false
  const handlers = new Map()
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (receivedSignal) {
        signalAdapter.forceExit(signal)
        return
      }
      receivedSignal = true
      abortController.abort(new Error(`Capture cancelled by ${signal}`))
    }
    handlers.set(signal, handler)
    signalAdapter.on(signal, handler)
  }
  return {
    signal: abortController.signal,
    restore() {
      if (restored) return
      restored = true
      for (const [signal, handler] of handlers) signalAdapter.off(signal, handler)
    },
  }
}

function createProcessAdapter() {
  const childRegistry = createManagedChildRegistry((child) =>
    stopManaged(child, {
      timeoutMs: 5_000,
      confirmationTimeoutMs: 2_000,
    }),
  )
  const serviceHandles = new WeakMap()
  return {
    startAimock(fixtures) {
      return createAimock({ fixtures })
    },
    async getPort(excludedPorts) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const port = await getAvailableLoopbackPort()
        if (!excludedPorts.has(port)) return port
      }
      throw new Error("Could not assign a distinct loopback port")
    },
    async startB4({ cwd, port, env, signal }) {
      const handle = await startHttpService({
        command: "npm",
        args: ["exec", "--", "b4", "dev", "--port", String(port)],
        cwd,
        env,
        readyUrl: `http://127.0.0.1:${port}/healthz`,
        service: "B4.run server",
        childRegistry,
        signal,
      })
      serviceHandles.set(handle.child, handle)
      return handle
    },
    async startWorkbench({ cwd, port, env, signal }) {
      const handle = await startHttpService({
        command: "npm",
        args: ["exec", "--", "next", "dev", "--hostname", "127.0.0.1", "-p", String(port)],
        cwd,
        env,
        readyUrl: `http://127.0.0.1:${port}`,
        service: "Workbench",
        childRegistry,
        signal,
      })
      serviceHandles.set(handle.child, handle)
      return handle
    },
    stop(child) {
      serviceHandles.get(child)?.markExpectedExit()
      return childRegistry.stop(child)
    },
    stopRemaining() {
      return childRegistry.stopRemaining()
    },
  }
}

function createFilesystemAdapter() {
  return {
    mkdtemp: nodeMkdtemp,
    mkdir: nodeMkdir,
    readFile: nodeReadFile,
    rename: nodeRename,
    rm: nodeRm,
    writeFile: nodeWriteFile,
  }
}

export async function openReadyWorkbench(page, url) {
  const origin = new URL(url).origin
  const runtimeReady = page.waitForResponse(
    (response) => {
      const responseUrl = new URL(response.url())
      return (
        response.request().method() === "GET" &&
        responseUrl.origin === origin &&
        responseUrl.pathname === "/api/copilotkit/info"
      )
    },
    { timeout: 60_000 },
  )
  const navigation = Promise.resolve().then(() => page.goto(url, { waitUntil: "domcontentloaded" }))
  const [response] = await Promise.all([runtimeReady, navigation])
  if (!response.ok()) {
    throw new Error(`CopilotKit runtime readiness failed with HTTP ${response.status()}`)
  }
}

/**
 * The map Workbench keeps its thread list behind a "Threads" disclosure button
 * in the chat dock (`ChatDock.tsx`). Opens it if it is closed and returns the
 * toggle, so the caller can close it again once it has used a row: left open,
 * the list floats over the transcript.
 */
async function openThreadList(page, { timeoutMs = 60_000, settleMs = 2_000, pollMs = 100 } = {}) {
  const toggle = page.getByRole("button", { name: "Threads", exact: true })
  await toggle.waitFor({ state: "visible", timeout: timeoutMs })
  const deadline = Date.now() + timeoutMs
  // The Workbench disables the toggle until React has hydrated, and
  // Playwright's click waits for "enabled", so the first click normally
  // works. The poll is the backstop: a click that is still dropped (CI load
  // put one before hydration) gets re-sent once its settle window passes,
  // instead of the journey waiting 60s on a list that never opened.
  while ((await toggle.getAttribute("aria-expanded")) !== "true") {
    if (Date.now() > deadline) {
      throw new Error("The Workbench thread list did not open: Threads stayed aria-expanded=false")
    }
    await toggle.click({ timeout: Math.max(1, deadline - Date.now()) })
    const settleBy = Date.now() + settleMs
    while (Date.now() < settleBy && (await toggle.getAttribute("aria-expanded")) !== "true") {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  // Expanded is the state; the list itself being laid out is what a row wait needs.
  await page
    .getByRole("navigation", { name: "Conversations" })
    .waitFor({ state: "visible", timeout: Math.max(1, deadline - Date.now()) })
  return toggle
}

/** A thread row, scrolled into the list's visible area before it is waited on. */
async function threadRow(page, name) {
  const row = page.getByRole("button", { name, exact: true })
  await row.scrollIntoViewIfNeeded({ timeout: 60_000 })
  return row
}

async function closeThreadList(toggle) {
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click()
}

export async function fillActiveWorkbenchComposer(page, prompt) {
  requireString(prompt, "prompt")
  // The untitled active thread's row is the readiness proof: it exists only
  // once the Workbench has created or restored the thread a send binds to.
  const threads = await openThreadList(page)
  const activeRow = await threadRow(page, "New conversation")
  await activeRow.waitFor({ state: "visible", timeout: 60_000 })
  await closeThreadList(threads)
  const messageBox = page.getByRole("textbox", { name: "Message" })
  await messageBox.fill(prompt)
}

/**
 * A turn of the root conversation, never a subagent's nested one: the
 * activity kit (`TurnActivity`) renders a subagent's own turn inside its
 * step's `.b4-step__children` panel, with the same `section.b4-turn` markup.
 */
export const ROOT_TURN_SELECTOR = "section.b4-turn:not(.b4-step__children *)"

/** A root turn that has settled: finished, failed or stopped — not working, not awaiting approval. */
export const SETTLED_ROOT_TURN_SELECTOR = `${ROOT_TURN_SELECTOR}:is([data-state="done"], [data-state="failed"], [data-state="stopped"])`

const CONNECT_PATHNAME = "/api/copilotkit/agent/default/connect"

export async function waitForWorkbenchRunCompletion(page) {
  // The run's own turn settling is the proof the run ended. Stop and Send are
  // one button, so without this a wait that starts before the run renders its
  // Stop state would pass on the idle composer the click left behind.
  await page
    .getByRole("main")
    .locator(SETTLED_ROOT_TURN_SELECTOR)
    .last()
    .waitFor({ state: "visible", timeout: 120_000 })
  await page
    .getByRole("button", { name: "Stop", exact: true })
    .waitFor({ state: "hidden", timeout: 120_000 })
  await page
    .getByRole("button", { name: "Send", exact: true })
    .waitFor({ state: "visible", timeout: 120_000 })
  // The generated composer intentionally disables Send for an empty draft, so
  // editability—not button enabledness—is the real idle-state proof.
  await page.getByRole("textbox", { name: "Message" }).fill("", { timeout: 120_000 })
}

/**
 * Opens the latest settled root turn's activity and returns the turn. A turn
 * folds once it settles, and a restored one starts folded, so its steps are
 * not in the DOM until its summary is expanded.
 */
export async function expandLatestTurn(page, { timeout = 120_000 } = {}) {
  const turn = page.getByRole("main").locator(SETTLED_ROOT_TURN_SELECTOR).last()
  await turn.waitFor({ state: "visible", timeout })
  const summary = turn.locator(":scope > button.b4-turn__summary")
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.click({ timeout })
  }
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    throw new Error("The latest turn's summary did not expand (aria-expanded stayed false)")
  }
  return turn
}

/**
 * The turn's own tool steps: not a subagent's (inside `.b4-step__children`),
 * and not the members of a folded group of repeated calls.
 */
function rootToolSteps(turn) {
  return turn.locator(':scope > ol.b4-turn__steps > li.b4-step[data-kind="tool"]')
}

/**
 * Whether `response` is the CopilotKit connect POST for `threadId` on this
 * Workbench: `CopilotChat` restores a thread by connecting to it, and the
 * runtime route replays the thread from B4.run's storage. Under StrictMode
 * the first connect is aborted and a second follows; either may match, which
 * is why the DOM waits after it are the evidence, not this response.
 */
export function isThreadConnectResponse(response, { origin, threadId }) {
  let url
  try {
    url = new URL(response.url())
  } catch {
    return false
  }
  if (response.request().method() !== "POST") return false
  if (url.origin !== origin || url.pathname !== CONNECT_PATHNAME) return false
  try {
    return JSON.parse(response.request().postData() ?? "{}").threadId === threadId
  } catch {
    return false
  }
}

export async function restoreWorkbenchThread(
  page,
  { workbenchUrl, threadId, prompt, tools, answer },
) {
  const origin = new URL(workbenchUrl).origin
  const connected = page.waitForResponse(
    (response) => isThreadConnectResponse(response, { origin, threadId }),
    { timeout: 120_000 },
  )
  const interaction = Promise.resolve().then(async () => {
    await page.reload({ waitUntil: "domcontentloaded" })
    const threads = await openThreadList(page)
    const row = await threadRow(page, prompt)
    await row.waitFor({ state: "visible", timeout: 60_000 })
    await row.click()
    // Selecting another thread remounts the workbench (the activity is keyed
    // by the thread), which closes the list and detaches this row: the dock
    // title is the evidence the selection took, not the row's aria-current.
    await page
      .getByRole("heading", { level: 2, name: prompt, exact: true })
      .waitFor({ state: "visible", timeout: 60_000 })
    // The reload usually lands on this thread already (the newest is active),
    // and re-selecting it remounts nothing, so the list is still open.
    await closeThreadList(threads)
  })
  const [response] = await Promise.all([connected, interaction])
  if (!response.ok()) {
    throw new Error(`Thread restoration failed with HTTP ${response.status()}`)
  }
  const main = page.getByRole("main")
  const visible = { state: "visible", timeout: 120_000 }
  await main.getByText(prompt, { exact: true }).last().waitFor(visible)
  const turns = main.locator(SETTLED_ROOT_TURN_SELECTOR)
  await turns.first().waitFor(visible)
  const turnCount = await main.locator(ROOT_TURN_SELECTOR).count()
  if (turnCount !== 1) {
    throw new Error(`The restored thread rendered ${turnCount} turns, expected exactly 1`)
  }
  // A restored turn starts folded; its steps are in the DOM only once opened.
  const turn = await expandLatestTurn(page)
  const steps = rootToolSteps(turn)
  if (tools.length > 0) await steps.first().waitFor(visible)
  const stepCount = await steps.count()
  if (stepCount !== tools.length) {
    throw new Error(
      `The restored turn rendered ${stepCount} tool steps, expected ${tools.length} (${tools.join(", ")})`,
    )
  }
  await main.getByText(answer, { exact: true }).last().waitFor(visible)
  return { connectUrl: response.url() }
}

export async function closeBrowserResources({ context, video, browser }) {
  const errors = []
  let videoPath
  try {
    await context.close()
  } catch (error) {
    errors.push(error)
  }
  if (video !== null) {
    try {
      videoPath = await video.path()
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    await browser.close()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Browser cleanup failed: ${errors.map(errorMessage).join("; ")}`,
    )
  }
  return videoPath === undefined ? {} : { videoPath }
}

export async function createBrowserResources({ chromium, recordingsDir, viewport, signal }) {
  let browser
  let context
  let page
  try {
    signal?.throwIfAborted()
    browser = await chromium.launch({ headless: true })
    signal?.throwIfAborted()
    context = await browser.newContext({
      viewport,
      recordVideo: { dir: recordingsDir, size: viewport },
    })
    signal?.throwIfAborted()
    page = await context.newPage()
    signal?.throwIfAborted()
    return { browser, context, page, video: page.video() }
  } catch (error) {
    const cleanupErrors = []
    for (const resource of [page, context, browser]) {
      if (resource === undefined) continue
      try {
        await resource.close()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length === 0) throw error
    throw new AggregateError(
      [error, ...cleanupErrors],
      `${errorMessage(error)}; browser acquisition cleanup also failed`,
      { cause: error },
    )
  }
}

function createBrowserAdapter() {
  return {
    async open({ recordingsDir, viewport, signal }) {
      signal?.throwIfAborted()
      const { chromium } = await import("@playwright/test")
      const { browser, context, page, video } = await createBrowserResources({
        chromium,
        recordingsDir,
        viewport,
        signal,
      })
      let closePromise
      const close = () => {
        closePromise ??= closeBrowserResources({ context, video, browser })
        return closePromise
      }
      const runSessionOperation = async (operationSignal, action) => {
        if (operationSignal?.aborted) {
          await close()
          operationSignal.throwIfAborted()
        }
        let abortClosePromise
        const onAbort = () => {
          abortClosePromise ??= close()
          abortClosePromise.catch(() => {})
        }
        operationSignal?.addEventListener("abort", onAbort, { once: true })
        try {
          const value = await action()
          if (operationSignal?.aborted) {
            await (abortClosePromise ?? close())
            operationSignal.throwIfAborted()
          }
          return value
        } catch (error) {
          if (!operationSignal?.aborted) throw error
          const cancellation = operationSignal.reason ?? error
          try {
            await (abortClosePromise ?? close())
          } catch (cleanupError) {
            throw new AggregateError(
              [cancellation, cleanupError],
              `${errorMessage(cancellation)}; browser cleanup also failed`,
              { cause: cancellation },
            )
          }
          throw cancellation
        } finally {
          operationSignal?.removeEventListener("abort", onAbort)
        }
      }
      return {
        async recordStage({ html, signal: operationSignal }) {
          return runSessionOperation(operationSignal, async () => {
            await page.setContent(html, { waitUntil: "load" })
            await page.locator("body").waitFor({ state: "visible" })
            await page.waitForTimeout(1_400)
          })
        },
        async runScenario({ url, prompt, tools, answer, signal: operationSignal }) {
          return runSessionOperation(operationSignal, async () => {
            await openReadyWorkbench(page, url)
            await fillActiveWorkbenchComposer(page, prompt)
            await page.getByRole("button", { name: "Send", exact: true }).click()
            await waitForWorkbenchRunCompletion(page)
            // The settled turn is folded: open it so its steps are on screen
            // (and in the recording) before they are counted.
            const turn = await expandLatestTurn(page)
            const steps = rootToolSteps(turn)
            await steps.first().waitFor({ state: "visible", timeout: 120_000 })
            const stepCount = await steps.count()
            if (stepCount < tools.length) {
              throw new Error(
                `The run rendered ${stepCount} tool steps, expected at least ${tools.length}`,
              )
            }
            await page.getByRole("main").getByText(answer, { exact: true }).last().waitFor({
              state: "visible",
              timeout: 120_000,
            })
            const threadId = await page.evaluate((title) => {
              const raw = localStorage.getItem("b4.workbench.threads")
              const threads = raw === null ? [] : JSON.parse(raw)
              const thread = threads.find((entry) => entry?.title === title)
              return typeof thread?.id === "string" ? thread.id : undefined
            }, prompt)
            if (threadId === undefined) {
              throw new Error("Workbench did not persist the active thread id")
            }
            return { threadId }
          })
        },
        async reloadAndRestore({
          workbenchUrl,
          threadId,
          prompt,
          tools,
          answer,
          signal: operationSignal,
        }) {
          return runSessionOperation(operationSignal, () =>
            restoreWorkbenchThread(page, {
              workbenchUrl,
              threadId,
              prompt,
              tools,
              answer,
            }),
          )
        },
        async recordRun({ signal: operationSignal } = {}) {
          return runSessionOperation(operationSignal, () => page.waitForTimeout(1_800))
        },
        close,
      }
    },
  }
}

function mergeAdapters(defaults, overrides = {}) {
  return {
    commands: { ...defaults.commands, ...overrides.commands },
    filesystem: { ...defaults.filesystem, ...overrides.filesystem },
    processes: { ...defaults.processes, ...overrides.processes },
    browser: { ...defaults.browser, ...overrides.browser },
    timing: { ...defaults.timing, ...overrides.timing },
  }
}

async function cleanupResource(action, errors) {
  try {
    await action()
  } catch (error) {
    errors.push(error)
  }
}

async function encodeWithFutureModule(options) {
  let encoderModule
  try {
    encoderModule = await import("./encode.mjs")
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      errorMessage(error).includes("docs/brand/demo/encode.mjs")
    ) {
      throw new Error(
        "Encoding requested but docs/brand/demo/encode.mjs is unavailable; use --record-only until the encoder is implemented",
        { cause: error },
      )
    }
    throw error
  }
  if (typeof encoderModule.encodeCaptureArtifacts !== "function") {
    throw new TypeError("docs/brand/demo/encode.mjs must export encodeCaptureArtifacts(options)")
  }
  return encoderModule.encodeCaptureArtifacts(options)
}

export async function captureDemo({
  repoRoot = DEFAULT_REPO_ROOT,
  parentEnv = process.env,
  adapters: adapterOverrides,
  recordOnly = false,
  encodeCaptureArtifacts = encodeWithFutureModule,
  runIdFactory = randomUUID,
  timing: timingOverride,
  holdDurations = DEFAULT_HOLD_DURATIONS,
  signalAdapter = createProcessSignalAdapter(),
} = {}) {
  requireString(repoRoot, "repoRoot")
  if (typeof runIdFactory !== "function") throw new TypeError("runIdFactory must be a function")
  const runId = validateRunId(runIdFactory())
  const artifactsDir = join(repoRoot, "docs/brand/demo/artifacts/runs", runId)
  const recordingsDir = join(repoRoot, "docs/brand/demo/raw-recordings/runs", runId)
  const logPaths = {
    stdout: join(artifactsDir, "test.stdout.log"),
    stderr: join(artifactsDir, "test.stderr.log"),
    result: join(artifactsDir, "test.result.json"),
  }
  const defaults = {
    commands: createCommandAdapter({ repoRoot, parentEnvironment: parentEnv }),
    filesystem: createFilesystemAdapter(),
    processes: createProcessAdapter(),
    browser: createBrowserAdapter(),
    timing: DEFAULT_TIMING,
  }
  const adapters = mergeAdapters(defaults, adapterOverrides)
  const timing = timingOverride ?? adapters.timing
  if (typeof timing?.now !== "function") throw new TypeError("timing.now must be a function")
  if (typeof timing?.sleep !== "function") throw new TypeError("timing.sleep must be a function")
  const abortController = new AbortController()
  const signalScope = installCaptureSignalHandlers({
    signalAdapter,
    abortController,
  })
  let workspaceRoot
  let aimock
  let serverChild
  let workbenchChild
  const managedServices = []
  let browserSession
  let closeBrowserSession
  let browserResult = {}
  let result
  let finalSummary
  let publishedSummaryPath
  let primaryError

  try {
    const toolchain = await adapters.commands.checkToolchain({
      repoRoot,
      signal: signalScope.signal,
    })
    signalScope.signal.throwIfAborted()
    await adapters.commands.build({ repoRoot, signal: signalScope.signal })
    signalScope.signal.throwIfAborted()
    workspaceRoot = await adapters.filesystem.mkdtemp(join(tmpdir(), "b4-brand-demo-"))
    const appRoot = join(workspaceRoot, "my-agent")
    await adapters.commands.scaffold({
      repoRoot,
      appRoot,
      signal: signalScope.signal,
    })
    signalScope.signal.throwIfAborted()
    await adapters.commands.install({
      appRoot,
      signal: signalScope.signal,
    })
    signalScope.signal.throwIfAborted()
    const testResult = await adapters.commands.test({
      appRoot,
      signal: signalScope.signal,
    })
    signalScope.signal.throwIfAborted()
    await Promise.all([
      adapters.filesystem.mkdir(artifactsDir, { recursive: true }),
      adapters.filesystem.mkdir(recordingsDir, { recursive: true }),
    ])
    await Promise.all([
      adapters.filesystem.writeFile(logPaths.stdout, testResult.stdout, "utf8"),
      adapters.filesystem.writeFile(logPaths.stderr, testResult.stderr, "utf8"),
      adapters.filesystem.writeFile(
        logPaths.result,
        `${JSON.stringify({ exitCode: testResult.exitCode }, null, 2)}\n`,
        "utf8",
      ),
    ])
    assertCommandSucceeded(testResult, "generated npm test")
    const rawTestLog = [testResult.stdout, testResult.stderr].filter(Boolean).join("\n")
    if (
      !rawTestLog.includes("splits the first leg into a climb segment and a cruise segment") ||
      !/(?:Tests?\s+.*passed|\d+\s+passed)/i.test(rawTestLog)
    ) {
      throw new Error(
        "Generated npm test output did not contain the named navlog test and passing summary",
      )
    }
    const normalizedTestLog = normalizeLog(rawTestLog, {
      temporaryRoot: workspaceRoot,
    })

    aimock = await adapters.processes.startAimock(DEMO_FIXTURES)
    assertLoopbackModelBaseUrl(aimock.baseUrl)
    const serverEnvironment = buildChildEnvironment(parentEnv, aimock.baseUrl)
    const serverStart = await startWithAssignedPort({
      service: "B4.run server",
      excludedPorts: new Set(DEFAULT_SCAFFOLD_PORTS),
      getPort: adapters.processes.getPort,
      start: (port) =>
        adapters.processes.startB4({
          cwd: join(appRoot, "server"),
          port,
          env: serverEnvironment,
          signal: signalScope.signal,
        }),
    })
    serverChild = serverStart.child
    managedServices.push(serverStart)

    const workbenchEnvironment = {
      ...sanitizeOperationalEnvironment(parentEnv),
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      B4_SERVER_URL: `http://127.0.0.1:${serverStart.port}`,
    }
    const workbenchStart = await startWithAssignedPort({
      service: "Workbench",
      excludedPorts: new Set([...DEFAULT_SCAFFOLD_PORTS, serverStart.port]),
      getPort: adapters.processes.getPort,
      start: (port) =>
        adapters.processes.startWorkbench({
          cwd: join(appRoot, "web"),
          port,
          env: workbenchEnvironment,
          signal: signalScope.signal,
        }),
    })
    workbenchChild = workbenchStart.child
    managedServices.push(workbenchStart)
    const racePhase = (label, action) =>
      raceCapturePhase(label, action, managedServices, signalScope.signal)

    const [primarySource, secondarySource] = await racePhase("read generated source", () =>
      Promise.all([
        adapters.filesystem.readFile(join(appRoot, "server/src/app/navlog/index.ts"), "utf8"),
        adapters.filesystem.readFile(join(appRoot, "server/src/tools/computeNavlog.ts"), "utf8"),
      ]),
    )
    const authorHtml = renderStage({
      act: "author",
      tree: GENERATED_PATHS,
      primarySource,
      secondarySource,
    })
    for (const generatedPath of GENERATED_PATHS) {
      if (!authorHtml.includes(generatedPath)) {
        throw new Error(`Author compositor is missing ${generatedPath}`)
      }
    }
    if (!authorHtml.includes("export default agent({") || !authorHtml.includes("computeNavlog")) {
      throw new Error("Author compositor is missing the canonical B4.run source")
    }
    const testHtml = renderStage({ act: "test", testLog: normalizedTestLog })
    browserSession = await runOwnedAbortablePhase({
      label: "open browser",
      services: managedServices,
      abortController,
      action: () =>
        adapters.browser.open({
          recordingsDir,
          viewport: { ...VIEWPORT },
          signal: signalScope.signal,
        }),
      disposeResult: (lateSession) => lateSession.close(),
    })
    let browserClosePromise
    closeBrowserSession = () => {
      browserClosePromise ??= Promise.resolve().then(() => browserSession.close())
      return browserClosePromise
    }
    const browserPhase = (label, action) =>
      runOwnedAbortablePhase({
        label,
        action,
        services: managedServices,
        abortController,
        onInterrupt: closeBrowserSession,
      })
    const timeline = createVideoTimeline(timing.now)
    await timeline.scene("author", () =>
      browserPhase("record author", () =>
        browserSession.recordStage({
          act: "author",
          html: authorHtml,
          signal: signalScope.signal,
        }),
      ),
    )
    await timeline.scene("test", () =>
      browserPhase("record test", () =>
        browserSession.recordStage({
          act: "test",
          html: testHtml,
          signal: signalScope.signal,
        }),
      ),
    )
    const scenario = await timeline.scene("workbench-run", () =>
      browserPhase("run Workbench scenario", () =>
        browserSession.runScenario({
          url: `http://127.0.0.1:${workbenchStart.port}`,
          prompt: DEMO_PROMPT,
          tools: EXPECTED_TOOLS,
          answer: EXPECTED_ANSWER,
          signal: signalScope.signal,
        }),
      ),
    )
    await timeline.scene("pre-reload-complete", () =>
      browserPhase("hold completed run", () =>
        timing.sleep(holdDurations.preReloadMs, {
          signal: signalScope.signal,
        }),
      ),
    )
    let restoration
    await timeline.scene("restoration", async () => {
      restoration = await browserPhase("restore Workbench thread", () =>
        browserSession.reloadAndRestore({
          workbenchUrl: `http://127.0.0.1:${workbenchStart.port}`,
          threadId: scenario.threadId,
          prompt: DEMO_PROMPT,
          tools: EXPECTED_TOOLS,
          answer: EXPECTED_ANSWER,
          signal: signalScope.signal,
        }),
      )
      await browserPhase("record restored run", () =>
        browserSession.recordRun({ signal: signalScope.signal }),
      )
      await browserPhase("hold restored run", () =>
        timing.sleep(holdDurations.restorationMs, {
          signal: signalScope.signal,
        }),
      )
    })
    await timeline.scene("close", () =>
      browserPhase("record close", () =>
        browserSession.recordStage({
          act: "close",
          html: renderStage({ act: "close" }),
          signal: signalScope.signal,
        }),
      ),
    )
    result = {
      schemaVersion: 1,
      runId,
      status: "captured",
      recordOnly,
      toolchain,
      threadId: scenario.threadId,
      serverPort: serverStart.port,
      workbenchPort: workbenchStart.port,
      ...(restoration?.connectUrl !== undefined ? { connectUrl: restoration.connectUrl } : {}),
      videoTimeline: timeline.manifest(),
    }

    browserResult = await browserPhase("finalize browser recording", () => closeBrowserSession())
    browserSession = undefined
    closeBrowserSession = undefined
    const summary = {
      ...result,
      ...browserResult,
      paths: {
        artifactsRoot: artifactsDir,
        recordingsRoot: recordingsDir,
        logs: logPaths,
        recording: browserResult.videoPath,
      },
      evidence: {
        prompt: DEMO_PROMPT,
        tools: [...EXPECTED_TOOLS],
        answer: EXPECTED_ANSWER,
        threadId: scenario.threadId,
        connectUrl: restoration?.connectUrl,
      },
    }
    const summaryPath = join(artifactsDir, "capture-summary.json")
    const temporarySummaryPath = `${summaryPath}.tmp`
    await racePhase("write capture summary", () =>
      adapters.filesystem.writeFile(
        temporarySummaryPath,
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
      ),
    )
    await racePhase("publish capture summary", () =>
      adapters.filesystem.rename(temporarySummaryPath, summaryPath),
    )
    publishedSummaryPath = summaryPath
    finalSummary = { ...summary, summaryPath }
    if (!recordOnly) {
      if (typeof encodeCaptureArtifacts !== "function") {
        throw new TypeError("encodeCaptureArtifacts must be a function")
      }
      await runOwnedAbortablePhase({
        label: "encode capture artifacts",
        services: managedServices,
        abortController,
        action: () =>
          encodeCaptureArtifacts({
            repoRoot,
            artifactsDir,
            recordingsDir,
            summary,
            summaryPath,
            signal: signalScope.signal,
          }),
      })
    }
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors = []
  if (browserSession !== undefined) {
    await cleanupResource(async () => {
      browserResult = await closeBrowserSession()
    }, cleanupErrors)
  }
  if (workbenchChild !== undefined) {
    await cleanupResource(() => adapters.processes.stop(workbenchChild), cleanupErrors)
  }
  if (serverChild !== undefined) {
    await cleanupResource(() => adapters.processes.stop(serverChild), cleanupErrors)
  }
  if (typeof adapters.processes.stopRemaining === "function") {
    await cleanupResource(() => adapters.processes.stopRemaining(), cleanupErrors)
  }
  if (typeof adapters.commands.stopRemaining === "function") {
    await cleanupResource(() => adapters.commands.stopRemaining(), cleanupErrors)
  }
  if (aimock !== undefined) {
    await cleanupResource(() => aimock.close(), cleanupErrors)
  }
  if (workspaceRoot !== undefined) {
    await cleanupResource(
      () => adapters.filesystem.rm(workspaceRoot, { recursive: true, force: true }),
      cleanupErrors,
    )
  }
  if (
    (primaryError !== undefined || cleanupErrors.length > 0) &&
    publishedSummaryPath !== undefined
  ) {
    await cleanupResource(
      () => adapters.filesystem.rm(publishedSummaryPath, { force: true }),
      cleanupErrors,
    )
  }
  await cleanupResource(() => signalScope.restore(), cleanupErrors)

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        `${errorMessage(primaryError)}; cleanup also failed`,
      )
    }
    throw primaryError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Capture cleanup failed")
  }

  return finalSummary
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  )
}

export function parseCaptureArguments(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("capture arguments must be an array of strings")
  }
  const forwarded = args.filter((arg) => arg !== "--")
  const unknown = forwarded.filter((arg) => arg !== "--record-only")
  if (unknown.length > 0) {
    throw new Error(`Unknown capture argument(s): ${unknown.join(", ")}`)
  }
  return { recordOnly: forwarded.includes("--record-only") }
}

if (isMainModule()) {
  let cliOptions
  try {
    cliOptions = parseCaptureArguments(process.argv.slice(2))
  } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
  if (cliOptions !== undefined) {
    captureDemo(cliOptions).then(
      (summary) => {
        console.log(JSON.stringify(summary, null, 2))
      },
      (error) => {
        console.error(error instanceof Error ? error.stack : error)
        process.exitCode = 1
      },
    )
  }
}

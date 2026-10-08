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
import { startAwcStub as startLoopbackAwcStub } from "./awc-stub.mjs"
import { getAvailableLoopbackPort, spawnManaged, stopManaged, waitForHttp } from "./processes.mjs"
import { assertScenarioCurrent, demoScenario } from "./scenario.mjs"
import { DIRECTOR_FONTS, renderDirector } from "./director.mjs"
import { runEncoderCommand } from "./encode.mjs"
import { beatSceneName, STORYBOARD, storyboardPaths } from "./storyboard.mjs"

const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "../../..")
const DEFAULT_SCAFFOLD_PORTS = new Set([3002, 3010])
const NODE_MINIMUM_MAJOR = 24
const PNPM_VERSION = "10.33.0"
const VIEWPORT = Object.freeze({ width: 1440, height: 810 })
/**
 * The real waits inside an app beat, between its camera moves. Each beat's
 * final hold is its storyboard `holdMs`.
 */
const DEFAULT_HOLD_DURATIONS = Object.freeze({
  // The navlog beat: the route on the map, before the camera moves to the sheet.
  mapMs: 1_500,
  // The filing beat: the approval card, before the capture clicks Allow once.
  approvalMs: 1_800,
  // The reload beat: the suggested memory, before the camera pulls back to reload.
  memoryMs: 1_200,
})
/** The AWC products the scripted run reaches; the capture asserts the stub served each. */
const AWC_ENDPOINTS = Object.freeze(["airport", "metar", "taf", "windtemp", "gairmet", "airsigmet"])
const DIRECTOR_PATH = "/__b4_demo_director/"
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

function createVideoTimeline(now, wallClock = Date.now) {
  if (typeof now !== "function") throw new TypeError("timing.now must be a function")
  const startedAtMonotonicMs = now()
  // The same instant on the wall clock, the clock the screencast stamps its
  // frames with: the bridge from scene times to video time.
  const startedAtEpochMs = wallClock()
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
        startedAtEpochMs,
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
  return assertLoopbackHttpUrl(value, "model base URL")
}

/** The AWC stub's base: the server's weather tools must never leave the machine. */
export function assertLoopbackAwcBaseUrl(value) {
  return assertLoopbackHttpUrl(value, "AWC base URL")
}

function assertLoopbackHttpUrl(value, label) {
  requireString(value, label)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${label} must be a loopback HTTP(S) URL`)
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
    throw new TypeError(`${label} must be a loopback HTTP(S) URL`)
  }
  return url
}

/**
 * The B4.run server's environment: the operational allowlist, the model at
 * aimock, and, when given, the weather tools at the loopback AWC stub
 * (`B4_AWC_BASE_URL`, read by the template's `lib/awc.ts`).
 */
export function buildChildEnvironment(parentEnvironment, modelBaseUrl, { awcBaseUrl } = {}) {
  const url = assertLoopbackModelBaseUrl(modelBaseUrl)
  const awc = awcBaseUrl === undefined ? undefined : assertLoopbackAwcBaseUrl(awcBaseUrl)
  return {
    ...sanitizeOperationalEnvironment(parentEnvironment),
    // `npm exec -- b4 ...` otherwise resolves the unrelated registry package
    // when dependencies were laid out by pnpm instead of npm.
    npm_config_package: "@b4run/cli",
    OPENAI_BASE_URL: url.href,
    OPENAI_API_KEY: "test-not-used",
    ...(awc !== undefined ? { B4_AWC_BASE_URL: awc.href.replace(/\/$/, "") } : {}),
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
    startAwcStub({ now }) {
      return startLoopbackAwcStub({ now })
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

/**
 * Waits for the run to end. Without `turns`, the latest root turn settling is
 * the proof. With `turns` (the thread's turn count once this run is done), the
 * proof is that many settled turns and no other: in a thread that already has
 * a settled turn, "the last settled turn" is visible before the new run has
 * even rendered, and a turn parked on an approval is not settled.
 */
export async function waitForWorkbenchRunCompletion(page, { turns } = {}) {
  // The run's own turn settling is the proof the run ended. Stop and Send are
  // one button, so without this a wait that starts before the run renders its
  // Stop state would pass on the idle composer the click left behind.
  const main = page.getByRole("main")
  const settled = main.locator(SETTLED_ROOT_TURN_SELECTOR)
  await (turns === undefined ? settled.last() : settled.nth(turns - 1)).waitFor({
    state: "visible",
    timeout: 120_000,
  })
  if (turns !== undefined) {
    const count = await main.locator(ROOT_TURN_SELECTOR).count()
    if (count !== turns) {
      throw new Error(`The thread rendered ${count} turns once the run settled, expected ${turns}`)
    }
  }
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
  return expandTurn(page.getByRole("main").locator(SETTLED_ROOT_TURN_SELECTOR).last(), {
    timeout,
    name: "The latest turn",
  })
}

async function expandTurn(turn, { timeout = 120_000, name }) {
  await turn.waitFor({ state: "visible", timeout })
  const summary = turn.locator(":scope > button.b4-turn__summary")
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.click({ timeout })
  }
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    throw new Error(`${name}'s summary did not expand (aria-expanded stayed false)`)
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
 * The root tool steps the activity kit draws for a turn's tool calls, in
 * order: `writeTodos` is the plan step and `task` a subagent step, not tool
 * steps, and a run of the same tool called back to back folds into one group
 * step (`data-kind="group"`), which is not a tool step either.
 */
export function expectedRootToolSteps(tools) {
  const steps = []
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index]
    let end = index
    while (tools[end + 1] === tool) end += 1
    if (end === index && tool !== "writeTodos" && tool !== "task") steps.push(tool)
    index = end
  }
  return steps
}

/**
 * The approval card for a gated call, with its evidence: `Allow once` and
 * `Deny`, and no `Always allow` (the route gates `fileFlightPlan` with
 * `allowAlways: false`). Returns the card, scrolled into view.
 */
export async function awaitApprovalCard(page, { timeout = 120_000 } = {}) {
  const card = page.getByRole("main").locator('.b4-approval[role="alert"]')
  await card.waitFor({ state: "visible", timeout })
  const count = await card.count()
  if (count !== 1) throw new Error(`The Workbench rendered ${count} approval cards, expected 1`)
  for (const name of ["Allow once", "Deny"]) {
    const buttons = await card.getByRole("button", { name, exact: true }).count()
    if (buttons !== 1) {
      throw new Error(`The approval card has ${buttons} "${name}" buttons, expected 1`)
    }
  }
  const always = await card.getByRole("button", { name: "Always allow", exact: true }).count()
  if (always !== 0) {
    throw new Error(
      `The approval card offers "Always allow"; the route gates this call with allowAlways: false`,
    )
  }
  await centerInScroller(card)
  await settleWorkbenchViewport(page)
  return card
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

/**
 * Reloads the Workbench, reselects the thread and proves it came back: its
 * title, its turns, each turn's root tool steps and each turn's answer. A
 * one-turn thread passes `prompt`, `tools` and `answer`; a longer one passes
 * `turns`, one `{ prompt, tools, answer }` per turn in order, with `prompt`
 * still the first message (the thread's title). `tools` are the root tool
 * steps the turn renders (see `expectedRootToolSteps`).
 */
export async function restoreWorkbenchThread(page, options) {
  const { workbenchUrl, threadId, prompt } = options
  const expected = options.turns ?? [
    { prompt: options.prompt, tools: options.tools, answer: options.answer },
  ]
  if (expected.length === 0) throw new Error("restoreWorkbenchThread needs at least one turn")
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
  for (const turn of expected) {
    await main.getByText(turn.prompt, { exact: true }).last().waitFor(visible)
  }
  const turns = main.locator(SETTLED_ROOT_TURN_SELECTOR)
  await (expected.length === 1 ? turns.first() : turns.nth(expected.length - 1)).waitFor(visible)
  const turnCount = await main.locator(ROOT_TURN_SELECTOR).count()
  if (turnCount !== expected.length) {
    throw new Error(
      `The restored thread rendered ${turnCount} turns, expected exactly ${expected.length}`,
    )
  }
  for (const [index, { tools, answer }] of expected.entries()) {
    const label = expected.length === 1 ? "The restored turn" : `Restored turn ${index + 1}`
    // A restored turn starts folded; its steps are in the DOM only once opened.
    const turn =
      expected.length === 1
        ? await expandLatestTurn(page)
        : await expandTurn(turns.nth(index), { name: label })
    const steps = rootToolSteps(turn)
    if (tools.length > 0) await steps.first().waitFor(visible)
    const stepCount = await steps.count()
    if (stepCount !== tools.length) {
      throw new Error(
        `${label} rendered ${stepCount} tool steps, expected ${tools.length} (${tools.join(", ")})`,
      )
    }
    await main.getByText(answer, { exact: true }).last().waitFor(visible)
  }
  return { connectUrl: response.url() }
}

const VISIBLE = Object.freeze({ state: "visible", timeout: 120_000 })

/** The active thread's id, from the Workbench's thread list, by its title. */
async function readThreadId(page, title) {
  const threadId = await page.evaluate((wanted) => {
    const raw = localStorage.getItem("b4.workbench.threads")
    const threads = raw === null ? [] : JSON.parse(raw)
    const thread = threads.find((entry) => entry?.title === wanted)
    return typeof thread?.id === "string" ? thread.id : undefined
  }, title)
  if (threadId === undefined) throw new Error("Workbench did not persist the active thread id")
  return threadId
}

/**
 * Sends the pre-filled planning prompt and proves turn 1: the plan's first
 * to-do while the run works, then the settled turn's root tool steps and its
 * answer. A settled turn folds its activity, and the scripted run settles in
 * well under a second, so the plan step is opened again (a real click on its
 * line) and scrolled to the middle of the transcript: the beat holds on the
 * plan's to-dos.
 */
export async function sendPlanTurn(page, { prompt, todos, tools, answer }) {
  if (!Array.isArray(todos) || todos.length === 0) throw new Error("sendPlanTurn needs the to-dos")
  const main = page.getByRole("main")
  await page.getByRole("button", { name: "Send", exact: true }).click({ timeout: 60_000 })
  const plan = main.getByRole("list", { name: "Plan", exact: true })
  await plan.getByText(todos[0].content, { exact: true }).first().waitFor(VISIBLE)
  await waitForWorkbenchRunCompletion(page, { turns: 1 })
  const turn = await expandLatestTurn(page)
  const expectedSteps = expectedRootToolSteps(tools)
  const steps = rootToolSteps(turn)
  await steps.first().waitFor(VISIBLE)
  const stepCount = await steps.count()
  if (stepCount !== expectedSteps.length) {
    throw new Error(
      `The plan turn rendered ${stepCount} tool steps, expected ${expectedSteps.length} (${expectedSteps.join(", ")})`,
    )
  }
  await main.getByText(answer, { exact: true }).last().waitFor(VISIBLE)
  const line = turn.locator(
    ':scope > ol.b4-turn__steps > li.b4-step[data-kind="plan"] > button.b4-step__line',
  )
  if ((await line.getAttribute("aria-expanded")) !== "true") await line.click({ timeout: 60_000 })
  for (const todo of todos) {
    await plan.getByText(todo.content, { exact: true }).first().waitFor(VISIBLE)
  }
  // Centred in the transcript, the way a reader scrolls to it, so the to-dos
  // sit inside the `todos` framing rather than at the transcript's edge.
  await centerInScroller(plan.first())
  await settleWorkbenchViewport(page)
  return { threadId: await readThreadId(page, prompt) }
}

/**
 * Scrolls `locator` to the middle of its nearest scrolling ancestor (the
 * transcript) and nothing else. `scrollIntoView` would also scroll the
 * Workbench's `overflow: hidden` root, pushing the weather strip and the dock
 * header out of the top of the page, which no reader's scroll can do.
 */
export async function centerInScroller(locator) {
  await locator.evaluate((element) => {
    let scroller = element.parentElement
    while (scroller !== null) {
      const { overflowY } = getComputedStyle(scroller)
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        scroller.scrollHeight > scroller.clientHeight
      ) {
        break
      }
      scroller = scroller.parentElement
    }
    if (scroller === null) return
    const box = element.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    scroller.scrollTop += box.top - view.top - Math.max(0, (view.height - box.height) / 2)
  })
}

/**
 * Puts the Workbench page back at its own origin: the document and the
 * `overflow: hidden` layout root unscrolled, as a reader always sees them.
 * Playwright's actionability scrolling (and any `scrollIntoView`) can scroll
 * them; this undoes only that, never the transcript's own scroll.
 */
export async function settleWorkbenchViewport(page) {
  await page.evaluate(() => {
    for (const element of [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...document.querySelectorAll(".wb-root"),
    ]) {
      if (element === null || element === undefined) continue
      element.scrollTop = 0
      element.scrollLeft = 0
    }
  })
}

/** The weather strip's verdict pill and the verdict card both say `verdict`. */
export async function assertWeatherVerdict(page, { verdict }) {
  await page
    .getByRole("region", { name: "Weather", exact: true })
    .getByText(verdict, { exact: true })
    .first()
    .waitFor(VISIBLE)
  await page
    .getByRole("region", { name: "Go/no-go verdict", exact: true })
    .getByText(verdict, { exact: true })
    .first()
    .waitFor(VISIBLE)
}

/** The navlog sheet shows the computed total distance. */
export async function assertNavlogSheet(page, { distanceNm }) {
  await page
    .getByRole("region", { name: "Navlog", exact: true })
    .getByText(`${distanceNm} nm`, { exact: true })
    .first()
    .waitFor(VISIBLE)
}

/** The route is on the map: both airports' markers and the leg's heading label. */
export async function assertRouteMap(page, { headingLabel, airports }) {
  const map = page.getByRole("region", { name: "Route map", exact: true })
  await map.getByText(headingLabel, { exact: true }).first().waitFor(VISIBLE)
  for (const airport of airports) await map.getByText(airport).first().waitFor(VISIBLE)
}

/**
 * The memory panel lists the suggested candidate, centred in the transcript
 * so the `memory` framing holds all of it: the fact, "Suggested by the
 * planner", and Approve and Delete.
 */
export async function assertMemoryCandidate(page, { content }) {
  const panel = page.getByRole("region", { name: "Memory candidates", exact: true })
  await panel.getByText(content, { exact: true }).first().waitFor(VISIBLE)
  await centerInScroller(panel.first())
  await settleWorkbenchViewport(page)
}

/**
 * Answers the open approval with `Allow once`, then proves the resumed run:
 * the card leaves, the thread settles at `turns` turns and the reply shows.
 */
export async function allowOnceAndSettle(page, { turns, reply }) {
  const card = await awaitApprovalCard(page)
  await card.getByRole("button", { name: "Allow once", exact: true }).click({ timeout: 60_000 })
  await card.waitFor({ state: "hidden", timeout: 120_000 })
  await waitForWorkbenchRunCompletion(page, { turns })
  await page.getByRole("main").getByText(reply, { exact: true }).last().waitFor(VISIBLE)
  await settleWorkbenchViewport(page)
}

/** Fails unless the AWC stub answered every product the scripted run reaches. */
export function assertAwcStubServed(hits) {
  const missed = AWC_ENDPOINTS.filter((endpoint) => !(hits?.[endpoint] >= 1))
  if (missed.length > 0) {
    throw new Error(
      `The AWC stub never served /${missed.join(", /")}: the weather tools did not reach it`,
    )
  }
}

/**
 * A page-shaped view of the Workbench iframe, so `openReadyWorkbench`,
 * `fillActiveWorkbenchComposer`, `waitForWorkbenchRunCompletion`,
 * `expandLatestTurn` and `restoreWorkbenchThread` drive the real Workbench
 * inside the director page unchanged. DOM calls go to the frame; response
 * waits go to the page, which sees the frame's requests; a reload is a fresh
 * navigation of the frame to its own URL, as a browser reload would be.
 */
export function frameSurface(page, frame) {
  const goto = async (url, options) => {
    let response
    try {
      response = await frame.goto(url, options)
    } catch (error) {
      throw new Error(`The Workbench did not load inside the director frame (${error.message})`, {
        cause: error,
      })
    }
    const loaded = frame.url()
    if (loaded.startsWith("chrome-error:")) {
      throw new Error(`The Workbench did not load inside the director frame (${loaded})`)
    }
    return response
  }
  return {
    getByRole: (...args) => frame.getByRole(...args),
    locator: (...args) => frame.locator(...args),
    evaluate: (...args) => frame.evaluate(...args),
    waitForTimeout: (ms) => frame.waitForTimeout(ms),
    waitForResponse: (...args) => page.waitForResponse(...args),
    goto,
    reload: async (options) => {
      // A null response is a same-document navigation (e.g. a URL with a
      // hash): nothing reloaded, so the restoration would prove nothing.
      const response = await goto(frame.url(), options)
      if (response === null) {
        throw new Error("The Workbench frame did not reload (same-document navigation)")
      }
      return response
    },
  }
}

/**
 * The recorder: a Chromium DevTools screencast at twice the CSS resolution,
 * one lossless frame per paint. Playwright's recordVideo is VP8 at about
 * 0.9 Mbit/s and 25 fps, which leaves code text soft; these frames are the
 * compositor's own pixels, and the encoder supersamples them down to 1440x810.
 */
export const SCREENCAST_SCALE = 2
export const SCREENCAST_OPTIONS = Object.freeze({
  format: "png",
  maxWidth: 1440 * SCREENCAST_SCALE,
  maxHeight: 810 * SCREENCAST_SCALE,
  everyNthFrame: 1,
})
const SCREENCAST_FRAMES_DIR = "screencast-frames"
const SCREENCAST_VIDEO = "screencast.mp4"
const SCREENCAST_FPS = 30

/**
 * Writes every `Page.screencastFrame` to `framesDir` with its timestamp (wall
 * clock seconds) and acknowledges it, which is what lets Chromium send the
 * next. Frames arrive only when the page paints, so a hold is the gap between
 * two timestamps. `stop()` stops the screencast, waits for every write, and
 * returns the frames in order with the wall-clock time it stopped.
 */
export function createScreencastRecorder({
  session,
  framesDir,
  options = SCREENCAST_OPTIONS,
  writeFile = nodeWriteFile,
  mkdir = nodeMkdir,
  wallClock = Date.now,
}) {
  const frames = []
  const pending = new Set()
  const errors = []
  const extension = options.format === "jpeg" ? "jpg" : "png"
  let stopping
  const onFrame = ({ data, metadata, sessionId }) => {
    if (stopping !== undefined) return
    const timestamp = metadata?.timestamp
    if (!Number.isFinite(timestamp)) {
      errors.push(new Error("A screencast frame arrived without a timestamp"))
    }
    const file = `frame-${String(frames.length).padStart(6, "0")}.${extension}`
    frames.push({ file, timestamp })
    const write = Promise.resolve()
      .then(() => writeFile(join(framesDir, file), Buffer.from(data, "base64")))
      .catch((error) => {
        errors.push(error)
      })
    pending.add(write)
    write.finally(() => pending.delete(write))
    // Acknowledge at once: Chromium sends the next frame only after this. A
    // failed ack (the session closing) only ends the stream.
    try {
      Promise.resolve(session.send("Page.screencastFrameAck", { sessionId })).catch(() => {})
    } catch {}
  }
  return {
    async start() {
      await mkdir(framesDir, { recursive: true })
      session.on("Page.screencastFrame", onFrame)
      await session.send("Page.startScreencast", { ...options })
    },
    stop() {
      stopping ??= (async () => {
        try {
          await session.send("Page.stopScreencast")
        } catch (error) {
          errors.push(error)
        }
        session.off("Page.screencastFrame", onFrame)
        const stoppedAtEpochMs = wallClock()
        await Promise.all([...pending])
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            `The screencast failed: ${errors.map(errorMessage).join("; ")}`,
          )
        }
        return { frames: [...frames], stoppedAtEpochMs }
      })()
      return stopping
    },
  }
}

/**
 * The ffconcat list for the frames: each frame lasts until the next one's
 * timestamp, and the last until `endEpochMs` (at least one output frame).
 * A frame with the same timestamp as the next is dropped. Times are seconds.
 */
export function screencastConcat(frames, endEpochMs) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("The screencast recorded no frames")
  }
  for (const [index, frame] of frames.entries()) {
    if (!Number.isFinite(frame.timestamp)) {
      throw new Error(`Screencast frame ${index} has no timestamp`)
    }
    if (index > 0 && frame.timestamp < frames[index - 1].timestamp) {
      throw new Error(`Screencast frame ${index} is earlier than the frame before it`)
    }
    if (!/^[A-Za-z0-9._-]+$/u.test(frame.file)) {
      throw new Error(`Screencast frame ${index} has an unsafe file name`)
    }
  }
  if (!Number.isFinite(endEpochMs)) throw new Error("The screencast end time is not a number")
  const lines = ["ffconcat version 1.0"]
  for (const [index, frame] of frames.entries()) {
    const last = index === frames.length - 1
    const next = last ? endEpochMs / 1_000 : frames[index + 1].timestamp
    const duration = last ? Math.max(1 / SCREENCAST_FPS, next - frame.timestamp) : next - frame.timestamp
    if (duration <= 0) continue
    lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(6)}`)
  }
  // The concat demuxer honours the last entry's duration only when a file follows it.
  lines.push(`file '${frames.at(-1).file}'`)
  return `${lines.join("\n")}\n`
}

/**
 * Turns the frames into the run's raw video: the concat demuxer gives each
 * frame its real duration, `fps=30` resamples them to a constant 30 fps, and
 * near-lossless 4:4:4 H.264 keeps the 2x pixels for the encoder to downscale.
 * The frames directory is removed whatever happens. Video time 0 is the first
 * frame's timestamp, returned as `firstFrameEpochMs`.
 */
export async function assembleScreencastVideo({
  framesDir,
  frames,
  endEpochMs,
  outputPath,
  signal,
  run = runEncoderCommand,
  writeFile = nodeWriteFile,
  remove = (path) => nodeRm(path, { recursive: true, force: true }),
}) {
  const listPath = join(framesDir, "frames.ffconcat")
  try {
    signal?.throwIfAborted()
    await writeFile(listPath, screencastConcat(frames, endEpochMs), "utf8")
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-vf",
        `fps=${SCREENCAST_FPS},format=yuv444p`,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "8",
        outputPath,
      ],
      { signal },
    )
  } finally {
    await remove(framesDir)
  }
  return {
    videoPath: outputPath,
    screencast: {
      format: SCREENCAST_OPTIONS.format,
      scale: SCREENCAST_SCALE,
      frameCount: frames.length,
      firstFrameEpochMs: frames[0].timestamp * 1_000,
      endEpochMs,
    },
  }
}

/**
 * Stops the screencast, closes the DevTools session, the context and
 * Chromium, in that order, then either assembles the raw video (`finalize`)
 * or just removes the frames (a failed or cancelled run).
 */
export async function closeBrowserResources({
  context,
  browser,
  session,
  recorder,
  framesDir,
  outputPath,
  finalize = false,
  signal,
  assemble = assembleScreencastVideo,
  remove = (path) => nodeRm(path, { recursive: true, force: true }),
}) {
  const errors = []
  let recording
  for (const step of [
    async () => {
      recording = await recorder.stop()
    },
    () => session.detach(),
    () => context.close(),
    () => browser.close(),
  ]) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0 || !finalize) {
    try {
      await remove(framesDir)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Browser cleanup failed: ${errors.map(errorMessage).join("; ")}`,
    )
  }
  if (!finalize) return {}
  return assemble({
    framesDir,
    frames: recording.frames,
    endEpochMs: recording.stoppedAtEpochMs,
    outputPath,
    signal,
  })
}

// The Workbench runs under `next dev`, whose dev-tools badge is not part of the
// product. Hiding it in the capture browser leaves the scaffolded next.config
// (and every user's dev tools) untouched.
export const HIDE_NEXT_DEV_INDICATOR = `document.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style")
  style.textContent = "nextjs-portal { display: none !important; }"
  document.head.append(style)
})`

export async function createBrowserResources({
  chromium,
  recordingsDir,
  viewport,
  signal,
  createRecorder = createScreencastRecorder,
  remove = (path) => nodeRm(path, { recursive: true, force: true }),
}) {
  const framesDir = join(recordingsDir, SCREENCAST_FRAMES_DIR)
  let browser
  let context
  let page
  let session
  let recorder
  try {
    signal?.throwIfAborted()
    // Headless Chromium screencasts at CSS size unless the device scale is
    // forced for the whole browser; the context's deviceScaleFactor alone
    // still sends 1x frames.
    browser = await chromium.launch({
      headless: true,
      args: [`--force-device-scale-factor=${SCREENCAST_SCALE}`],
    })
    signal?.throwIfAborted()
    context = await browser.newContext({
      viewport,
      deviceScaleFactor: SCREENCAST_SCALE,
      // The navlog map animates its zoom to the route unless motion is reduced;
      // the animation adds no evidence and spends the video byte budget on motion.
      reducedMotion: "reduce",
    })
    signal?.throwIfAborted()
    await context.addInitScript(HIDE_NEXT_DEV_INDICATOR)
    signal?.throwIfAborted()
    page = await context.newPage()
    signal?.throwIfAborted()
    session = await context.newCDPSession(page)
    signal?.throwIfAborted()
    recorder = createRecorder({ session, framesDir })
    await recorder.start()
    signal?.throwIfAborted()
    return {
      browser,
      context,
      page,
      session,
      recorder,
      framesDir,
      outputPath: join(recordingsDir, SCREENCAST_VIDEO),
    }
  } catch (error) {
    const cleanupErrors = []
    for (const cleanup of [
      recorder === undefined ? undefined : () => recorder.stop(),
      session === undefined ? undefined : () => session.detach(),
      page === undefined ? undefined : () => page.close(),
      context === undefined ? undefined : () => context.close(),
      browser === undefined ? undefined : () => browser.close(),
      recorder === undefined ? undefined : () => remove(framesDir),
    ]) {
      if (cleanup === undefined) continue
      try {
        await cleanup()
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
      const resources = await createBrowserResources({
        chromium,
        recordingsDir,
        viewport,
        signal,
      })
      const { page } = resources
      let closePromise
      // The first close decides: a finalizing close assembles the video; any
      // other (a failure or a cancellation) only removes the frames.
      const close = ({ finalize = false, signal: closeSignal } = {}) => {
        closePromise ??= closeBrowserResources({ ...resources, finalize, signal: closeSignal })
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
      let surface
      const workbench = () => {
        if (surface === undefined) {
          const frame = page.frame({ name: "workbench" })
          if (frame === null) throw new Error("The director page has no workbench frame")
          surface = frameSurface(page, frame)
        }
        return surface
      }
      return {
        async openDirector({ origin, html, fonts, signal: operationSignal }) {
          return runSessionOperation(operationSignal, async () => {
            await page.route(`${origin}${DIRECTOR_PATH}**`, (route) => {
              const { pathname } = new URL(route.request().url())
              if (pathname === DIRECTOR_PATH) {
                return route.fulfill({
                  status: 200,
                  contentType: "text/html; charset=utf-8",
                  body: html,
                })
              }
              const font = fonts[pathname.slice(`${DIRECTOR_PATH}fonts/`.length)]
              if (pathname.startsWith(`${DIRECTOR_PATH}fonts/`) && font !== undefined) {
                return route.fulfill({ status: 200, contentType: "font/ttf", body: font })
              }
              return route.fulfill({ status: 404, body: "" })
            })
            await page.goto(`${origin}${DIRECTOR_PATH}`, { waitUntil: "load" })
            await page.waitForFunction(() => window.director?.ready === true, undefined, {
              timeout: 30_000,
            })
            await page.evaluate(() => document.fonts.ready.then(() => undefined))
          })
        },
        async prepareWorkbench({ url, prompt, signal: operationSignal }) {
          return runSessionOperation(operationSignal, async () => {
            await openReadyWorkbench(workbench(), url)
            await fillActiveWorkbenchComposer(workbench(), prompt)
            await page.evaluate(() => window.director.reset())
          })
        },
        async play({ beat, signal: operationSignal }) {
          return runSessionOperation(operationSignal, () =>
            page.evaluate((name) => window.director.play(name), beat),
          )
        },
        async focus({ target, signal: operationSignal }) {
          return runSessionOperation(operationSignal, () =>
            page.evaluate((name) => window.director.focus(name), target),
          )
        },
        async sendPlan({ prompt, todos, tools, answer, signal: operationSignal }) {
          return runSessionOperation(operationSignal, () =>
            sendPlanTurn(workbench(), { prompt, todos, tools, answer }),
          )
        },
        async showWeather({ verdict, signal: operationSignal }) {
          return runSessionOperation(operationSignal, () =>
            assertWeatherVerdict(workbench(), { verdict }),
          )
        },
        async showNavlog({ distanceNm, headingLabel, airports, signal: operationSignal }) {
          return runSessionOperation(operationSignal, async () => {
            const frame = workbench()
            await assertNavlogSheet(frame, { distanceNm })
            await assertRouteMap(frame, { headingLabel, airports })
          })
        },
        async requestFiling({ prompt, signal: operationSignal }) {
          return runSessionOperation(operationSignal, async () => {
            const frame = workbench()
            await frame.getByRole("textbox", { name: "Message" }).fill(prompt, { timeout: 60_000 })
            await frame.getByRole("button", { name: "Send", exact: true }).click({ timeout: 60_000 })
            await awaitApprovalCard(frame)
          })
        },
        async allowOnce({ turns, reply, signal: operationSignal }) {
          return runSessionOperation(operationSignal, () =>
            allowOnceAndSettle(workbench(), { turns, reply }),
          )
        },
        async showMemory({ content, signal: operationSignal }) {
          return runSessionOperation(operationSignal, () =>
            assertMemoryCandidate(workbench(), { content }),
          )
        },
        async reloadAndRestore({
          workbenchUrl,
          threadId,
          prompt,
          turns,
          distanceNm,
          signal: operationSignal,
        }) {
          return runSessionOperation(operationSignal, async () => {
            const frame = workbench()
            const restored = await restoreWorkbenchThread(frame, {
              workbenchUrl,
              threadId,
              prompt,
              turns,
            })
            await assertNavlogSheet(frame, { distanceNm })
            return restored
          })
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
  wallClock = Date.now,
} = {}) {
  requireString(repoRoot, "repoRoot")
  if (typeof runIdFactory !== "function") throw new TypeError("runIdFactory must be a function")
  if (typeof wallClock !== "function") throw new TypeError("wallClock must be a function")
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
  let awcStub
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

    // One clock reading builds the scenario, and the same reading drives the
    // AWC stub: the scripted briefs quote the times the stub serves.
    const scenario = demoScenario({ now: wallClock() })
    aimock = await adapters.processes.startAimock(scenario.fixtures)
    assertLoopbackModelBaseUrl(aimock.baseUrl)
    awcStub = await adapters.processes.startAwcStub({ now: scenario.now })
    assertLoopbackAwcBaseUrl(awcStub.baseUrl)
    const serverEnvironment = buildChildEnvironment(parentEnv, aimock.baseUrl, {
      awcBaseUrl: awcStub.baseUrl,
    })
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

    const sourcePaths = storyboardPaths()
    const directorInputs = await racePhase("read director inputs", () =>
      Promise.all([
        ...sourcePaths.map((path) => adapters.filesystem.readFile(join(appRoot, path), "utf8")),
        ...Object.values(DIRECTOR_FONTS).map((path) =>
          adapters.filesystem.readFile(join(repoRoot, path)),
        ),
      ]),
    )
    const fontBytes = directorInputs.slice(sourcePaths.length)
    const directorHtml = renderDirector({
      files: Object.fromEntries(sourcePaths.map((path, index) => [path, directorInputs[index]])),
    })
    const directorFonts = Object.fromEntries(
      Object.keys(DIRECTOR_FONTS).map((name, index) => [name, fontBytes[index]]),
    )
    const workbenchUrl = `http://127.0.0.1:${workbenchStart.port}`
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
    closeBrowserSession = (options) => {
      browserClosePromise ??= Promise.resolve().then(() => browserSession.close(options))
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
    // The recording starts with the page; the timeline starts here, so the
    // director's load and the Workbench's warm-up fall before the first beat
    // and the encoder trims them off.
    const timeline = createVideoTimeline(timing.now, wallClock)
    await browserPhase("open director", () =>
      browserSession.openDirector({
        origin: workbenchUrl,
        html: directorHtml,
        fonts: directorFonts,
        signal: signalScope.signal,
      }),
    )
    await browserPhase("prepare Workbench", () =>
      browserSession.prepareWorkbench({
        url: workbenchUrl,
        prompt: scenario.prompt,
        signal: signalScope.signal,
      }),
    )
    const signal = signalScope.signal
    const play = (beat) =>
      browserPhase(`play ${beat}`, () => browserSession.play({ beat, signal }))
    const focus = (target) =>
      browserPhase(`focus ${target}`, () => browserSession.focus({ target, signal }))
    const hold = (label, durationMs) =>
      browserPhase(`hold ${label}`, () => timing.sleep(durationMs, { signal }))
    const cruise = scenario.navlog.legs.at(-1)
    const restoredTurns = [
      {
        prompt: scenario.prompt,
        tools: expectedRootToolSteps(scenario.planTools),
        answer: scenario.planAnswer,
      },
      {
        prompt: scenario.filePrompt,
        tools: expectedRootToolSteps(scenario.fileTools),
        answer: scenario.filedAnswer,
      },
    ]
    let threadId
    let restoration
    // Each app beat's real interaction in the Workbench, with its evidence.
    // The director has already eased the camera to the beat's preset; the
    // action may move it again, and the beat then holds for its holdMs.
    const actions = {
      async "send-plan"() {
        // The live resolveDeparture must still resolve "1400Z" to the
        // scripted instant, or every scripted date is a day off.
        assertScenarioCurrent(scenario, wallClock())
        const ran = await browserPhase("send the plan", () =>
          browserSession.sendPlan({
            prompt: scenario.prompt,
            todos: scenario.todos,
            tools: scenario.planTools,
            answer: scenario.planAnswer,
            signal,
          }),
        )
        threadId = ran.threadId
        await focus("todos")
      },
      async weather() {
        await browserPhase("weather evidence", () =>
          browserSession.showWeather({ verdict: "GO", signal }),
        )
        assertAwcStubServed(awcStub.hits)
      },
      async navlog() {
        await browserPhase("navlog evidence", () =>
          browserSession.showNavlog({
            distanceNm: scenario.navlog.totals.distanceNm,
            headingLabel: `MH ${cruise.magneticHeading}°`,
            airports: ["KSTP", "KRST"],
            signal,
          }),
        )
        await hold("route on the map", holdDurations.mapMs)
        await focus("sheet")
      },
      async "file-approve"() {
        // The approval framing holds the bottom of the dock: the composer,
        // its Send button and, once it opens, the card above them. Every
        // click lands on screen without moving the camera.
        await browserPhase("request filing", () =>
          browserSession.requestFiling({ prompt: scenario.filePrompt, signal }),
        )
        await hold("approval card", holdDurations.approvalMs)
        await browserPhase("allow once", () =>
          browserSession.allowOnce({ turns: 2, reply: scenario.filedAnswer, signal }),
        )
      },
      async "memory-reload"() {
        await browserPhase("memory evidence", () =>
          browserSession.showMemory({ content: scenario.memory.content, signal }),
        )
        await hold("suggested memory", holdDurations.memoryMs)
        await focus("rest")
        restoration = await browserPhase("restore Workbench thread", () =>
          browserSession.reloadAndRestore({
            workbenchUrl,
            threadId,
            prompt: scenario.prompt,
            turns: restoredTurns,
            distanceNm: scenario.navlog.totals.distanceNm,
            signal,
          }),
        )
        await focus("sheet")
      },
    }
    for (const [index, beat] of STORYBOARD.entries()) {
      await timeline.scene(beatSceneName(index, beat), async () => {
        try {
          await play(index)
          if (beat.kind !== "app") return
          const action = actions[beat.action]
          if (action === undefined) throw new Error(`no capture action ${beat.action}`)
          await action()
          await hold(beat.id, beat.holdMs)
        } catch (error) {
          // A failure or a cancellation names the beat it stopped; the
          // original error is its cause.
          throw new Error(`Beat ${index} (${beat.id}): ${errorMessage(error)}`, { cause: error })
        }
      })
    }
    result = {
      schemaVersion: 1,
      runId,
      status: "captured",
      recordOnly,
      toolchain,
      threadId,
      serverPort: serverStart.port,
      workbenchPort: workbenchStart.port,
      ...(restoration?.connectUrl !== undefined ? { connectUrl: restoration.connectUrl } : {}),
      videoTimeline: timeline.manifest(),
    }

    browserResult = await browserPhase("finalize browser recording", () =>
      closeBrowserSession({ finalize: true, signal: signalScope.signal }),
    )
    const screencast = browserResult.screencast
    if (!Number.isFinite(screencast?.firstFrameEpochMs)) {
      throw new Error("The browser recording reported no screencast timing")
    }
    // Video time 0 is the first frame; scene time 0 is the timeline's start.
    // Both are on the wall clock, so a scene at t plays at t + videoOffsetMs.
    result.videoTimeline = {
      ...result.videoTimeline,
      videoOffsetMs: result.videoTimeline.startedAtEpochMs - screencast.firstFrameEpochMs,
    }
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
        scenarioNow: scenario.now,
        departureUtc: scenario.departureUtc,
        prompt: scenario.prompt,
        filePrompt: scenario.filePrompt,
        planTools: [...scenario.planTools],
        fileTools: [...scenario.fileTools],
        planAnswer: scenario.planAnswer,
        filedAnswer: scenario.filedAnswer,
        awcHits: { ...awcStub.hits },
        threadId,
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
  if (awcStub !== undefined) {
    await cleanupResource(() => awcStub.close(), cleanupErrors)
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

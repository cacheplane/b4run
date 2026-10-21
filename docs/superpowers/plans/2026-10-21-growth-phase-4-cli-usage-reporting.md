# Growth Phase 4: CLI Usage Reporting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for progress.

**Goal:** The `b4` CLI reports two anonymous events for development-time commands, behind a first-run notice and an opt-out, to a credential-free website endpoint that does not exist yet.

**Architecture:** `packages/cli/src/lib/signals/` holds five small modules: the reporting decision (`env.ts`), the identity file (`usage-id.ts`), event shaping (`events.ts`), the transport (`transport.ts`), and the emitter that composes them (`emitter.ts`). `run()` in `packages/cli/src/index.ts` wraps command dispatch with the emitter: a commander `preAction` hook captures the dispatched command's name, the result of `parseAsync` becomes the outcome, and `flush()` bounds the send by the transport timeout. The dev first-run signal crosses the dev child boundary as one new IPC message: the AG-UI handler in the child calls a module-local notifier, the `__dev-child` command forwards it over `process.send`, and the parent `b4 dev` process emits at most once. `scripts/posthog/` gains the two `cli:` events and the third dashboard so the taxonomy test and the daily quality check cover them from day one.

**Tech Stack:** Node 24 (`fetch`, `AbortController`, `crypto.randomUUID`), commander 15 hooks, vitest, zod-validated PostHog JSON definitions.

**Spec:** `docs/superpowers/specs/2026-10-20-growth-lifecycle-design.md` — sections "Surfaces that emit signals" (CLI rows, "Which commands report", the notice), "Event taxonomy" (the two `cli:` events, property rules), "Anti-goals", phase 4 of "Phases". The phase-1 plan at `docs/superpowers/plans/2026-10-21-growth-phase-1-observe-the-site.md` is the model for task shape.

**Deviations from the spec, decided here:**

1. The spec's command list names `validate` and `typecheck`; the CLI's actual commands are `check` ("Validate a B4.run app") and `typegen`. The allowlist uses the real names: `dev`, `build`, `add`, `check`, `typegen`, `verify`, `eval`.
2. The website ingest route (`apps/web/app/api/signals/v1/cli`) is deferred to a later PR in `apps/web`. This plan writes its request contract into `docs/growth/README.md` (Task 9). Until it exists the CLI receives a 404 and ignores it.
3. Phase 1 added `command` to `FORBIDDEN_PROPERTIES` in `scripts/posthog/contract.ts` to guard against free text. `cli:command_completed` carries `command` as one of seven fixed names, so Task 8 removes `command` from the forbidden list and the event contract pins the allowed values.
4. A `CommanderError` (usage error, `--help`, `--version`) means the command never dispatched, so it emits nothing. The outcome `cancelled` is an error whose `name` is `AbortError` or a `CliError` with `exitCode` 130; `b4 dev` stopped by Ctrl-C closes cleanly and reports `ok`.
5. The first-run notice is printed when the identity file is created, which is the only persistent state the spec allows. "Printed once" and "created on first run" are the same event.

## Global Constraints

- The industry word for this activity (the one inside the `DO_NOT_TRACK` variable name, with its *-ing* form) appears nowhere in new code, copy, docs, test names, or file names. The only allowed occurrences are the env var names `B4_TELEMETRY_DISABLED` and `DO_NOT_TRACK`. Say *usage reporting* or *signals*. (Pre-existing comments in `packages/cli/src/lib/dev/*.ts` are out of scope; do not touch them.)
- Nothing about routes, models, prompts, messages, file paths, project names, hostnames, usernames, or git identity is ever sent. Error messages are never sent; only an error class.
- Every string property is capped at 128 characters (`MAX_PROPERTY_LENGTH = 128`).
- Identity is one random UUID in `~/.b4/usage-id`. No other persistent state.
- Opt-out: `B4_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, and CI detection make every command inert before any file write or network call.
- Transport: `POST https://b4.run/api/signals/v1/cli`, override `B4_SIGNALS_URL`, 3 000 ms timeout, no credentials, never throws, never prints on failure, never changes the command's exit code.
- `start` never reports. `create-b4-app` and runtime packages are not touched.
- No new dependency in `packages/cli`. One changeset, `patch`, `@b4run/cli`.
- `src/` imports use `.js`; `test/` imports use `.ts`. `exactOptionalPropertyTypes` is on: spread optionals conditionally.
- Run all commands from the repo root with `export PATH=~/.nvm/versions/node/v24.20.0/bin:$PATH`. Lint with `pnpm lint` or `pnpm lint:fix`; never bare `biome check --write`.
- Do not touch `apps/web` beyond Task 9's one docs paragraph in `cli.mdx`, the present-tense rewrite of the CLI section of `content/privacy.mdx`, and the regenerated lastmod manifest.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The repo's own test suites must not report: `packages/cli/vitest.config.ts` sets `B4_TELEMETRY_DISABLED=1` for every worker, and `scripts/test.mjs` and `scripts/harness-report.mjs` set it in the env of every process they spawn (Task 6); the only test that exercises a real send points `B4_SIGNALS_URL` at a local server (Task 7).

## Review Focus

1. A developer whose home directory is read-only (or `HOME` unset) expects `b4 build` to work exactly as before. Pinned in Task 2: `readOrCreateUsageId` returns `null` on a write failure, and in Task 5: a `null` identity makes the emitter inert without printing.
2. A developer on a network that black-holes the endpoint expects the command to end within the timeout and with its own exit code. Pinned in Task 4 (hanging fetch is cut at 3 000 ms with fake timers) and Task 6 (exit code is the command's regardless of transport).
3. A developer who runs `b4 dev --help` or mistypes a flag must not generate an event. Pinned in Task 6: a `CommanderError` emits nothing.
4. A `cli:command_completed` for an `error` must carry a class, not a message: a `CliError` with a `B4_E1006` code reports `B4_E1006`, a plain `TypeError` reports `TypeError`, and a thrown string reports `unknown`. Pinned in Task 3.
5. A `b4 dev` session that restarts its child after a file edit must still fire `cli:dev_first_run_completed` at most once for the process. Pinned in Task 5 (emitter once-guard) and Task 7 (the integration test runs two AG-UI runs and asserts one event).

---

### Task 1: The reporting decision

**Files:**
- Create: `packages/cli/src/lib/signals/env.ts`
- Test: `packages/cli/test/signals-env.test.ts`

**Interfaces:**
- Produces:
  - `export const REPORTING_COMMANDS: readonly ["dev", "build", "add", "check", "typegen", "verify", "eval"]`
  - `export type ReportingCommand = (typeof REPORTING_COMMANDS)[number]`
  - `export function isReportingCommand(name: string): name is ReportingCommand`
  - `export const CI_ENVIRONMENT_VARIABLES: readonly string[]` = `CI`, `CONTINUOUS_INTEGRATION`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `BUILDKITE`, `TRAVIS`, `JENKINS_URL`, `TF_BUILD`, `TEAMCITY_VERSION`, `CODEBUILD_BUILD_ID`, `BITBUCKET_BUILD_NUMBER`, `DRONE`, `NETLIFY`, `VERCEL`
  - `export function isEnvFlagSet(value: string | undefined): boolean` — set when defined, non-empty, and not `"0"` or `"false"` (case-insensitive)
  - `export type SignalsDisabledReason = "opt-out" | "dnt" | "ci"`
  - `export function signalsDisabledReason(env: Readonly<Record<string, string | undefined>>): SignalsDisabledReason | null` — checks `B4_TELEMETRY_DISABLED`, then `DO_NOT_TRACK`, then each CI variable with `isEnvFlagSet`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/signals-env.test.ts
import { describe, expect, it } from "vitest"
import {
  CI_ENVIRONMENT_VARIABLES,
  isEnvFlagSet,
  isReportingCommand,
  REPORTING_COMMANDS,
  signalsDisabledReason,
} from "../src/lib/signals/env.ts"

describe("reporting commands", () => {
  it("lists exactly the seven development-time commands", () => {
    expect([...REPORTING_COMMANDS]).toEqual(["dev", "build", "add", "check", "typegen", "verify", "eval"])
  })
  it("never includes start or the dev child", () => {
    for (const name of ["start", "__dev-child", "run", "test", "docs", "routes"]) {
      expect(isReportingCommand(name), name).toBe(false)
    }
    expect(isReportingCommand("dev")).toBe(true)
  })
})

describe("signalsDisabledReason", () => {
  it("is null for an empty environment", () => {
    expect(signalsDisabledReason({})).toBeNull()
  })
  it("honours B4_TELEMETRY_DISABLED before anything else", () => {
    expect(signalsDisabledReason({ B4_TELEMETRY_DISABLED: "1", CI: "true" })).toBe("opt-out")
  })
  it("honours DO_NOT_TRACK", () => {
    expect(signalsDisabledReason({ DO_NOT_TRACK: "1" })).toBe("dnt")
  })
  it("treats every CI variable as inert", () => {
    for (const name of CI_ENVIRONMENT_VARIABLES) {
      expect(signalsDisabledReason({ [name]: "true" }), name).toBe("ci")
    }
    expect(CI_ENVIRONMENT_VARIABLES).toContain("GITHUB_ACTIONS")
    expect(CI_ENVIRONMENT_VARIABLES).toContain("BUILDKITE")
    expect(CI_ENVIRONMENT_VARIABLES).toContain("CIRCLECI")
  })
  it("ignores a flag set to 0, false, or empty", () => {
    expect(signalsDisabledReason({ B4_TELEMETRY_DISABLED: "0", DO_NOT_TRACK: "", CI: "false" })).toBeNull()
    expect(isEnvFlagSet("FALSE")).toBe(false)
    expect(isEnvFlagSet("yes")).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/signals-env.test.ts`
Expected: FAIL, cannot find module `../src/lib/signals/env.ts`

- [ ] **Step 3: Implement `packages/cli/src/lib/signals/env.ts`** with the exports in the Interfaces block. No imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command. Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/signals/env.ts packages/cli/test/signals-env.test.ts
git commit -m "feat(cli): decide which commands report usage signals and when reporting is inert"
```

---

### Task 2: The usage identity file

**Files:**
- Create: `packages/cli/src/lib/signals/usage-id.ts`
- Test: `packages/cli/test/signals-usage-id.test.ts`

**Interfaces:**
- Produces:
  - `export const USAGE_ID_FILENAME = "usage-id"`
  - `export function resolveUsageDir(homeDir?: string): string | null` — `join(homeDir ?? os.homedir(), ".b4")`; `null` when the home directory is empty or `os.homedir()` throws.
  - `export interface UsageIdentity { readonly id: string; readonly created: boolean }`
  - `export async function readOrCreateUsageId(dir: string): Promise<UsageIdentity | null>` — reads `<dir>/usage-id`; a trimmed lowercase UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`) is returned with `created: false`; a missing or malformed file is replaced by `crypto.randomUUID()` written with `mkdir(dir, { recursive: true })` and mode `0o600`, returned with `created: true`; any filesystem error returns `null`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/signals-usage-id.test.ts
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readOrCreateUsageId, resolveUsageDir, USAGE_ID_FILENAME } from "../src/lib/signals/usage-id.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})
async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), "b4-usage-id-"))
  dirs.push(dir)
  return dir
}

describe("resolveUsageDir", () => {
  it("is ~/.b4", () => {
    expect(resolveUsageDir("/home/dev")).toBe(join("/home/dev", ".b4"))
  })
  it("is null without a home directory", () => {
    expect(resolveUsageDir("")).toBeNull()
  })
})

describe("readOrCreateUsageId", () => {
  it("creates a v4 UUID on first use and reports created", async () => {
    const dir = join(await tempHome(), ".b4")
    const first = await readOrCreateUsageId(dir)
    expect(first?.created).toBe(true)
    expect(first?.id).toMatch(UUID)
    expect((await readFile(join(dir, USAGE_ID_FILENAME), "utf8")).trim()).toBe(first?.id)
  })
  it("reads the same id back and reports not created", async () => {
    const dir = join(await tempHome(), ".b4")
    const first = await readOrCreateUsageId(dir)
    const second = await readOrCreateUsageId(dir)
    expect(second).toEqual({ id: first?.id, created: false })
  })
  it("replaces a malformed file", async () => {
    const dir = join(await tempHome(), ".b4")
    await readOrCreateUsageId(dir)
    await writeFile(join(dir, USAGE_ID_FILENAME), "not a uuid\n")
    const identity = await readOrCreateUsageId(dir)
    expect(identity?.created).toBe(true)
    expect(identity?.id).toMatch(UUID)
  })
  it("returns null when the directory cannot be written", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const home = await tempHome()
    await chmod(home, 0o500)
    try {
      expect(await readOrCreateUsageId(join(home, ".b4"))).toBeNull()
    } finally {
      await chmod(home, 0o700)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/signals-usage-id.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `packages/cli/src/lib/signals/usage-id.ts`** with `node:fs/promises`, `node:os`, `node:path`, `node:crypto`.

- [ ] **Step 4: Run the tests to verify they pass**

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/signals/usage-id.ts packages/cli/test/signals-usage-id.test.ts
git commit -m "feat(cli): keep one random usage id in ~/.b4/usage-id"
```

---

### Task 3: Event shaping

**Files:**
- Create: `packages/cli/src/lib/signals/events.ts`
- Test: `packages/cli/test/signals-events.test.ts`

**Interfaces:**
- Consumes: `ReportingCommand` from Task 1.
- Produces:
  - `export const MAX_PROPERTY_LENGTH = 128`
  - `export type CommandOutcome = "ok" | "error" | "cancelled"`
  - `export type DurationBucket = "under_1s" | "1s_to_10s" | "10s_to_1m" | "1m_to_10m" | "over_10m"`
  - `export type RouteKind = "agent" | "chain" | "graph" | "workflow"`
  - `export const CLI_EVENT_PROPERTIES: Readonly<Record<"cli:command_completed" | "cli:dev_first_run_completed", readonly string[]>>` = `["command", "cli_version", "node_major", "os", "outcome", "duration_bucket", "error_class"]` and `["cli_version", "route_kind"]`
  - `export interface SignalEvent { readonly event: keyof typeof CLI_EVENT_PROPERTIES; readonly properties: Readonly<Record<string, string | number>> }`
  - `export function durationBucket(ms: number): DurationBucket` — `< 1000`, `< 10_000`, `< 60_000`, `< 600_000`, else.
  - `export const KNOWN_ERROR_NAMES: ReadonlySet<string>` = `Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`, `AbortError`, `TimeoutError`, `CliError`, `CommanderError`.
  - `export function errorClass(error: unknown): string` — a `CliError` with `code` → the code; an `Error` whose `name` is in `KNOWN_ERROR_NAMES` → that name; any other `Error` → `"Error"` (a user-defined class name could carry a project name); anything else → `"unknown"`. Never the message.
  - `export function capProperty(value: string): string` — `value.slice(0, MAX_PROPERTY_LENGTH)`.
  - `export interface CommandCompletedInput { readonly command: ReportingCommand; readonly cliVersion: string; readonly nodeMajor: number; readonly os: string; readonly outcome: CommandOutcome; readonly durationMs: number; readonly error?: unknown }`
  - `export function commandCompletedEvent(input: CommandCompletedInput): SignalEvent` — `error_class` present only when `outcome !== "ok"` and `input.error !== undefined`.
  - `export function devFirstRunCompletedEvent(input: { readonly cliVersion: string; readonly routeKind: RouteKind }): SignalEvent`
  - `export function toAllowedProperties(event: SignalEvent["event"], properties: Readonly<Record<string, unknown>>): Readonly<Record<string, string | number>>` — keeps only allowlisted keys with `string` or finite `number` values, caps strings. Both builders pass their output through it.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/signals-events.test.ts
import { describe, expect, it } from "vitest"
import { CliError } from "../src/lib/output.ts"
import {
  CLI_EVENT_PROPERTIES,
  commandCompletedEvent,
  devFirstRunCompletedEvent,
  durationBucket,
  errorClass,
  MAX_PROPERTY_LENGTH,
  toAllowedProperties,
} from "../src/lib/signals/events.ts"

const base = { command: "build" as const, cliVersion: "0.14.0", nodeMajor: 24, os: "darwin" }

describe("durationBucket", () => {
  it("buckets by the five boundaries", () => {
    expect(durationBucket(0)).toBe("under_1s")
    expect(durationBucket(999)).toBe("under_1s")
    expect(durationBucket(1000)).toBe("1s_to_10s")
    expect(durationBucket(10_000)).toBe("10s_to_1m")
    expect(durationBucket(60_000)).toBe("1m_to_10m")
    expect(durationBucket(600_000)).toBe("over_10m")
  })
})

describe("errorClass", () => {
  it("reports a B4 error code, an error name, or unknown, never a message", () => {
    expect(errorClass(new CliError("secret path /Users/x", 1, { code: "B4_E1006" }))).toBe("B4_E1006")
    expect(errorClass(new CliError("no code"))).toBe("CliError")
    expect(errorClass(new TypeError("boom /etc/passwd"))).toBe("TypeError")
    class AcmeProjectError extends Error { override name = "AcmeProjectError" }
    expect(errorClass(new AcmeProjectError("x"))).toBe("Error")
    expect(errorClass("a string")).toBe("unknown")
    expect(errorClass(undefined)).toBe("unknown")
  })
})

describe("commandCompletedEvent", () => {
  it("carries exactly the allowlisted properties for ok", () => {
    const event = commandCompletedEvent({ ...base, outcome: "ok", durationMs: 1500 })
    expect(event.event).toBe("cli:command_completed")
    expect(event.properties).toEqual({
      command: "build", cli_version: "0.14.0", node_major: 24, os: "darwin",
      outcome: "ok", duration_bucket: "1s_to_10s",
    })
  })
  it("adds error_class for an error and never the message", () => {
    const event = commandCompletedEvent({ ...base, outcome: "error", durationMs: 5, error: new RangeError("/home/me/app") })
    expect(event.properties.error_class).toBe("RangeError")
    expect(JSON.stringify(event)).not.toContain("/home/me")
  })
  it("caps every string at 128 characters", () => {
    const event = commandCompletedEvent({ ...base, cliVersion: "9".repeat(300), outcome: "ok", durationMs: 0 })
    expect(event.properties.cli_version).toHaveLength(MAX_PROPERTY_LENGTH)
  })
})

describe("devFirstRunCompletedEvent", () => {
  it("carries only cli_version and route_kind", () => {
    expect(devFirstRunCompletedEvent({ cliVersion: "0.14.0", routeKind: "graph" })).toEqual({
      event: "cli:dev_first_run_completed",
      properties: { cli_version: "0.14.0", route_kind: "graph" },
    })
  })
})

describe("toAllowedProperties", () => {
  it("drops unknown keys and non-scalar values", () => {
    expect(
      toAllowedProperties("cli:dev_first_run_completed", {
        route_kind: "agent", prompt: "secret", path: "/x", messages: [], cli_version: { v: 1 }, nested: { a: 1 },
      }),
    ).toEqual({ route_kind: "agent" })
  })
  it("never allowlists a forbidden name", () => {
    for (const keys of Object.values(CLI_EVENT_PROPERTIES)) {
      for (const forbidden of ["email", "path", "prompt", "messages", "error", "threadId", "runId", "query", "text"]) {
        expect(keys).not.toContain(forbidden)
      }
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/signals-events.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `packages/cli/src/lib/signals/events.ts`**, importing `CliError` from `../output.js` and `ReportingCommand` (type) from `./env.js`.

- [ ] **Step 4: Run the tests to verify they pass**

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/signals/events.ts packages/cli/test/signals-events.test.ts
git commit -m "feat(cli): shape the two usage signal events behind a property allowlist"
```

---

### Task 4: The transport

**Files:**
- Create: `packages/cli/src/lib/signals/transport.ts`
- Test: `packages/cli/test/signals-transport.test.ts`

**Interfaces:**
- Consumes: `SignalEvent` from Task 3.
- Produces:
  - `export const DEFAULT_SIGNALS_URL = "https://b4.run/api/signals/v1/cli"`
  - `export const SIGNALS_TIMEOUT_MS = 3000`
  - `export const SIGNALS_SCHEMA_VERSION = 1`
  - `export function resolveSignalsUrl(env: Readonly<Record<string, string | undefined>>): string` — `B4_SIGNALS_URL` when it parses as an `http:` or `https:` URL, else the default.
  - `export interface SignalsRequestBody { readonly schema: 1; readonly usage_id: string; readonly sent_at: string; readonly events: readonly SignalEvent[] }`
  - `export type FetchLike = (input: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<unknown>`
  - `export interface SendSignalsOptions { readonly url: string; readonly fetch?: FetchLike; readonly timeoutMs?: number }`
  - `export async function sendSignals(body: SignalsRequestBody, options: SendSignalsOptions): Promise<void>` — one `POST` with `content-type: application/json` and `user-agent: b4-cli`, `signal` from an `AbortController` aborted by an unref'd `setTimeout(timeoutMs)` (cleared on settle), default fetch `globalThis.fetch`; swallows every rejection and every non-2xx; never logs.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/signals-transport.test.ts
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_SIGNALS_URL,
  type FetchLike,
  resolveSignalsUrl,
  sendSignals,
  SIGNALS_TIMEOUT_MS,
} from "../src/lib/signals/transport.ts"

const body = {
  schema: 1 as const, usage_id: "11111111-1111-4111-8111-111111111111", sent_at: "2026-10-21T00:00:00.000Z",
  events: [{ event: "cli:dev_first_run_completed" as const, properties: { cli_version: "0.14.0", route_kind: "graph" } }],
}
afterEach(() => { vi.useRealTimers() })

describe("resolveSignalsUrl", () => {
  it("defaults to the b4.run endpoint", () => {
    expect(resolveSignalsUrl({})).toBe(DEFAULT_SIGNALS_URL)
    expect(DEFAULT_SIGNALS_URL).toBe("https://b4.run/api/signals/v1/cli")
  })
  it("honours B4_SIGNALS_URL when it is an http(s) URL", () => {
    expect(resolveSignalsUrl({ B4_SIGNALS_URL: "http://127.0.0.1:9/x" })).toBe("http://127.0.0.1:9/x")
    expect(resolveSignalsUrl({ B4_SIGNALS_URL: "file:///tmp/x" })).toBe(DEFAULT_SIGNALS_URL)
    expect(resolveSignalsUrl({ B4_SIGNALS_URL: "nope" })).toBe(DEFAULT_SIGNALS_URL)
  })
})

describe("sendSignals", () => {
  it("posts JSON without credentials", async () => {
    const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 202 }))
    await sendSignals(body, { url: "http://localhost/x", fetch })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe("http://localhost/x")
    expect(init.method).toBe("POST")
    expect(init.headers["content-type"]).toBe("application/json")
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain("authorization")
    expect(JSON.parse(init.body)).toEqual(body)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
  it("resolves when fetch rejects and when the response is a 404", async () => {
    await expect(sendSignals(body, { url: "http://localhost/x", fetch: async () => { throw new Error("ECONNREFUSED") } })).resolves.toBeUndefined()
    await expect(sendSignals(body, { url: "http://localhost/x", fetch: async () => ({ ok: false, status: 404 }) })).resolves.toBeUndefined()
  })
  it("resolves when fetch throws synchronously", async () => {
    await expect(sendSignals(body, { url: "http://localhost/x", fetch: () => { throw new TypeError("bad") } })).resolves.toBeUndefined()
  })
  it("gives up after the timeout when the request hangs", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<FetchLike>((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason))
    }))
    const pending = sendSignals(body, { url: "http://localhost/x", fetch })
    await vi.advanceTimersByTimeAsync(SIGNALS_TIMEOUT_MS + 1)
    await expect(pending).resolves.toBeUndefined()
    expect(SIGNALS_TIMEOUT_MS).toBe(3000)
  })
  it("never writes to stdout or stderr on failure", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await sendSignals(body, { url: "http://localhost/x", fetch: async () => { throw new Error("x") } })
      expect(out).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled()
    } finally { out.mockRestore(); err.mockRestore(); log.mockRestore() }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/signals-transport.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `packages/cli/src/lib/signals/transport.ts`**. Wrap the whole send, including building the signal and calling `fetch`, in one `try { … } catch { /* intentionally silent */ }`. Build the timeout from an `AbortController` plus `setTimeout(() => controller.abort(), timeoutMs)` with `.unref()` and `clearTimeout` on settle, not `AbortSignal.timeout`: vitest's fake timers drive `setTimeout`, so the hanging test needs no real wait, and `unref` keeps a pending send from holding the process open.

- [ ] **Step 4: Run the tests to verify they pass**

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/signals/transport.ts packages/cli/test/signals-transport.test.ts
git commit -m "feat(cli): post usage signals credential-free with a bounded, silent transport"
```

---

### Task 5: The emitter

**Files:**
- Create: `packages/cli/src/lib/signals/emitter.ts`
- Create: `packages/cli/src/lib/signals/cli-version.ts`
- Test: `packages/cli/test/signals-emitter.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `CommandIo` from `../output.js`.
- Produces:
  - `export function readCliVersion(): string` in `cli-version.ts` — `createRequire(import.meta.url)("../../../package.json").version`, `"0.0.0"` on any failure. (`src/lib/signals/` and `dist/lib/signals/` are both three levels below the package root.)
  - `export const FIRST_RUN_NOTICE: string` — exactly these three lines, each ending in `\n`:
    ```
    B4.run collects anonymous usage signals (command, version, OS, outcome) to
    improve the CLI. No code, paths, or identity are collected.
    Disable: B4_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Details: https://b4.run/privacy
    ```
  - `export interface SignalsEmitterOptions { readonly io: CommandIo; readonly env?: Readonly<Record<string, string | undefined>>; readonly homeDir?: string; readonly fetch?: FetchLike; readonly cliVersion?: string; readonly nodeMajor?: number; readonly os?: string; readonly now?: () => Date }` — defaults: `process.env`, `os.homedir()`, `globalThis.fetch`, `readCliVersion()`, `Number(process.versions.node.split(".")[0])`, `process.platform`, `() => new Date()`.
  - `export interface SignalsEmitter { commandStarted(command: string): void; commandCompleted(input: { readonly outcome: CommandOutcome; readonly durationMs: number; readonly error?: unknown }): void; devFirstRunCompleted(routeKind: RouteKind): void; flush(): Promise<void> }`
  - `export function createSignalsEmitter(options: SignalsEmitterOptions): SignalsEmitter`
  - `export function createInertSignalsEmitter(): SignalsEmitter` — every method a no-op, `flush` resolves.

  Behaviour: `commandStarted` records the command and, when it is a reporting command and `signalsDisabledReason(env) === null` and `resolveUsageDir(homeDir)` is not null, starts one identity promise (`readOrCreateUsageId`); when the identity is `created`, write `FIRST_RUN_NOTICE` to `io.stderr` before resolving the promise. Every emit awaits that promise; a `null` identity, a disabled env, or no recorded reporting command makes the emit a no-op. `devFirstRunCompleted` emits at most once per emitter. Each emit is one async job (await the identity promise, build the event, one `sendSignals` call with a single event); the WHOLE job promise, not just the send, is added to a `Set` the moment the emit starts and removed when it settles, and `flush()` awaits every member. Nothing in the emitter may throw.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/signals-emitter.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readCliVersion } from "../src/lib/signals/cli-version.ts"
import { createSignalsEmitter, FIRST_RUN_NOTICE } from "../src/lib/signals/emitter.ts"
import type { FetchLike } from "../src/lib/signals/transport.ts"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true }))) })
async function harness(env: Record<string, string> = {}, home?: string) {
  const homeDir = home ?? (await mkdtemp(join(tmpdir(), "b4-emitter-")))
  if (!home) dirs.push(homeDir)
  const stderr: string[] = []
  const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 202 }))
  const emitter = createSignalsEmitter({
    io: { stdout: () => undefined, stderr: (m) => stderr.push(m) },
    env, homeDir, fetch, cliVersion: "0.14.0", nodeMajor: 24, os: "linux",
    now: () => new Date("2026-10-21T12:00:00.000Z"),
  })
  const bodies = () => fetch.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body))
  return { emitter, stderr, fetch, bodies, homeDir }
}

describe("createSignalsEmitter", () => {
  it("prints the notice exactly once, before the first send, and creates the id", async () => {
    const h = await harness()
    h.emitter.commandStarted("build")
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 10 })
    await h.emitter.flush()
    expect(h.stderr.join("")).toBe(FIRST_RUN_NOTICE)
    expect(FIRST_RUN_NOTICE).toBe(
      "B4.run collects anonymous usage signals (command, version, OS, outcome) to\n" +
      "improve the CLI. No code, paths, or identity are collected.\n" +
      "Disable: B4_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Details: https://b4.run/privacy\n",
    )
    const id = (await readFile(join(h.homeDir, ".b4", "usage-id"), "utf8")).trim()
    expect(h.bodies()).toEqual([{
      schema: 1, usage_id: id, sent_at: "2026-10-21T12:00:00.000Z",
      events: [{ event: "cli:command_completed", properties: {
        command: "build", cli_version: "0.14.0", node_major: 24, os: "linux", outcome: "ok", duration_bucket: "under_1s",
      } }],
    }])
    const again = await harness({}, h.homeDir)
    again.emitter.commandStarted("check")
    again.emitter.commandCompleted({ outcome: "error", durationMs: 2000, error: new Error("x") })
    await again.emitter.flush()
    expect(again.stderr).toEqual([])
    expect(again.bodies()[0].events[0].properties).toMatchObject({ outcome: "error", error_class: "Error", duration_bucket: "1s_to_10s" })
  })
  it("is inert for a non-reporting command: no file, no notice, no send", async () => {
    const h = await harness()
    h.emitter.commandStarted("start")
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    h.emitter.devFirstRunCompleted("agent")
    await h.emitter.flush()
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.stderr).toEqual([])
    await expect(readFile(join(h.homeDir, ".b4", "usage-id"))).rejects.toThrow()
  })
  it("is inert without a started command", async () => {
    const h = await harness()
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    await h.emitter.flush()
    expect(h.fetch).not.toHaveBeenCalled()
  })
  it.each([{ B4_TELEMETRY_DISABLED: "1" }, { DO_NOT_TRACK: "1" }, { CI: "true" }, { GITHUB_ACTIONS: "true" }])(
    "is inert before any file write or network call under %o", async (env) => {
      const h = await harness(env)
      h.emitter.commandStarted("dev")
      h.emitter.devFirstRunCompleted("graph")
      h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
      await h.emitter.flush()
      expect(h.fetch).not.toHaveBeenCalled(); expect(h.stderr).toEqual([])
      await expect(readFile(join(h.homeDir, ".b4", "usage-id"))).rejects.toThrow()
    },
  )
  it("is inert without a usable home directory", async () => {
    const h = await harness({}, "")
    h.emitter.commandStarted("build")
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    await h.emitter.flush()
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.stderr).toEqual([])
  })
  it("sends cli:dev_first_run_completed at most once", async () => {
    const h = await harness()
    h.emitter.commandStarted("dev")
    h.emitter.devFirstRunCompleted("graph")
    h.emitter.devFirstRunCompleted("agent")
    await h.emitter.flush()
    const first = h.bodies().filter((b) => b.events[0].event === "cli:dev_first_run_completed")
    expect(first).toHaveLength(1)
    expect(first[0].events[0].properties).toEqual({ cli_version: "0.14.0", route_kind: "graph" })
  })
  it("uses B4_SIGNALS_URL", async () => {
    const h = await harness({ B4_SIGNALS_URL: "http://127.0.0.1:1/cli" })
    h.emitter.commandStarted("build")
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    await h.emitter.flush()
    expect(h.fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:1/cli")
  })
  it("never throws or rejects when the transport fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "b4-emitter-")); dirs.push(home)
    const emitter = createSignalsEmitter({
      io: { stdout: () => undefined, stderr: () => undefined }, env: {}, homeDir: home,
      fetch: () => { throw new Error("down") }, cliVersion: "0.14.0", nodeMajor: 24, os: "linux",
    })
    expect(() => { emitter.commandStarted("build"); emitter.commandCompleted({ outcome: "ok", durationMs: 1 }) }).not.toThrow()
    await expect(emitter.flush()).resolves.toBeUndefined()
  })
})

describe("readCliVersion", () => {
  it("reads the package version", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    expect(readCliVersion()).toBe(pkg.version)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/signals-emitter.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `cli-version.ts` and `emitter.ts`** per the Interfaces block. Order inside an emit job: `await identity` → build the event → `sendSignals`; the job promise joins the `Set<Promise<void>>` before its first `await` and leaves it on settle.

- [ ] **Step 4: Run the tests to verify they pass**

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/signals/emitter.ts packages/cli/src/lib/signals/cli-version.ts packages/cli/test/signals-emitter.test.ts
git commit -m "feat(cli): usage signals emitter with first-run notice and once-only activation event"
```

---

### Task 6: Wrap command dispatch

**Files:**
- Modify: `packages/cli/src/index.ts` (`createProgram`, `run`)
- Modify: `packages/cli/vitest.config.ts` (`test.env`)
- Modify: `scripts/test.mjs` (the `spawnSyncImpl` call gains `env: { ...process.env, B4_TELEMETRY_DISABLED: "1" }`)
- Modify: `scripts/harness-report.mjs` (`runProcess`'s `spawnSync` gains the same `env`)
- Modify: `scripts/test.test.mjs` only if its assertions on the spawn options need it (they compare `command` and `args`, not `options`)
- Test: `packages/cli/test/signals-dispatch.test.ts`

**Interfaces:**
- Consumes: `createSignalsEmitter`, `SignalsEmitter` from Task 5; `isReportingCommand` from Task 1.
- Produces:
  - `export interface RunOptions { readonly signals?: SignalsEmitter }`
  - `export async function run(argv: readonly string[], io: CommandIo = createNodeIo(), options: RunOptions = {}): Promise<number>` — `const signals = options.signals ?? createSignalsEmitter({ io })`; `program.hook("preAction", (_thisCommand, actionCommand) => { signals.commandStarted(actionCommand.name()) })`; `const startedAt = performance.now()`; after `parseAsync` resolves → `commandCompleted({ outcome: "ok", durationMs })`; on a `CliError` → `error` (or `cancelled` when `exitCode === 130`); on a `CommanderError` → nothing; on any other error → `cancelled` when `error.name === "AbortError"` else `error`; in a `finally`, `await signals.flush()`. The returned exit code is exactly what it was before this task.
  - `createProgram(io: CommandIo, options?: { readonly signals?: SignalsEmitter })` — Task 7 uses `options.signals` for the dev command; this task only adds the parameter and the `preAction` hook.
  - `export { createSignalsEmitter, type SignalsEmitter } from "./lib/signals/emitter.js"` is NOT added: the emitter stays internal.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/signals-dispatch.test.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { run } from "../src/index.ts"
import type { SignalsEmitter } from "../src/lib/signals/emitter.ts"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true }))) })
function fakeEmitter() {
  const calls: unknown[][] = []
  const emitter: SignalsEmitter = {
    commandStarted: (c) => { calls.push(["started", c]) },
    commandCompleted: (i) => { calls.push(["completed", i.outcome, i.error === undefined ? undefined : (i.error as Error).name]) },
    devFirstRunCompleted: (k) => { calls.push(["first-run", k]) },
    flush: vi.fn(async () => { calls.push(["flush"]) }),
  }
  return { emitter, calls }
}
const io = () => ({ stdout: () => undefined, stderr: () => undefined })
async function app(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "b4-signals-dispatch-")); dirs.push(root)
  for (const [p, s] of Object.entries({ "package.json": '{"type":"module"}\n', "b4.config.ts": "export default {};\n", ...files })) {
    await mkdir(join(root, p, ".."), { recursive: true }); await writeFile(join(root, p), s)
  }
  return root
}

describe("run() reports through the emitter", () => {
  it("starts and completes an allowlisted command with outcome ok", async () => {
    const root = await app({ "src/app/hello/index.ts": "export const graph = async () => ({ ok: true });\n" })
    const { emitter, calls } = fakeEmitter()
    const code = await run(["check", "--cwd", root], io(), { signals: emitter })
    expect(code).toBe(0)
    expect(calls).toEqual([["started", "check"], ["completed", "ok", undefined], ["flush"]])
  })
  it("reports error with the error and keeps the exit code", async () => {
    const root = await app({ "package.json": "{}\n" })
    const { emitter, calls } = fakeEmitter()
    const code = await run(["check", "--cwd", root], io(), { signals: emitter })
    expect(code).not.toBe(0)
    expect(calls[0]).toEqual(["started", "check"])
    expect(calls[1]?.[0]).toBe("completed"); expect(calls[1]?.[1]).toBe("error"); expect(calls[1]?.[2]).toBe("CliError")
    expect(calls.at(-1)).toEqual(["flush"])
  })
  it("emits nothing for --help, an unknown option, or an unknown command", async () => {
    for (const argv of [["build", "--help"], ["start", "--help"], ["build", "--no-such-flag"], ["frobnicate"]]) {
      const { emitter, calls } = fakeEmitter()
      await run(argv, io(), { signals: emitter })
      expect(calls.filter(([k]) => k === "completed"), argv.join(" ")).toEqual([])
      expect(calls.at(-1), argv.join(" ")).toEqual(["flush"])
    }
  })
  it("still returns the command's exit code when flush rejects", async () => {
    const root = await app({ "src/app/hello/index.ts": "export const graph = async () => ({ ok: true });\n" })
    const { emitter } = fakeEmitter()
    const broken: SignalsEmitter = { ...emitter, flush: async () => { throw new Error("transport") } }
    await expect(run(["check", "--cwd", root], io(), { signals: broken })).resolves.toBe(0)
  })
})

describe("the default emitter under the test environment", () => {
  it("is disabled by vitest.config.ts so the suite never reports", () => {
    expect(process.env.B4_TELEMETRY_DISABLED).toBe("1")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/signals-dispatch.test.ts`
Expected: FAIL: `run` ignores the third argument (no `started` calls) and `B4_TELEMETRY_DISABLED` is undefined.

- [ ] **Step 3: Implement**: edit `run` and `createProgram` in `packages/cli/src/index.ts` per the Interfaces block (wrap `flush()` in its own try/catch so a rejecting emitter cannot change the exit code); add `env: { B4_TELEMETRY_DISABLED: "1" }` under `test` in `packages/cli/vitest.config.ts`; add the `env` to the two spawns in `scripts/test.mjs` and `scripts/harness-report.mjs` so suites outside `packages/cli` that spawn a real `b4` (`create-b4-app`, `devkit`, `test/generated`, `test/smoke`) stay silent on a developer machine; run `node --test scripts/test.test.mjs` to confirm its assertions still hold.

- [ ] **Step 4: Run the tests to verify they pass, then the existing dispatch tests**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/signals-dispatch.test.ts test/check-command.test.ts test/run-command.test.ts test/routes-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/vitest.config.ts packages/cli/test/signals-dispatch.test.ts scripts/test.mjs scripts/harness-report.mjs scripts/test.test.mjs
git commit -m "feat(cli): report cli:command_completed for development-time commands"
```

---

### Task 7: The dev first-run signal

**Files:**
- Create: `packages/cli/src/lib/signals/dev-run-notifier.ts`
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (the `for await` loop over `toAguiEvents`, around line 1338)
- Modify: `packages/cli/src/lib/dev/dev-child.ts` (message types, `runDevChildCommand`, `spawnDevChild`)
- Modify: `packages/cli/src/lib/dev/dev-session.ts` (`startDevSession` options, the `spawnDevChild` call)
- Modify: `packages/cli/src/commands/dev.ts` (`registerDevCommand`, `runDevCommand`)
- Modify: `packages/cli/src/index.ts` (`createProgram` passes `options.signals` to `registerDevCommand`; `run` passes `{ signals }` to `createProgram`)
- Test: `packages/cli/test/signals-dev-first-run.test.ts`

**Interfaces:**
- Consumes: `RouteKind` from Task 3; `SignalsEmitter` from Task 5.
- Produces:
  - `dev-run-notifier.ts`: `export type DevRunListener = (info: { readonly routeKind: RouteKind }) => void`; `export function setDevRunListener(listener: DevRunListener | null): void`; `export function notifyDevRunFinished(info: { readonly routeKind: RouteKind }): void` — calls the listener inside try/catch; a no-op when none is set (production `serveRuntime`, `b4 start`, embedded hosts never set one).
  - `agui-handler.ts`: inside the loop, when `event.type === "RUN_FINISHED"` and `event.outcome?.type !== "cancelled"`, call `notifyDevRunFinished({ routeKind: route.mode })` once per run (guard with a local boolean). Nothing else changes.
  - `dev-child.ts`: new message `interface DevChildRunFinishedMessage { readonly type: "run-finished"; readonly routeKind: RouteKind }` in the `DevChildMessage` union; `runDevChildCommand` calls `setDevRunListener(({ routeKind }) => { process.send?.({ type: "run-finished", routeKind } satisfies DevChildRunFinishedMessage) })` right after the `ready` message is sent; `SpawnDevChildOptions` gains `readonly onRunFinished?: (routeKind: RouteKind) => void`; the `child.on("message")` handler dispatches `run-finished` to it BEFORE the fall-through that treats any other message as `ready` (today every non-`startup-error` message resolves readiness with `message.url`; a `run-finished` message must not reach that branch).
  - `dev-session.ts`: `startDevSession` gains `readonly onRunFinished?: (routeKind: RouteKind) => void`, stored on `InternalDevSession` and passed to every `spawnDevChild` call (so restarts keep reporting; the once-guard lives in the emitter).
  - `dev.ts`: `registerDevCommand(program: Command, io: CommandIo, signals?: SignalsEmitter)`; `runDevCommand(options: DevOptions, io: CommandIo, signals?: SignalsEmitter)` passes `onRunFinished: (routeKind) => signals?.devFirstRunCompleted(routeKind)` when `signals` is defined.

- [ ] **Step 1: Write the failing tests**

Model the dev-process helper on `startDevProcess` in `packages/cli/test/dev-command.test.ts` (read that file; copy its fixture-app and spawn pattern rather than importing from it; `invokeRunsWait` there is the Agent Protocol helper, not AG-UI). The spawned `b4 dev` needs an env with every CI variable and `B4_TELEMETRY_DISABLED` / `DO_NOT_TRACK` removed, `HOME` set to a temp dir, and `B4_SIGNALS_URL` set to a local `node:http` server that records request bodies and replies 202.

The AG-UI endpoint is `POST /agui/<encodeURIComponent("<routePath>#<mode>")>`, for example `/agui/%2Fhello%23graph` for `src/app/hello/index.ts` exporting `export const graph = async (_input, ctx) => ({ ok: true })` (see `packages/cli/test/agui-endpoint.test.ts` around lines 146 and 684-710). Headers: `content-type: application/json`, `accept: text/event-stream`. Body: `{ threadId, runId, messages: [{ id: "1", role: "user", content: "hello" }], state: {}, tools: [], context: [], forwardedProps: {} }` with fresh UUIDs per run. Read the whole SSE response body before the next step.

Two races to avoid: (1) the child-to-parent IPC can arrive after the SSE response ends, so poll the local signals server until the `cli:dev_first_run_completed` body has arrived (bounded, 10 s) before stopping; (2) `DevProcessHandle.stop()` in `dev-command.test.ts` sends SIGKILL after 2 s, which can cut the exit-time `cli:command_completed` send, so send SIGTERM yourself and wait for the process `close` event with a 20 s bound. Name the route something that cannot appear in a body by accident (for example `zzqx`).

```ts
// packages/cli/test/signals-dev-first-run.test.ts
import { describe, expect, it } from "vitest"
import { notifyDevRunFinished, setDevRunListener } from "../src/lib/signals/dev-run-notifier.ts"

describe("dev run notifier", () => {
  it("is a no-op without a listener and never throws from a listener", () => {
    setDevRunListener(null)
    expect(() => notifyDevRunFinished({ routeKind: "graph" })).not.toThrow()
    setDevRunListener(() => { throw new Error("boom") })
    expect(() => notifyDevRunFinished({ routeKind: "agent" })).not.toThrow()
    setDevRunListener(null)
  })
  it("forwards the route kind", () => {
    const seen: string[] = []
    setDevRunListener(({ routeKind }) => { seen.push(routeKind) })
    notifyDevRunFinished({ routeKind: "chain" })
    setDevRunListener(null)
    expect(seen).toEqual(["chain"])
  })
})

describe("b4 dev reports the first AG-UI run once", { timeout: 60_000 }, () => {
  it("sends cli:dev_first_run_completed once for two runs, prints the notice once, and reports the command at exit", async () => {
    // 1. start a local signals server; 2. start `b4 dev` with the env above;
    // 3. POST two AG-UI runs against a graph route; 4. stop the dev process (SIGTERM) and wait for exit.
    // Assertions:
    //   - exactly one body whose events[0].event === "cli:dev_first_run_completed", with properties { cli_version: <package version>, route_kind: "graph" }
    //   - exactly one body whose events[0].event === "cli:command_completed", with properties.command === "dev" and outcome "ok"
    //   - every body has the same usage_id, matching <HOME>/.b4/usage-id
    //   - the dev process stderr contains "B4.run collects anonymous usage signals" exactly once
    //   - no body's JSON contains the fixture app path or the route name
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/signals-dev-first-run.test.ts`
Expected: FAIL, cannot find module `dev-run-notifier.ts`; the integration test fails on zero signal bodies.

- [ ] **Step 3: Implement** the six source edits per the Interfaces block.

- [ ] **Step 4: Run the tests to verify they pass, then the dev suites**

Run: `pnpm --filter @b4run/cli exec vitest --run --config vitest.config.ts test/signals-dev-first-run.test.ts test/dev-command.test.ts test/agui-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/signals/dev-run-notifier.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/src/lib/dev/dev-child.ts packages/cli/src/lib/dev/dev-session.ts packages/cli/src/commands/dev.ts packages/cli/src/index.ts packages/cli/test/signals-dev-first-run.test.ts
git commit -m "feat(cli): report cli:dev_first_run_completed once per b4 dev process"
```

---

### Task 8: The PostHog contract and the CLI dashboard

**Files:**
- Modify: `scripts/posthog/contract.ts` (`FORBIDDEN_PROPERTIES` loses `command`; `EVENT_CONTRACT` gains the two `cli:` events)
- Modify: `scripts/posthog/contract.test.ts` (the first test filters `cli:` keys before comparing to `SIGNAL_EVENTS`, and a new test pins the `cli:` contracts)
- Create: `scripts/posthog/insights/cli-commands-by-command.json`, `cli-outcomes-by-outcome.json`, `cli-dev-first-runs-by-route-kind.json`, `cli-versions.json`
- Create: `scripts/posthog/dashboards/cli-usage-and-activation.json`
- Modify: `scripts/posthog/taxonomy.test.ts` (counts: eleven insights, two dashboards)

**Interfaces:**
- Produces, in `EVENT_CONTRACT`:
  - `"cli:command_completed"`: required `["command", "cli_version", "node_major", "os", "outcome", "duration_bucket"]`, allowed those plus `"error_class"`, breakdowns `["command", "outcome", "os", "node_major", "cli_version", "duration_bucket", "error_class"]`.
  - `"cli:dev_first_run_completed"`: required and allowed `["cli_version", "route_kind"]`, breakdowns the same.
- Dashboard: slug `cli-usage-and-activation`, name `Growth · CLI usage and activation`, tags `["growth"]`, description stating the limits: an anonymous id is one machine, not one person; a reporting command in CI, under `DO_NOT_TRACK`, or with the opt-out set is invisible; `cli:dev_first_run_completed` is the activation signal and fires once per `b4 dev` process. Tiles: the four insights above. Each insight: `slug`, `posthog_id: null`, `kind: "trends"`, `name` (title case, e.g. `CLI commands by command`), `description` (one sentence), `events: [{ "event": … }]`, `breakdown`, `interval: "day"`, `date_from: "-30d"`. Events: the first two and `cli-versions` count `cli:command_completed` (breakdowns `command`, `outcome`, `cli_version`); `cli-dev-first-runs-by-route-kind` counts `cli:dev_first_run_completed` (breakdown `route_kind`).

- [ ] **Step 1: Write the failing tests** — in `contract.test.ts` add:

```ts
it("pins the two CLI events to the spec's properties", () => {
  expect(EVENT_CONTRACT["cli:command_completed"]).toEqual({
    requiredProperties: ["command", "cli_version", "node_major", "os", "outcome", "duration_bucket"],
    allowedProperties: ["command", "cli_version", "node_major", "os", "outcome", "duration_bucket", "error_class"],
    allowedBreakdowns: ["command", "outcome", "os", "node_major", "cli_version", "duration_bucket", "error_class"],
  })
  expect(EVENT_CONTRACT["cli:dev_first_run_completed"]).toEqual({
    requiredProperties: ["cli_version", "route_kind"],
    allowedProperties: ["cli_version", "route_kind"],
    allowedBreakdowns: ["cli_version", "route_kind"],
  })
})
```

Change the first test's filter to `key !== "$pageview" && !key.startsWith("cli:")`, and in `taxonomy.test.ts` change the count test to `defines eleven insights and two dashboards` with `11` and `2`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest --run --config scripts/posthog/vitest.config.ts` (the package is `@b4run/posthog-tools`, not a workspace member, with no `test` script).
Expected: FAIL on the pin test and the counts.

- [ ] **Step 3: Implement** the contract edits, the four insight files, and the dashboard file.

- [ ] **Step 4: Run the tests and the typecheck to verify they pass**

Run: `pnpm exec vitest --run --config scripts/posthog/vitest.config.ts && pnpm exec tsc -p scripts/posthog/tsconfig.json --noEmit`
Expected: PASS, including `never allows a forbidden property` (which is why `command` leaves the forbidden list).

- [ ] **Step 5: Commit**

```bash
git add scripts/posthog
git commit -m "feat(growth): add the two cli: events and the CLI usage and activation dashboard"
```

---

### Task 9: Docs, README, changeset, and the ingest request contract

**Files:**
- Modify: `docs/growth/README.md` (new `## CLI signals` section after `## Environment`)
- Modify: `packages/cli/README.md` (new `## Usage reporting` section after `## Runtime and stability`)
- Modify: `apps/web/content/docs/cli.mdx` (one paragraph under `## Running the CLI`, after the Callout)
- Modify: `apps/web/content/privacy.mdx` (the section `## What the `b4` CLI will report` becomes `## What the `b4` CLI reports`, present tense: the seven development-time commands; the properties command name, CLI version, Node major version, operating system, outcome, a coarse duration bucket, and an error class on failure; one activation event when the first AG-UI run finishes in a `b4 dev` session with only the CLI version and the route kind; the random id in `~/.b4/usage-id`; silent in CI; keep the existing opt-out block and the `create-b4-app` sentence; do not touch any other section)
- Create: `.changeset/cli-usage-reporting.md`
- Modify (generated): `apps/web/app/seo/lastmod.generated.json`

**Interfaces:**
- The request contract for the future `apps/web` ingest route, written verbatim into `docs/growth/README.md`:

```
POST https://b4.run/api/signals/v1/cli        (override: B4_SIGNALS_URL)
Content-Type: application/json
User-Agent: b4-cli
No credentials. Timeout 3 s. The CLI ignores the status and the body.

{
  "schema": 1,
  "usage_id": "<uuid v4 from ~/.b4/usage-id>",
  "sent_at": "<ISO 8601 UTC>",
  "events": [
    { "event": "cli:command_completed",
      "properties": { "command": "build", "cli_version": "0.14.0", "node_major": 24,
                      "os": "darwin", "outcome": "ok", "duration_bucket": "1s_to_10s",
                      "error_class": "B4_E1006" } },
    { "event": "cli:dev_first_run_completed",
      "properties": { "cli_version": "0.14.0", "route_kind": "graph" } }
  ]
}
```

  Rules for the ingest route (so it can be built later without this PR): accept 1–10 events per request; reject the request with 400 when `schema` is not `1`, `usage_id` is not a UUID, or any event name is unknown; drop properties outside the event's allowlist; reject an event whose known property has the wrong type or an out-of-range value (`command` ∈ the seven names, `outcome` ∈ `ok|error|cancelled`, `duration_bucket` ∈ the five buckets, `route_kind` ∈ the four kinds, `node_major` an integer, strings ≤ 128 characters); forward to PostHog with `distinct_id = usage_id`, `$ip: null`, `$process_person_profile: false`, and reply 202 with an empty body. Until it exists the CLI receives a 404 and ignores it.

- Docs paragraph for `cli.mdx` (adapt wording, keep the facts): development-time commands (`dev`, `build`, `add`, `check`, `typegen`, `verify`, `eval`) report an anonymous usage signal (command name, CLI version, Node major, OS, outcome, duration bucket, and an error class on failure), plus one activation signal the first time an AG-UI run finishes in a `b4 dev` session; `b4 start` and the runtime never report; nothing about routes, models, prompts, paths, or identity is sent; the first reporting command prints a one-time notice; disable with `B4_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`, and CI environments are silent automatically; link `/privacy`.
- README section: the same facts in four sentences plus a table of `B4_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, `B4_SIGNALS_URL`.
- Changeset body: `@b4run/cli: patch` — "`b4` reports anonymous usage signals for development-time commands (`dev`, `build`, `add`, `check`, `typegen`, `verify`, `eval`) after a one-time notice. `b4 start` never reports. Disable with `B4_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`; CI is silent automatically. Details: https://b4.run/privacy".

- [ ] **Step 1: Write the docs, README, and changeset**, then grep the new text:

Run: `grep -rn -i "track" docs/growth/README.md packages/cli/README.md .changeset/cli-usage-reporting.md apps/web/content/docs/cli.mdx apps/web/content/privacy.mdx packages/cli/src/lib/signals packages/cli/test/signals-*.test.ts docs/superpowers/plans/2026-10-21-growth-phase-4-cli-usage-reporting.md | grep -v "B4_TELEMETRY_DISABLED\|DO_NOT_TRACK"`
Expected: no output from the grep.

- [ ] **Step 2: Run the docs checks**

Run: `node scripts/check-docs.mjs && pnpm lint`
Expected: both exit 0.

- [ ] **Step 3: Commit the content, then regenerate and commit the manifest**

```bash
git add docs/growth/README.md packages/cli/README.md apps/web/content/docs/cli.mdx apps/web/content/privacy.mdx .changeset/cli-usage-reporting.md
git commit -m "docs(cli): describe usage reporting, the opt-out, and the CLI signals request contract"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate the SEO lastmod manifest for the CLI reference and privacy page"
```

- [ ] **Step 4: Verify the manifest gate**

Run: `pnpm --dir apps/web seo:lastmod:check`
Expected: exit 0.

---

### Task 10: Whole-tree verification

**Files:** none new.

- [ ] **Step 1: Build and run the CLI package suite**

Run: `pnpm build && pnpm --filter @b4run/cli typecheck && pnpm --filter @b4run/cli test`
Expected: exit 0.

- [ ] **Step 2: Prove a real `b4` process is silent in CI and prints the notice once outside it**

```bash
H0=$(mktemp -d); HOME=$H0 CI=1 node packages/cli/dist/index.js check --cwd examples/chat/server 2>&1 | grep -c "anonymous usage signals"; ls $H0/.b4 2>&1   # expect 0, then no such directory
H=$(mktemp -d); env -u CI -u GITHUB_ACTIONS HOME=$H B4_SIGNALS_URL=http://127.0.0.1:9/cli node packages/cli/dist/index.js check --cwd examples/chat/server 2>&1 | grep -c "anonymous usage signals"; cat $H/.b4/usage-id   # expect 1, then a UUID
env -u CI -u GITHUB_ACTIONS HOME=$H B4_SIGNALS_URL=http://127.0.0.1:9/cli node packages/cli/dist/index.js check --cwd examples/chat/server 2>&1 | grep -c "anonymous usage signals"   # expect 0
```

- [ ] **Step 3: Run the full validation in the background**

Run: `pnpm ci:validate` (background, log to the scratchpad).
Expected: exit 0. The two `packages/sandbox` bounded-filesystem tests may time out under full-suite load and pass alone; that is a known unrelated flake.

- [ ] **Step 4: No commit**: the branch is ready for the finishing skill.

---

## Self-review

- **Spec coverage.** Surfaces table CLI row → Tasks 4–6; `create-b4-app`/runtime/`start` never → Task 1 allowlist and Task 6 tests; "Which commands report" → Task 1; CI inert → Tasks 1, 5; notice text → Task 5; two events and property rules → Task 3; 128-char cap → Task 3; forbidden names → Task 3 and Task 8; `~/.b4/usage-id` → Task 2; `B4_SIGNALS_URL` → Task 4; third dashboard → Task 8; changeset → Task 9; privacy anti-goal (no path/identity) → Tasks 3, 5, 7. The ingest route is deferred by the task brief and documented in Task 9.
- **Type consistency.** `RouteKind` is defined once in Task 3 and consumed by Tasks 5 and 7; `SignalsEmitter` methods are `commandStarted`, `commandCompleted`, `devFirstRunCompleted`, `flush` throughout; `FetchLike` is Task 4's and reused by Task 5.
- **Review Focus.** Each line names its pinning task.
- **Proportion.** Test code dominates the code blocks because tests are the spec's exact values; implementations are signatures.

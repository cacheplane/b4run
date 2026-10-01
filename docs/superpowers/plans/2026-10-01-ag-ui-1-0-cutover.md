# AG-UI 1.0 Cut-over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move B4.run from `@ag-ui/*` 0.0.59 to 1.0.1 and adopt the 1.0 wire semantics the spec names, so CopilotKit 1.76 works again and nothing B4.run sends is stripped by a 1.0 client.

**Architecture:** The wire format is nearly unchanged; the work is (a) manifests and schema imports, (b) five producer-side behaviors (`protocolVersion`, `metadata.grant`, `cancelled`, `pendingToolCallIds`, null discipline), (c) three inbound rules (`protocolVersion` major check, multimodal refusal, dropping reasoning history), and (d) a conformance test that drives the real 1.0 client pipeline with warnings-as-failures. Spec: `docs/superpowers/specs/2026-10-01-ag-ui-1-0-cutover-design.md`.

**Tech Stack:** pnpm workspace, TypeScript (NodeNext ESM; `src/` imports `.js`, `test/` imports `.ts`/`.js`), vitest, Biome (never bare `biome check --write`; use `pnpm lint:fix` or scope to files), Node 24 (`nvm use 24`), `@ag-ui/core|client|encoder` 1.0.1, CopilotKit 1.76.0.

---

## Before you start

- Branch `blove/agui-1-0-cutover` exists, cut from `main` at `216befd5a`, with the spec committed. Work on it. **Do not** branch from `blove/agui-capabilities` (PR #883); that PR rebases onto this one later.
- Always run commands from the repo root unless a step says otherwise.
- Build before running anything against `dist/` (`pnpm build`); CLI tests import `../../testing/dist/...`.
- `exactOptionalPropertyTypes` is on: never assign `{ x: undefined }` to an optional field; use conditional spreads.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Spec §5.3 (capabilities `transport.streaming`) is not in this plan.** `GET /agui/:routeId` lives on PR #883, which is not on this branch. Task 13 amends the spec to say so; #883 adds `transport: { streaming: true }` when it rebases.

## File structure

| File | Responsibility in this change |
|---|---|
| `packages/ag-ui/package.json`, `packages/cli/package.json`, `examples/{chat,research}/web/package.json`, `packages/devkit/templates/app-research/web/package.json.template`, `pnpm-lock.yaml` | Pins (Task 1) |
| `packages/devkit/test/template-copilotkit-dependencies.test.ts`, `test/security-dependencies/dependency-resolution.test.ts`, `test/security-dependencies/copilotkit-v2-runtime.test.ts` | Pin guards (Task 1) |
| `packages/ag-ui/src/client.ts`, `packages/cli/src/lib/dev/agui-handler.ts` | Schema import moves (Task 2) |
| `examples/research/web/app/lib/transcript.ts` (+ devkit mirror) | Tool-message content typing (Task 2) |
| `packages/ag-ui/src/outbound.ts` | `protocolVersion`, `cancelled`, `pendingToolCallIds` (Tasks 4, 8, 9) |
| `packages/ag-ui/src/interrupts.ts` | Grant channel (Task 5) |
| `packages/cli/src/lib/dev/run-envelope.ts` | `protocolVersion` major check, multimodal refusal (Tasks 6, 7) |
| `packages/ag-ui/src/inbound.ts` | `contentToText`, drop reasoning history (Task 7) |
| `packages/cli/src/lib/dev/client-tool-turn.ts` | `partial` carries the unanswered ids (Task 9) |
| `packages/ag-ui/test/conformance.test.ts` | Real-client conformance with warnings-as-failures (Task 11) |
| `.github/workflows/ci.yml`, `scripts/release/test/fixtures/workflow-entrypoints.json`, `workflow-safe-executables.json` | CopilotKit runtime test on CI (Task 12) |
| `apps/web/content/docs/{ag-ui,approval-grants,api/ag-ui}.mdx`, `packages/ag-ui/README.md`, `.changeset/agui-1-0-cutover.md` | Docs and release (Task 13) |

---

### Task 1: Pin `@ag-ui/*` 1.0.1 and CopilotKit 1.76.0, regenerate the lockfile, update the pin guards

**Files:**
- Modify: `packages/ag-ui/package.json`
- Modify: `packages/cli/package.json`
- Modify: `examples/chat/web/package.json`
- Modify: `examples/research/web/package.json`
- Modify: `packages/devkit/templates/app-research/web/package.json.template`
- Modify: `pnpm-lock.yaml` (generated)
- Modify: `packages/devkit/test/template-copilotkit-dependencies.test.ts`
- Modify: `test/security-dependencies/dependency-resolution.test.ts`
- Modify: `test/security-dependencies/copilotkit-v2-runtime.test.ts`

- [ ] **Step 1: Update the devkit template pin test first (it is the cheapest failing test)**

In `packages/devkit/test/template-copilotkit-dependencies.test.ts` replace the `toMatchObject` block:

```ts
    expect(manifest.dependencies).toMatchObject({
      "@ag-ui/client": "1.0.1",
      "@copilotkit/react-core": "1.76.0",
      "@copilotkit/runtime": "1.76.0",
    })
```

- [ ] **Step 2: Run it to confirm it fails against the old template**

Run: `cd packages/devkit && pnpm exec vitest run test/template-copilotkit-dependencies.test.ts; cd ../..`
Expected: FAIL (`expected "0.0.59" ... "1.0.1"`).

- [ ] **Step 3: Edit the five manifests**

`packages/ag-ui/package.json` — in `dependencies`:
```json
    "@ag-ui/core": "1.0.1",
    "@ag-ui/encoder": "1.0.1",
```
in `peerDependencies` (keep the other two peers):
```json
    "@ag-ui/client": ">=1.0.1 <2.0.0",
```
in `devDependencies`:
```json
    "@ag-ui/client": "1.0.1",
    "@copilotkit/react-core": "1.76.0",
```

`packages/cli/package.json` — in `dependencies`:
```json
    "@ag-ui/core": "1.0.1",
```

`examples/chat/web/package.json`, `examples/research/web/package.json` and `packages/devkit/templates/app-research/web/package.json.template` — in `dependencies`:
```json
    "@ag-ui/client": "1.0.1",
    "@copilotkit/react-core": "1.76.0",
    "@copilotkit/runtime": "1.76.0",
```

- [ ] **Step 4: Regenerate the lockfile and confirm one `@ag-ui/client` copy**

Run:
```bash
pnpm install
```
Expected: completes; `pnpm-lock.yaml` changes. Then:
```bash
grep -oE "'?@ag-ui/client@[0-9.]+" pnpm-lock.yaml | sort | uniq -c
```
Expected: `1.0.1` entries and possibly a legacy `0.0.54` (pre-existing, isolated); **no** `0.0.59`.

- [ ] **Step 5: Re-run the template pin test**

Run: `cd packages/devkit && pnpm exec vitest run test/template-copilotkit-dependencies.test.ts; cd ../..`
Expected: PASS.

- [ ] **Step 6: Update `test/security-dependencies/dependency-resolution.test.ts`**

Apply these exact substitutions (the file pins versions in ~20 places; `sed` keeps them consistent):

```bash
sed -i '' \
  -e 's/"\^1\.70\.0"/"1.76.0"/g' \
  -e 's/"1\.70\.0"/"1.76.0"/g' \
  -e 's/candidate === "1\.70\.0"/candidate === "1.76.0"/' \
  -e 's/"0\.0\.59"/"1.0.1"/g' \
  -e 's/contains only CopilotKit 1\.70\.0 package identities/contains only CopilotKit 1.76.0 package identities/' \
  -e 's/keeps direct AG-UI on 0\.0\.59 and isolates any legacy 0\.0\.54/keeps direct AG-UI on 1.0.1 and isolates any legacy 0.0.54/' \
  test/security-dependencies/dependency-resolution.test.ts
grep -n '1\.70\|0\.0\.59' test/security-dependencies/dependency-resolution.test.ts
```
Expected: the final `grep` prints nothing.

The `@copilotkit/react-core` peer assertion `">=1.66.0"` on `packages/ag-ui` stays as is.

- [ ] **Step 7: Update the CopilotKit runtime test's version assertion**

In `test/security-dependencies/copilotkit-v2-runtime.test.ts`, in the `/info` expectation, change `version: "1.70.0"` to `version: "1.76.0"`.

- [ ] **Step 8: Run the two security-dependency tests**

Run:
```bash
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts
```
Expected: PASS. (The CopilotKit runtime test needs the example route modules to compile, which Task 2 fixes; run it there.)

- [ ] **Step 9: Commit**

```bash
git add packages/ag-ui/package.json packages/cli/package.json examples/chat/web/package.json examples/research/web/package.json packages/devkit/templates/app-research/web/package.json.template pnpm-lock.yaml packages/devkit/test/template-copilotkit-dependencies.test.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/copilotkit-v2-runtime.test.ts
git commit -m "chore(deps): move to @ag-ui 1.0.1 and CopilotKit 1.76.0 with exact pins

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Move validators to `@ag-ui/core/schemas`; widen tool-message content in the research example

**Files:**
- Modify: `packages/ag-ui/src/client.ts:1-2`
- Modify: `packages/cli/src/lib/dev/agui-handler.ts:2`
- Modify: `packages/ag-ui/test/conformance.test.ts:3`, `packages/ag-ui/test/outbound.test.ts:1`, `packages/ag-ui/test/activities.test.ts:1`
- Modify: `examples/research/web/app/lib/transcript.ts`
- Modify: `packages/devkit/templates/app-research/web/app/lib/transcript.ts` (byte-identical mirror)

- [ ] **Step 1: Build to see the compiler's view**

Run: `pnpm build 2>&1 | grep -E 'error TS|Cannot find' | head -20`
Expected: errors naming `AgentCapabilitiesSchema` / `RunAgentInputSchema` not exported from `@ag-ui/core`.

- [ ] **Step 2: Move the two source imports**

`packages/ag-ui/src/client.ts` lines 1–2 become:
```ts
import { HttpAgent } from "@ag-ui/client"
import type { AgentCapabilities } from "@ag-ui/core"
import { AgentCapabilitiesSchema } from "@ag-ui/core/schemas"
```

`packages/cli/src/lib/dev/agui-handler.ts` line 2 becomes:
```ts
import { RunAgentInputSchema } from "@ag-ui/core/schemas"
```

- [ ] **Step 3: Move the test imports**

`packages/ag-ui/test/conformance.test.ts` line 3 becomes two lines:
```ts
import { EventType, type RunAgentInput } from "@ag-ui/core"
import { ActivitySnapshotEventSchema } from "@ag-ui/core/schemas"
```
`packages/ag-ui/test/outbound.test.ts` line 1 becomes:
```ts
import { EventType } from "@ag-ui/core"
import { ActivitySnapshotEventSchema, ToolCallResultEventSchema } from "@ag-ui/core/schemas"
```
`packages/ag-ui/test/activities.test.ts` line 1: move `ActivitySnapshotEventSchema` to a `@ag-ui/core/schemas` import the same way, leaving any type/value imports that remain on `@ag-ui/core`.

- [ ] **Step 4: Build and typecheck the workspace**

Run: `pnpm build 2>&1 | tail -5 && pnpm typecheck 2>&1 | grep -E 'error TS' | head -20`
Expected: build succeeds. Typecheck reports errors only under `examples/research/web` (and nothing else; if `packages/*` reports an error, fix it before continuing).

- [ ] **Step 5: Widen `ToolResultMessage.content` in the research example**

In `examples/research/web/app/lib/transcript.ts`, replace the `ToolResultMessage` interface and add a helper next to `userText`:

```ts
/** A tool result. Structurally the `ToolMessage` `useRenderToolCall` wants. */
export interface ToolResultMessage {
  readonly id: string
  readonly role: "tool"
  /**
   * AG-UI 1.0 widens tool content to `string | ContentPart[]`. Typed `unknown`
   * so this union stays a supertype of the installed client's `Message`;
   * `toolResultText` below does the narrowing.
   */
  readonly content: unknown
  readonly toolCallId: string
}
```

```ts
/**
 * A tool result's displayable text. A part list contributes its text parts
 * in order; media parts have no text and are skipped here (this app does not
 * render tool media).
 */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
}
```

- [ ] **Step 6: Route every consumer of a tool result's `content` through `toolResultText`**

Run: `grep -rn 'toolResult' examples/research/web/app --include='*.ts' --include='*.tsx' | grep -v test | grep -n 'content'`
For each site that reads `.content` off a `ToolResultMessage` as a string, wrap it: `toolResultText(toolResult.content)`. Then:

Run: `pnpm --filter @b4-example/research-web typecheck`
Expected: PASS. (`AppShell.tsx:633`'s `Message[]` → `TranscriptMessage[]` assignment compiles because `content: unknown` is a supertype again.)

- [ ] **Step 7: Mirror the file into the devkit template**

```bash
cp examples/research/web/app/lib/transcript.ts packages/devkit/templates/app-research/web/app/lib/transcript.ts
git diff --stat examples/research/web/app packages/devkit/templates/app-research/web/app
```
Expected: every example file you changed has a changed template twin. If you touched any other file under `examples/research/web/app`, copy it to the same path under `packages/devkit/templates/app-research/web/app/`.

- [ ] **Step 8: Run the affected suites**

```bash
pnpm typecheck 2>&1 | tail -3
pnpm --filter @b4run/ag-ui test 2>&1 | grep -E 'Tests |FAIL'
pnpm --filter @b4-example/research-web test 2>&1 | grep -E 'Tests |FAIL'
cd packages/devkit && pnpm exec vitest run test/templates.test.ts 2>&1 | grep -E 'Tests |FAIL'; cd ../..
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/copilotkit-v2-runtime.test.ts 2>&1 | grep -E 'Tests |FAIL'
```
Expected: all PASS. The last one proves the nominal-type error is gone: the example route modules compile against CopilotKit 1.76 and `/info` reports capabilities.

- [ ] **Step 9: Commit**

```bash
git add -A packages/ag-ui/src packages/ag-ui/test packages/cli/src/lib/dev/agui-handler.ts examples/research/web/app packages/devkit/templates/app-research/web/app
git commit -m "fix(ag-ui): import validators from @ag-ui/core/schemas; widen tool content in the research example

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Loose parsing — drop the strip assumption, prove unknown keys are tolerated and not echoed

**Files:**
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (comment near the `RunAgentInputSchema.safeParse` call, around line 447)
- Test: `packages/cli/test/agui-run-envelope.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/agui-run-envelope.test.ts` (it already has `setup`, `aguiPost`, `drain`, `HELLO_ROUTE`):

```ts
describe("unknown top-level envelope keys", () => {
  it("are tolerated by the loose 1.0 schema and never echoed", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        messages: [{ id: "1", role: "user", content: "hello" }],
        someFutureField: { secret: "do-not-echo" },
      }),
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"type":"RUN_STARTED"')
    expect(text).not.toContain("someFutureField")
    expect(text).not.toContain("do-not-echo")
  })
})
```

- [ ] **Step 2: Run it**

Run: `cd packages/cli && pnpm exec vitest run test/agui-run-envelope.test.ts -t "unknown top-level"; cd ../..`
Expected: PASS already (the handler reads named fields only). This test exists to pin the property; keep it.

- [ ] **Step 3: Fix the comment that claims the schema strips**

In `agui-handler.ts`, find the comment block above `readResponseFormat(parsedJson)` that says the key is read off the ORIGINAL JSON "because `RunAgentInputSchema` strips the key" and rewrite that sentence to:

```ts
    // The client's response schema (Hashbrown's `hashbrown.responseSchema`),
    // read off the ORIGINAL JSON: it is not a RunAgentInput field, and the
    // handler judges what the client sent, not the parsed projection of it.
```
Search the file for any other `strip` wording about the zod parse (`grep -n 'strip' packages/cli/src/lib/dev/agui-handler.ts`) and correct each the same way; the 1.0 schemas are loose.

- [ ] **Step 4: Lint and commit**

```bash
cd packages/cli && pnpm lint 2>&1 | tail -2; cd ../..
git add packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/agui-run-envelope.test.ts
git commit -m "test(cli): pin that unknown AG-UI envelope keys are tolerated and not echoed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `RUN_STARTED.protocolVersion`

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts`
- Test: `packages/ag-ui/test/outbound.test.ts`, `packages/ag-ui/test/sse.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/ag-ui/test/outbound.test.ts`, add `PROTOCOL_VERSION` to the `@ag-ui/core` import and add, inside `describe("toAguiEvents")`:

```ts
  test("RUN_STARTED declares the producer's protocol version", async () => {
    const [first] = await collect([{ type: "done", data: {} }])
    expect(first).toEqual({
      type: EventType.RUN_STARTED,
      threadId: "th-1",
      runId: "rn-1",
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(PROTOCOL_VERSION).toBe("1.0")
  })
```

- [ ] **Step 2: Run it**

Run: `cd packages/ag-ui && pnpm exec vitest run test/outbound.test.ts -t "protocol version"; cd ../..`
Expected: FAIL (no `protocolVersion`).

- [ ] **Step 3: Emit it**

In `packages/ag-ui/src/outbound.ts`, change the `@ag-ui/core` value import to `import { EventType, PROTOCOL_VERSION } from "@ag-ui/core"` and the first yield to:

```ts
  // The producer's own version, never an echo of the input's (spec: versioning).
  yield {
    type: EventType.RUN_STARTED,
    threadId: ctx.threadId,
    runId: ctx.runId,
    protocolVersion: PROTOCOL_VERSION,
  }
```

- [ ] **Step 4: Update the five exact `RUN_STARTED` expectations**

```bash
sed -i '' 's/{ type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1" }/{ type: EventType.RUN_STARTED, threadId: "th-1", runId: "rn-1", protocolVersion: PROTOCOL_VERSION }/' packages/ag-ui/test/outbound.test.ts
grep -c 'protocolVersion: PROTOCOL_VERSION' packages/ag-ui/test/outbound.test.ts
```
Expected: `6` (five replaced + the new test).

- [ ] **Step 5: Run the package tests and the CLI tests that read RUN_STARTED**

```bash
cd packages/ag-ui && pnpm exec vitest run 2>&1 | grep -E 'Tests |FAIL'; cd ../..
grep -rln 'RUN_STARTED' packages/cli/test | xargs -I{} sh -c 'cd packages/cli && pnpm exec vitest run ../../{} 2>&1 | grep -E "FAIL|Tests "' 
```
Expected: all PASS (CLI tests compare event types, not whole objects). Fix any exact-object assertion by adding `protocolVersion: "1.0"`.

- [ ] **Step 6: Commit**

```bash
git add packages/ag-ui/src/outbound.ts packages/ag-ui/test/outbound.test.ts
git commit -m "feat(ag-ui): declare the protocol version on RUN_STARTED

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The approval grant travels in `metadata.grant` only

**Files:**
- Modify: `packages/ag-ui/src/interrupts.ts`
- Test: `packages/ag-ui/test/interrupts.test.ts:133-186`
- Test: `packages/cli/test/approval-grants-agent-route.test.ts` (new AG-UI resume cases)

- [ ] **Step 1: Rewrite the two grant describes in `packages/ag-ui/test/interrupts.test.ts`**

Replace the blocks `describe("toAguiInterrupt — approval grants", …)` and `describe("fromAguiResume — approval grants", …)` with:

```ts
describe("toAguiInterrupt — approval grants", () => {
  const envelope = {
    interruptId: "perm-1",
    kind: "tool",
    callId: "call_deploy_0_0",
    grant: "b4ag_abc",
  }

  test("keeps the grant in metadata only: the top-level field is one 1.0 clients strip", () => {
    const interrupt = toAguiInterrupt(envelope)
    if (interrupt === null) throw new Error("expected an interrupt")
    expect(Object.hasOwn(interrupt, "grant")).toBe(false)
    expect((interrupt.metadata as { grant?: string }).grant).toBe("b4ag_abc")
  })
})

describe("fromAguiResume — approval grants", () => {
  test("reads the grant from the entry's metadata", () => {
    const [resume] = fromAguiResume([
      {
        interruptId: "perm-1",
        status: "resolved",
        payload: "once",
        metadata: { grant: "b4ag_abc" },
      },
    ])
    expect(resume).toEqual({
      interruptId: "perm-1",
      status: "resolved",
      payload: "once",
      grant: "b4ag_abc",
    })
  })

  test("does not read a top-level grant: a 1.0 client never sends one", () => {
    const [resume] = fromAguiResume([
      { interruptId: "perm-1", status: "resolved", payload: "once", grant: "b4ag_abc" } as never,
    ])
    expect(Object.hasOwn(resume, "grant")).toBe(false)
  })

  test("drops a non-string metadata grant — an opaque echo is not a JSON channel", () => {
    const [resume] = fromAguiResume([
      { interruptId: "perm-1", status: "cancelled", metadata: { grant: { evil: true } } },
    ])
    expect(Object.hasOwn(resume, "grant")).toBe(false)
  })
})
```

- [ ] **Step 2: Run them**

Run: `cd packages/ag-ui && pnpm exec vitest run test/interrupts.test.ts; cd ../..`
Expected: the three new/changed tests FAIL.

- [ ] **Step 3: Change `interrupts.ts`**

Replace the `B4AguiInterrupt` type and its doc comment with:

```ts
/**
 * AG-UI's `Interrupt`, as B4.run emits it. The single-use approval grant,
 * when the runtime minted one, is at `metadata.grant` — and only there.
 * `metadata` is schema-defined on `Interrupt`, so it survives a 1.0 client's
 * enforcement stage; a top-level `grant` would be stripped with a warning
 * on every prompt.
 *
 * The grant is deliberately RE-READABLE: a client that reattaches after a
 * reload must be able to get it again. Single-use is a property of
 * CONSUMPTION, not of disclosure.
 */
export type B4AguiInterrupt = Interrupt
```

In `toAguiInterrupt`, delete the long comment block that starts "The single-use approval grant is ALSO surfaced" through the `const grant = …` line, and remove `...(grant !== undefined ? { grant } : {}),` from the returned object. The return is:

```ts
  return {
    id: interruptId,
    reason,
    ...(typeof env.message === "string" ? { message: env.message } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    metadata: env,
  }
```

Replace `fromAguiResume` with:

```ts
/**
 * Map AG-UI resume entries to B4.run resume requests. Vocabulary-agnostic: the
 * consumer decides how a `{ status, payload }` becomes B4.run's per-interrupt
 * decision. We only guarantee `interruptId` survives.
 *
 * The approval grant is read from `metadata.grant`, the schema-defined channel
 * a 1.0 client leaves intact; `HttpAgent` strips unknown top-level keys from
 * the outgoing input, so a top-level `grant` never arrives and is not read.
 */
export function fromAguiResume(
  resume: ReadonlyArray<{
    interruptId: string
    status: "resolved" | "cancelled"
    payload?: unknown
    metadata?: Readonly<Record<string, unknown>> | undefined
  }>,
): B4ResumeRequest[] {
  return resume.map((entry) => {
    const grant = entry.metadata?.grant
    return {
      interruptId: entry.interruptId,
      status: entry.status,
      ...(Object.hasOwn(entry, "payload") ? { payload: entry.payload } : {}),
      // Forwarded only when it is a string: an opaque echo must not become a
      // channel for arbitrary JSON on its way to the grant check.
      ...(typeof grant === "string" ? { grant } : {}),
    }
  })
}
```

Update the `B4ResumeRequest.grant` doc comment's last paragraph to: `Read from the AG-UI entry's \`metadata.grant\`; see \`fromAguiResume\`.`

- [ ] **Step 4: Run the package tests**

Run: `cd packages/ag-ui && pnpm exec vitest run 2>&1 | grep -E 'Tests |FAIL'; cd ../..`
Expected: PASS.

- [ ] **Step 5: Write the CLI test — an AG-UI resume carrying `metadata.grant` is consumed; a top-level grant is not read**

`packages/cli/test/approval-grants-agent-route.test.ts` already has `withAimock`, `fixtureApp("required")`, `createHandler`, `park`, `pending`, `deploys`, `resume` (Agent Protocol) and `errorCode`. Add this helper beside `resume`:

```ts
/** Resume over AG-UI. `entry` is the AG-UI ResumeEntry as the client would send it. */
async function aguiResume(
  handler: Awaited<ReturnType<typeof createHandler>>,
  threadId: string,
  entry: Record<string, unknown>,
): Promise<Response> {
  return handler.fetch(
    new Request(`http://localhost/agui/${encodeURIComponent("/park#agent")}`, {
      body: JSON.stringify({
        context: [],
        forwardedProps: {},
        messages: [{ id: "u1", role: "user", content: "deploy to staging" }],
        resume: [entry],
        runId: `agui-${threadId}-resume`,
        state: {},
        threadId,
        tools: [],
      }),
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      method: "POST",
    }),
  )
}
```

and these cases inside the existing `describe`:

```ts
  it("consumes a grant sent in the AG-UI entry's metadata", async () => {
    await withAimock()
    const { appRoot, ledger } = await fixtureApp("required")
    const handler = await createHandler(appRoot)
    const threadId = "t-grant-agui-metadata"

    await park(handler, threadId)
    const [parked] = await pending(handler, threadId)
    const response = await aguiResume(handler, threadId, {
      interruptId: parked?.interruptId,
      status: "resolved",
      payload: "once",
      metadata: { grant: parked?.grant },
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(await deploys(ledger)).toEqual(["staging"])
  })

  it("does not read a top-level grant on an AG-UI entry: under required it is grant_required", async () => {
    await withAimock()
    const { appRoot, ledger } = await fixtureApp("required")
    const handler = await createHandler(appRoot)
    const threadId = "t-grant-agui-toplevel"

    await park(handler, threadId)
    const [parked] = await pending(handler, threadId)
    const response = await aguiResume(handler, threadId, {
      interruptId: parked?.interruptId,
      status: "resolved",
      payload: "once",
      grant: parked?.grant,
    })
    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe("grant_required")
    expect(await deploys(ledger)).toEqual([])
  })
```

- [ ] **Step 6: Run them**

Run: `pnpm build >/dev/null && cd packages/cli && pnpm exec vitest run test/approval-grants-agent-route.test.ts; cd ../..`
Expected: PASS (the `metadata` case passes because of Step 3; the top-level case passes because it is no longer read). If `errorCode` returns a different code for the missing grant, read `packages/cli/src/lib/dev/approval-grants.ts` — `grant_required` is the `"required"`-mode answer to an entry with no grant — and check the fixture is in `"required"` mode.

- [ ] **Step 7: Grep for other readers of a top-level AG-UI grant**

```bash
grep -rn '\.grant\b' packages/ag-ui/src packages/ag-ui/test examples/chat/web/app examples/research/web/app packages/devkit/templates --include='*.ts' --include='*.tsx' | grep -v 'metadata' | grep -v node_modules
```
Expected: nothing outside what you just edited. (The Agent Protocol endpoints `GET /threads/:id/pending_interrupts`, the attach `state` frame and `POST /threads/:id/resume` keep their top-level `grant`; they are B4.run's own wire and are not AG-UI.)

- [ ] **Step 8: Run the wider CLI suites that touch grants, then commit**

```bash
cd packages/cli && pnpm exec vitest run test/approval-grants-endpoint.test.ts test/agui-client-tools.test.ts test/pending-interrupts-endpoint.test.ts test/client-tool-park-visibility.test.ts 2>&1 | grep -E 'Tests |FAIL'; cd ../..
git add packages/ag-ui/src/interrupts.ts packages/ag-ui/test/interrupts.test.ts packages/cli/test/approval-grants-agent-route.test.ts
git commit -m "feat(ag-ui)!: carry the approval grant in metadata.grant only

A 1.0 client strips a top-level grant from interrupts it receives and from
resume entries it sends; metadata is schema-defined in both directions.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Refuse a foreign protocol major before any side effect

**Files:**
- Modify: `packages/cli/src/lib/dev/run-envelope.ts`
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (the envelope rejection response uses the rejection's status)
- Test: `packages/cli/test/agui-run-envelope.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/agui-run-envelope.test.ts`:

```ts
describe("protocolVersion", () => {
  const policy = resolveRunEnvelopePolicy(undefined, "/hello")
  const base = { threadId: "t", runId: "r", messages: [] }

  it.each([undefined, "1.0", "1.7"])("serves %s", (protocolVersion) => {
    expect(
      validateRunEnvelope(
        protocolVersion === undefined ? base : { ...base, protocolVersion },
        policy,
      ),
    ).toBeUndefined()
  })

  it("serves an unparseable declaration (rejection is reserved for a known foreign major)", () => {
    expect(validateRunEnvelope({ ...base, protocolVersion: "garbage" }, policy)).toBeUndefined()
  })

  it("refuses a foreign major with 400 unsupported_protocol_version", () => {
    expect(validateRunEnvelope({ ...base, protocolVersion: "2.0" }, policy)).toMatchObject({
      code: "unsupported_protocol_version",
      status: 400,
    })
  })

  it("refuses over HTTP before middleware runs", async () => {
    let middlewareRan = false
    const { handler } = await setup({
      middleware: () => {
        middlewareRan = true
        return { action: "continue" }
      },
    })
    const response = await handler.fetch(aguiPost(HELLO_ROUTE, { protocolVersion: "2.0" }))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe("unsupported_protocol_version")
    expect(middlewareRan).toBe(false)
  })
})
```

- [ ] **Step 2: Run them**

Run: `cd packages/cli && pnpm exec vitest run test/agui-run-envelope.test.ts -t protocolVersion; cd ../..`
Expected: the two "refuses" cases FAIL.

- [ ] **Step 3: Implement in `run-envelope.ts`**

Add the import at the top (the module stays pure; `@ag-ui/core`'s main entry is zod-free):

```ts
import { PROTOCOL_VERSION } from "@ag-ui/core"
```

Extend the code union and the rejection type:

```ts
export type RunEnvelopeRejectionCode =
  | "invalid_envelope"
  | "invalid_thread_id"
  | "invalid_run_id"
  | "invalid_state"
  | "client_tools_not_allowed"
  | "forwarded_props_not_allowed"
  | "unsupported_protocol_version"

export interface RunEnvelopeRejection {
  readonly code: RunEnvelopeRejectionCode
  readonly message: string
  /** 422 for a malformed or over-reaching envelope; 400 for a protocol this runtime does not speak. */
  readonly status: 422 | 400
}
```

Add above `validateRunEnvelope`:

```ts
/** The protocol major this runtime implements, from the SDK's own constant. */
const PROTOCOL_MAJOR = PROTOCOL_VERSION.split(".")[0] ?? PROTOCOL_VERSION

/**
 * The spec's versioning rule for a producer: a consumer declaring a newer
 * minor of a line this runtime implements MUST be served; only a recognised
 * foreign major may be refused, and only before RUN_STARTED. An absent or
 * unparseable declaration is served — rejection is reserved for a version
 * this runtime can read and knows it does not speak.
 */
function foreignProtocolMajor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const match = /^(\d+)\.\d+$/.exec(value)
  if (!match) return undefined
  return match[1] === PROTOCOL_MAJOR ? undefined : match[1]
}
```

In `validateRunEnvelope`, immediately after the `invalid_run_id` check:

```ts
  const foreignMajor = foreignProtocolMajor(body.protocolVersion)
  if (foreignMajor !== undefined) {
    return {
      code: "unsupported_protocol_version",
      message: `This runtime speaks AG-UI protocol ${PROTOCOL_VERSION}; the request declared major ${foreignMajor}.`,
      status: 400,
    }
  }
```

- [ ] **Step 4: Confirm the handler forwards the rejection's status**

In `agui-handler.ts` the envelope rejection response is built with `{ status: envelopeRejection.status }` — it already uses the rejection's own status, so a 400 flows through. Verify with `grep -n 'envelopeRejection.status' packages/cli/src/lib/dev/agui-handler.ts` (one hit).

- [ ] **Step 5: Run, lint, commit**

```bash
cd packages/cli && pnpm exec vitest run test/agui-run-envelope.test.ts 2>&1 | grep -E 'Tests |FAIL' && pnpm lint 2>&1 | tail -1; cd ../..
git add packages/cli/src/lib/dev/run-envelope.ts packages/cli/test/agui-run-envelope.test.ts
git commit -m "feat(cli): refuse a foreign AG-UI protocol major before any side effect

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Inbound content — text parts concatenate, media is refused, reasoning history is dropped

**Files:**
- Modify: `packages/ag-ui/src/inbound.ts`
- Modify: `packages/cli/src/lib/dev/run-envelope.ts`
- Test: `packages/ag-ui/test/inbound.test.ts`, `packages/cli/test/agui-run-envelope.test.ts`

- [ ] **Step 1: Write the failing `inbound` tests**

Append to `packages/ag-ui/test/inbound.test.ts` (it imports `fromRunAgentInput`; add `import type { RunAgentInput } from "@ag-ui/core"` if absent):

```ts
describe("1.0 content", () => {
  const input = (messages: RunAgentInput["messages"]): RunAgentInput => ({
    threadId: "t",
    runId: "r",
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  })

  test("a user message's text parts concatenate in order", () => {
    const { messages } = fromRunAgentInput(
      input([
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "Hello, " },
            { type: "text", text: "world" },
          ],
        },
      ]),
    )
    expect(messages).toEqual([{ id: "1", role: "user", content: "Hello, world" }])
  })

  test("a tool message's text parts concatenate in order", () => {
    const { messages } = fromRunAgentInput(
      input([
        {
          id: "2",
          role: "tool",
          toolCallId: "c1",
          content: [{ type: "text", text: "{\"ok\":" }, { type: "text", text: "true}" }],
        },
      ]),
    )
    expect(messages).toEqual([
      { id: "2", role: "tool", toolCallId: "c1", content: '{"ok":true}' },
    ])
  })

  test("reasoning and activity history is dropped, not re-spoken as the assistant", () => {
    const { messages } = fromRunAgentInput(
      input([
        { id: "3", role: "reasoning", content: "thinking…" },
        { id: "4", role: "activity", activityType: "b4.plan", content: { todos: [] } },
        { id: "5", role: "assistant", content: "done" },
      ]),
    )
    expect(messages).toEqual([{ id: "5", role: "assistant", content: "done" }])
  })
})
```

- [ ] **Step 2: Run them**

Run: `cd packages/ag-ui && pnpm exec vitest run test/inbound.test.ts; cd ../..`
Expected: the three new tests FAIL (parts are JSON-stringified; reasoning is mapped to assistant).

- [ ] **Step 3: Implement `inbound.ts`**

Replace `coerceContent` and `toB4Message`, and the mapping in `fromRunAgentInput`:

```ts
import { contentToText, type Message, type RunAgentInput } from "@ag-ui/core"
```

```ts
/**
 * A message's text. 1.0 content is `string | ContentPart[]`; the text parts
 * concatenate in order via the SDK's own helper. Media parts never reach here:
 * the runtime refuses them at the envelope stage (`multimodal_not_supported`)
 * until it can carry them to the model.
 */
function coerceContent(content: unknown): string {
  if (typeof content === "string") return content
  if (content === undefined || content === null) return ""
  if (Array.isArray(content)) return contentToText(content as Parameters<typeof contentToText>[0])
  try {
    const json = JSON.stringify(content)
    return typeof json === "string" ? json : String(content)
  } catch {
    return String(content)
  }
}

/**
 * `null` for history that is not conversation: a `reasoning` message is the
 * client's stored artefact of an earlier turn, and an `activity` message is a
 * progress snapshot. Neither is something the assistant said, so neither is
 * replayed to the model as if it were.
 */
function toB4Message(message: Message): B4Message | null {
  switch (message.role) {
    case "tool":
      return toB4ToolMessage(message, coerceContent(message.content))
    case "user":
    case "assistant":
    case "system":
    case "developer":
      return { role: message.role, content: coerceContent(message.content), id: message.id }
    case "activity":
    case "reasoning":
      return null
  }
}
```

```ts
export function fromRunAgentInput(input: RunAgentInput): B4RunInput {
  const messages = input.messages.flatMap((message) => {
    const mapped = toB4Message(message)
    return mapped === null ? [] : [mapped]
  })
  const resume = input.resume && input.resume.length > 0 ? fromAguiResume(input.resume) : undefined
  return { messages, ...(resume ? { resume } : {}), raw: input }
}
```

Run: `cd packages/ag-ui && pnpm exec vitest run test/inbound.test.ts 2>&1 | grep -E 'Tests |FAIL'; cd ../..` → PASS. (If an existing test asserted the old reasoning→assistant mapping, update it to expect the drop and cite this task.)

- [ ] **Step 4: Write the failing envelope tests for media**

Append to `packages/cli/test/agui-run-envelope.test.ts`:

```ts
describe("multimodal input", () => {
  const image = { type: "image", source: { type: "url", value: "https://example.test/a.png" } }

  it("refuses a message carrying a media part with 422 multimodal_not_supported, before middleware", async () => {
    let middlewareRan = false
    const { handler } = await setup({
      middleware: () => {
        middlewareRan = true
        return { action: "continue" }
      },
    })
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        messages: [{ id: "1", role: "user", content: [{ type: "text", text: "see" }, image] }],
      }),
    )
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe("multimodal_not_supported")
    expect(middlewareRan).toBe(false)
  })

  it("serves text-only parts", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        messages: [{ id: "1", role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    )
    expect(response.status).toBe(200)
    await drain(response)
  })
})
```

Run: `cd packages/cli && pnpm exec vitest run test/agui-run-envelope.test.ts -t multimodal; cd ../..` → the first FAILS.

- [ ] **Step 5: Implement the envelope check**

In `run-envelope.ts`, add `"multimodal_not_supported"` to `RunEnvelopeRejectionCode`, add this helper:

```ts
const MEDIA_PART_TYPES: ReadonlySet<string> = new Set(["image", "audio", "video", "document"])

/**
 * Whether any message's content carries a media part. Judged on the raw JSON
 * (a part is any object whose `type` names a media kind); malformed messages
 * are left for the schema parse to reject with its own message.
 */
function carriesMediaPart(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (isRecord(part) && typeof part.type === "string" && MEDIA_PART_TYPES.has(part.type)) {
        return true
      }
    }
  }
  return false
}
```

and, in `validateRunEnvelope` after the `invalid_state` check:

```ts
  // Refused rather than dropped: a client gets no other signal that its
  // image never reached the model. Text parts are served (`contentToText`).
  if (carriesMediaPart(body.messages)) {
    return reject(
      "multimodal_not_supported",
      "This runtime does not yet accept image, audio, video or document content parts; send text.",
    )
  }
```

Run: `cd packages/cli && pnpm exec vitest run test/agui-run-envelope.test.ts 2>&1 | grep -E 'Tests |FAIL'; cd ../..` → PASS.

- [ ] **Step 6: Lint and commit**

```bash
pnpm --filter @b4run/ag-ui lint 2>&1 | tail -1; cd packages/cli && pnpm lint 2>&1 | tail -1; cd ../..
git add packages/ag-ui/src/inbound.ts packages/ag-ui/test/inbound.test.ts packages/cli/src/lib/dev/run-envelope.ts packages/cli/test/agui-run-envelope.test.ts
git commit -m "feat(ag-ui): read 1.0 content parts as text, refuse media, drop reasoning history

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `RUN_FINISHED { outcome: cancelled }` for cancel and shutdown

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts` (`ToAguiOptions`, the `catch`)
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (the `toAguiEvents` call and the AP terminal projection, ~lines 1178–1195)
- Test: `packages/ag-ui/test/outbound.test.ts`, `packages/cli/test/run-cancellation.test.ts`

- [ ] **Step 1: Write the failing translator test**

Append inside `describe("toAguiEvents")` in `packages/ag-ui/test/outbound.test.ts`:

```ts
  test("an abort the consumer reports as a cancel ends the run with the cancelled outcome", async () => {
    async function* aborted(): AsyncGenerator<B4AgentStreamChunk> {
      yield { type: "token", data: "partial" }
      throw new Error("AG-UI request aborted")
    }
    const out = []
    for await (const ev of toAguiEvents(
      aborted(),
      CTX,
      { idFactory: createCounterIdFactory(), cancelled: () => true },
    )) {
      out.push(ev)
    }
    expect(out.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(out.at(-1)).toMatchObject({ outcome: { type: "cancelled" } })
    expect(out.at(-1)).not.toHaveProperty("result")
  })

  test("an abort the consumer does not report as a cancel is still RUN_ERROR", async () => {
    async function* aborted(): AsyncGenerator<B4AgentStreamChunk> {
      throw new Error("AG-UI request aborted")
    }
    const out = []
    for await (const ev of toAguiEvents(aborted(), CTX, { cancelled: () => false })) out.push(ev)
    expect(out.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: "AG-UI request aborted" })
  })
```

Run: `cd packages/ag-ui && pnpm exec vitest run test/outbound.test.ts -t "cancel"; cd ../..` → the first FAILS (type error / RUN_ERROR).

- [ ] **Step 2: Implement in `outbound.ts`**

```ts
export interface ToAguiOptions {
  readonly idFactory?: IdFactory
  /**
   * Asked once, when the upstream stream throws: `true` means whoever was
   * running the turn stopped it (a cancel endpoint, a server shutdown), and
   * the run ends `RUN_FINISHED { outcome: cancelled }` — stopped, not failed,
   * nothing to resume. `false` or absent: the throw is a failure, `RUN_ERROR`.
   */
  readonly cancelled?: () => boolean
}
```

In the `catch (err)` block, after `yield* ledger.settle()` and before the `code` computation:

```ts
    if (options.cancelled?.() === true) {
      yield {
        type: EventType.RUN_FINISHED,
        threadId: ctx.threadId,
        runId: ctx.runId,
        outcome: { type: "cancelled" },
      }
      return
    }
```

Run the two tests → PASS.

- [ ] **Step 3: Wire the handler**

In `agui-handler.ts`, the `toAguiEvents(normalizeB4Stream(...), { threadId, runId: input.runId })` call becomes:

```ts
            for await (const event of toAguiEvents(
              normalizeB4Stream(liveTappedStream, clientToolNames),
              { threadId, runId: input.runId },
              {
                // A cancel endpoint or a server shutdown stopped the turn; a
                // client disconnect did not (nobody is listening for the
                // frame, and attachers read the same terminal below).
                cancelled: () => run.cancelled || shutdownSignal.aborted,
              },
            )) {
```

and the AP terminal projection just inside that loop becomes:

```ts
              // The translator catches upstream errors and aborts, so the raw
              // stream may never produce a terminal chunk. Preserve the
              // outcome for AP viewers instead of reporting null success.
              if (terminalChunk === undefined) {
                if (event.type === "RUN_ERROR") {
                  terminalChunk = { type: "done", output: { error: event.message } }
                } else if (event.type === "RUN_FINISHED" && event.outcome?.type === "cancelled") {
                  terminalChunk = { type: "done", output: { cancelled: true } }
                }
              }
```

- [ ] **Step 4: Write the failing handler test**

In `packages/cli/test/run-cancellation.test.ts`, add a route to the `files` map inside `setupBlockingRoute` (find `"src/app/other/index.ts": OTHER_ROUTE` there and add a sibling):

```ts
    "src/app/sleepy/index.ts": SLEEPY_ROUTE,
```
with, near the other route constants:

```ts
// A route that sleeps long enough for a cancel to land, then returns. Used
// by the AG-UI cancelled-outcome test; AG-UI runs cannot pass the blocking
// route its release file.
const SLEEPY_ROUTE = [
  "export const graph = async () => {",
  "  await new Promise((r) => setTimeout(r, 5000))",
  "  return { ok: true }",
  "}",
  "",
].join("\n")
```

Add helpers:

```ts
async function waitForBusy(
  handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>>,
  threadId: string,
): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const response = await handler.fetch(new Request(`http://localhost/threads/${threadId}`))
    if (response.status === 200) {
      const body = (await response.json()) as { status?: string }
      if (body.status === "busy") return
    } else {
      await response.text()
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`thread ${threadId} never became busy`)
}

function sseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .flatMap((line) => (line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : []))
}
```

and the test inside `describe("POST /threads/:id/cancel")`:

```ts
  it("ends an AG-UI run with RUN_FINISHED cancelled, not RUN_ERROR", async () => {
    const { handler } = await setupBlockingRoute()
    const threadId = "t-agui-cancelled-outcome"

    const runPromise = handler.fetch(agUiRunRequest(threadId, "/sleepy#graph"))
    await waitForBusy(handler, threadId)
    const cancelResponse = await handler.fetch(cancelRequest(threadId))
    expect(cancelResponse.status).toBe(200)
    await cancelResponse.json()

    const run = await runPromise
    expect(run.status).toBe(200)
    const frames = sseFrames(await run.text())
    expect(frames.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "cancelled" },
    })
    expect(frames.map((frame) => frame.type)).not.toContain("RUN_ERROR")
  }, 30_000)
```

Run: `cd packages/cli && pnpm exec vitest run test/run-cancellation.test.ts -t "cancelled, not RUN_ERROR"; cd ../..`
Expected: PASS (Step 3 wired it). Then mutation-check: temporarily change `cancelled: () => run.cancelled || shutdownSignal.aborted` to `cancelled: () => false`, re-run → FAIL; restore.

- [ ] **Step 5: Run the full file, lint, commit**

```bash
pnpm build >/dev/null; cd packages/cli && pnpm exec vitest run test/run-cancellation.test.ts test/agui-endpoint.test.ts 2>&1 | grep -E 'Tests |FAIL' && pnpm lint 2>&1 | tail -1; cd ../..
git add packages/ag-ui/src/outbound.ts packages/ag-ui/test/outbound.test.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/run-cancellation.test.ts
git commit -m "feat(ag-ui): end a cancelled or shut-down run with the cancelled outcome

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `pendingToolCallIds` on a success that leaves client-tool calls parked

**Files:**
- Modify: `packages/ag-ui/src/outbound.ts`
- Modify: `packages/cli/src/lib/dev/client-tool-turn.ts`
- Modify: `packages/cli/src/lib/dev/agui-handler.ts` (`normalizeB4Stream`, the streaming call, `clientToolPartialResponse` and its two call sites)
- Test: `packages/ag-ui/test/outbound.test.ts`, `packages/cli/test/client-tool-park-visibility.test.ts`, `packages/cli/test/agui-client-tools.test.ts`

- [ ] **Step 1: Write the failing translator test**

Append inside `describe("toAguiEvents")`:

```ts
  test("a success that leaves client calls parked names them in pendingToolCallIds", async () => {
    const out = []
    for await (const ev of toAguiEvents(toAsync([{ type: "done", data: {} }]), CTX, {
      pendingToolCallIds: () => ["call_a", "call_b"],
    })) {
      out.push(ev)
    }
    expect(out.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success", pendingToolCallIds: ["call_a", "call_b"] },
    })
  })

  test("an ordinary success carries no pendingToolCallIds key at all", async () => {
    const events = await collect([{ type: "done", data: {} }])
    expect(events.at(-1)).toMatchObject({ outcome: { type: "success" } })
    expect((events.at(-1) as { outcome: object }).outcome).not.toHaveProperty("pendingToolCallIds")
  })
```

Run: `cd packages/ag-ui && pnpm exec vitest run test/outbound.test.ts -t pendingToolCallIds; cd ../..` → first FAILS.

- [ ] **Step 2: Implement in `outbound.ts`**

Extend `ToAguiOptions`:

```ts
  /**
   * Asked when the run ends in success: the client-provided tool calls this
   * turn left parked, awaiting the client's results. 1.0 ends such a turn as
   * success with `pendingToolCallIds`, never as an interrupt. Absent or empty
   * means none, and the key is then omitted (never `[]`).
   */
  readonly pendingToolCallIds?: () => readonly string[]
```

Add a helper inside `toAguiEvents` next to `flushText`:

```ts
  function successOutcome(): RunFinishedEvent["outcome"] {
    const pending = options.pendingToolCallIds?.() ?? []
    return pending.length > 0
      ? { type: "success", pendingToolCallIds: [...pending] }
      : { type: "success" }
  }
```

and replace both `outcome: { type: "success" }` occurrences (the `done` case and the stream-ended-without-done path) with `outcome: successOutcome()`.

Run the two tests → PASS.

- [ ] **Step 3: Make `partial` carry the unanswered ids**

In `packages/cli/src/lib/dev/client-tool-turn.ts`:

```ts
  | {
      readonly mode: "partial"
      /** The client parks still awaiting a result, by provider tool-call id. */
      readonly pendingToolCallIds: readonly string[]
    }
```

and the final line of `resolveClientToolTurn`:

```ts
  return {
    mode: "partial",
    pendingToolCallIds: clientParks.flatMap(({ toolCallId }) =>
      toolCallId !== undefined && answeredResult(toolCallId) === undefined ? [toolCallId] : [],
    ),
  }
```

- [ ] **Step 4: Thread the ids through the handler**

`clientToolPartialResponse` gains a parameter and passes it to the translator:

```ts
async function clientToolPartialResponse(
  threadId: string,
  runId: string,
  accept: string | null,
  pendingToolCallIds: readonly string[],
): Promise<Response> {
  async function* done(): AsyncGenerator<B4AgentStreamChunk> {
    yield { type: "done", data: null }
  }
  let body = ""
  for await (const event of toAguiEvents(
    done(),
    { threadId, runId },
    { pendingToolCallIds: () => pendingToolCallIds },
  )) {
    body += encodeAgUiSse(event, accept ?? undefined)
  }
  // …unchanged Response construction…
```

Its two call sites:
- the `clientTurn.mode === "none"` resent-history no-op: `clientToolPartialResponse(threadId, input.runId, request.headers.get("accept"), [])` — there are no client parks in that branch.
- the `clientTurn.mode === "partial"` branch: `clientToolPartialResponse(threadId, input.runId, request.headers.get("accept"), clientTurn.pendingToolCallIds)`.

`normalizeB4Stream` records the parks it drops. Change its signature and the drop:

```ts
async function* normalizeB4Stream(
  chunks: AsyncIterable<StreamChunk>,
  clientToolNames: ReadonlySet<string> = new Set(),
  onClientToolPark?: (toolCallId: string) => void,
): AsyncGenerator<B4AgentStreamChunk> {
  for await (const raw of chunks) {
    if (raw.type === "interrupt") {
      const data = (raw as { readonly data: unknown }).data
      if (isClientToolCallEnvelope(data)) onClientToolPark?.(data.toolCallId)
    }
    const chunk = clientFacingChunk(raw, clientToolNames)
    if (chunk === undefined) continue
    // …rest unchanged…
```

At the streaming call site, declare `const parkedClientCallIds: string[] = []` just above the `for await (const event of toAguiEvents(` line, pass `normalizeB4Stream(liveTappedStream, clientToolNames, (id) => parkedClientCallIds.push(id))`, and add `pendingToolCallIds: () => parkedClientCallIds,` to the options object next to `cancelled`.

- [ ] **Step 5: Update the two wire tests and run them**

In `packages/cli/test/client-tool-park-visibility.test.ts`, the two assertions `expect(last.outcome).toEqual({ type: "success" })` (around lines 137 and 164) become:

```ts
    expect(last.outcome).toEqual({ type: "success", pendingToolCallIds: [CALL_A.id] })
```
(use whichever constant that test parks; read the test's fixture — the id is the provider tool-call id of the parked client call). In `packages/cli/test/agui-client-tools.test.ts`, find the `partial` case (`mode: "partial"` / "some parked calls answered") and assert the returned `RUN_FINISHED.outcome.pendingToolCallIds` equals the ids still unanswered in that fixture.

```bash
pnpm build >/dev/null; cd packages/cli && pnpm exec vitest run test/client-tool-park-visibility.test.ts test/agui-client-tools.test.ts test/client-tool-turn.test.ts 2>&1 | grep -E 'Tests |FAIL'; cd ../..
```
Expected: PASS. Mutation: change `pendingToolCallIds: () => parkedClientCallIds` to `() => []` → the visibility test FAILS; restore.

- [ ] **Step 6: Lint and commit**

```bash
cd packages/cli && pnpm lint 2>&1 | tail -1; cd ../..; pnpm --filter @b4run/ag-ui lint 2>&1 | tail -1
git add packages/ag-ui/src/outbound.ts packages/ag-ui/test/outbound.test.ts packages/cli/src/lib/dev/client-tool-turn.ts packages/cli/src/lib/dev/agui-handler.ts packages/cli/test/client-tool-park-visibility.test.ts packages/cli/test/agui-client-tools.test.ts
git commit -m "feat(ag-ui): name parked client-tool calls in the success outcome

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Null discipline — no optional key is ever `null` on the wire

**Files:**
- Test: `packages/ag-ui/test/outbound.test.ts`
- Modify (only if the test finds one): `packages/ag-ui/src/outbound.ts`, `activities.ts`, `interrupts.ts`

- [ ] **Step 1: Write the test**

Append to `packages/ag-ui/test/outbound.test.ts`:

```ts
describe("1.0 null discipline", () => {
  /** Top-level keys of an event, and of each interrupt and outcome it carries, are never `null`. */
  function assertNoNullField(label: string, value: Record<string, unknown>): void {
    for (const [key, field] of Object.entries(value)) {
      if (key === "metadata" || key === "result" || key === "content") continue // application data
      expect(field, `${label}.${key}`).not.toBeNull()
      if (key === "outcome" && field && typeof field === "object") {
        assertNoNullField(`${label}.outcome`, field as Record<string, unknown>)
        const interrupts = (field as { interrupts?: unknown }).interrupts
        if (Array.isArray(interrupts)) {
          interrupts.forEach((interrupt, index) =>
            assertNoNullField(`${label}.outcome.interrupts[${index}]`, interrupt),
          )
        }
      }
    }
  }

  test("every event kind B4.run emits", async () => {
    const streams: B4AgentStreamChunk[][] = [
      [{ type: "token", data: "hi" }, { type: "done", data: null }],
      [
        { type: "tool_call", data: { id: "c1", name: "search", input: { q: 1 } } },
        { type: "tool_result", data: { id: "c1", name: "search", output: null } },
        { type: "done" },
      ],
      [{ type: "interrupt", data: { interruptId: "perm-1", kind: "tool", callId: "c1", grant: "g" } }],
      [
        { type: "plan_update", data: { tool_call_id: "p1", todos: [{ content: "a", status: "pending" }] } },
        { type: "subagent.start", data: CHILD },
        { type: "subagent.end", data: { ...CHILD, final_message: "x" } },
        { type: "done", data: undefined },
      ],
    ]
    for (const stream of streams) {
      const events = await collect(stream)
      events.forEach((event, index) =>
        assertNoNullField(`${stream[0]?.type}[${index}]`, event as Record<string, unknown>),
      )
    }
    // The throwing path.
    async function* boom(): AsyncGenerator<B4AgentStreamChunk> {
      throw Object.assign(new Error("x"), { code: "after_rejected" })
    }
    for await (const event of toAguiEvents(boom(), CTX)) {
      assertNoNullField("error", event as Record<string, unknown>)
    }
  })
})
```

- [ ] **Step 2: Run it**

Run: `cd packages/ag-ui && pnpm exec vitest run test/outbound.test.ts -t "null discipline"; cd ../..`
Expected: PASS. If it FAILS, the message names the key: fix the producing site so the key is omitted (conditional spread) rather than set to `null`, and re-run until green.

- [ ] **Step 3: Commit**

```bash
git add packages/ag-ui/test/outbound.test.ts packages/ag-ui/src
git commit -m "test(ag-ui): pin 1.0 null discipline across every emitted event kind

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Conformance through the real 1.0 client pipeline, warnings are failures

**Files:**
- Rewrite: `packages/ag-ui/test/conformance.test.ts`

- [ ] **Step 1: Replace the test file**

Keep the existing `CANNED` stream, the id constants, `childIdentity`, `toAsync` and the `afterEach` server teardown. Replace the server factory and the test body with the following (the whole file after the constants):

```ts
interface CannedRun {
  readonly chunks: readonly B4AgentStreamChunk[]
  readonly options?: ToAguiOptions
}

/** The fixture server: answers each POST with the next canned run, and records every request body. */
async function startCannedServer(runs: readonly CannedRun[]): Promise<{
  readonly url: string
  readonly bodies: unknown[]
}> {
  const queue = [...runs]
  const bodies: unknown[] = []
  const cannedServer = createServer((req, res) => {
    void (async () => {
      const raw: Buffer[] = []
      for await (const piece of req) raw.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece))
      bodies.push(JSON.parse(Buffer.concat(raw).toString("utf8")))
      const run = queue.shift()
      if (!run) throw new Error("more runs requested than canned")
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const events = toAguiEvents(
        toAsync(run.chunks),
        { threadId: "t1", runId: `r${bodies.length}` },
        { idFactory: createCounterIdFactory(), ...run.options },
      )
      for await (const event of events) res.write(encodeAgUiSse(event))
      res.end()
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    cannedServer.once("error", onError)
    cannedServer.listen(0, "127.0.0.1", () => {
      cannedServer.off("error", onError)
      resolve()
    })
  })
  server = cannedServer
  const address = cannedServer.address()
  if (!address || typeof address === "string") throw new Error("Canned server has no TCP address")
  return { url: `http://127.0.0.1:${address.port}`, bodies }
}

/**
 * Drive the REAL client pipeline — `runAgent`, not a bare `run()` — so
 * CompatibilityBoundary → enforceEvents → chunk expansion → verifyEvents all
 * run, and treat any console warning as a failure: a 1.0 client warns exactly
 * when it strips something the producer sent, and B4.run must send nothing
 * that gets stripped.
 */
async function runThroughClient(url: string, parameters: Parameters<HttpAgent["runAgent"]>[0]) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    const agent = new HttpAgent({
      url,
      threadId: "t1",
      initialMessages: [{ id: "1", role: "user", content: "research agents" }],
    })
    const events: BaseEvent[] = []
    const result = await agent.runAgent(parameters, { onEvent: ({ event }) => void events.push(event) })
    expect(warn.mock.calls, "the 1.0 client stripped or translated something").toEqual([])
    return { agent, events, result }
  } finally {
    warn.mockRestore()
  }
}

it("a full turn passes 1.0 enforcement with nothing stripped", async () => {
  const { url } = await startCannedServer([{ chunks: CANNED }])
  const { events } = await runThroughClient(url, { runId: "r1" })
  const kinds = events.map((e) => e.type)
  expect(kinds[0]).toBe(EventType.RUN_STARTED)
  expect(events[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
  expect(kinds).toContain(EventType.TOOL_CALL_START)
  expect(kinds).toContain(EventType.TOOL_CALL_RESULT)
  const toolEvents = events.filter(
    (event) =>
      event.type === EventType.TOOL_CALL_START ||
      event.type === EventType.TOOL_CALL_ARGS ||
      event.type === EventType.TOOL_CALL_END ||
      event.type === EventType.TOOL_CALL_RESULT,
  ) as Array<{ toolCallId: string; toolCallName?: string; delta?: string; type: EventType }>
  expect(toolEvents.map((event) => event.toolCallId)).not.toContain(PLAN_TOOL_CALL_ID)
  expect(toolEvents.map((event) => event.toolCallId)).not.toContain(TASK_TOOL_CALL_ID)
  expect(
    toolEvents
      .filter((event) => event.type === EventType.TOOL_CALL_START)
      .map((event) => event.toolCallName),
  ).toEqual(["draftReply", "searchCorpus"])
  expect(
    toolEvents
      .filter((event) => event.toolCallId === STREAMED_TOOL_CALL_ID && event.type === EventType.TOOL_CALL_ARGS)
      .map((event) => event.delta)
      .join(""),
  ).toBe(JSON.stringify(STREAMED_ARGS))
  const activities = events
    .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
    .map((event) => ActivitySnapshotEventSchema.parse(event))
  expect(new Set(activities.map((activity) => activity.activityType))).toEqual(
    new Set([B4_PLAN_ACTIVITY_TYPE, B4_SUBAGENT_ACTIVITY_TYPE]),
  )
  const serialized = JSON.stringify(activities.map((activity) => activity.content))
  for (const privateValue of ["not public", childIdentity.route_id, childIdentity.call_id, "child-tool-1"]) {
    expect(serialized).not.toContain(privateValue)
  }
  expect(
    (events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT) as Array<{ delta: string }>)
      .map((event) => event.delta)
      .join(""),
  ).toBe("Researching done. [corpus/a.md]")
  expect(kinds.at(-1)).toBe(EventType.RUN_FINISHED)
})

it("an approval interrupt keeps its grant in metadata, and the resume carries it back there", async () => {
  const envelope = { interruptId: "perm-1", kind: "tool", callId: "c1", grant: "b4ag_xyz" }
  const { url, bodies } = await startCannedServer([
    { chunks: [{ type: "interrupt", data: envelope }] },
    { chunks: [{ type: "token", data: "approved" }, { type: "done", data: {} }] },
  ])
  const { agent, events } = await runThroughClient(url, { runId: "r1" })
  const finished = events.at(-1) as { outcome?: { type: string; interrupts?: Array<Record<string, unknown>> } }
  expect(finished.outcome?.type).toBe("interrupt")
  const [interrupt] = finished.outcome?.interrupts ?? []
  expect(interrupt).toBeDefined()
  expect(interrupt).not.toHaveProperty("grant")
  expect((interrupt?.metadata as { grant?: string } | undefined)?.grant).toBe("b4ag_xyz")
  expect(agent.pendingInterrupts).toHaveLength(1)

  await agent.runAgent({
    runId: "r2",
    resume: [{ interruptId: "perm-1", status: "resolved", payload: "once", metadata: { grant: "b4ag_xyz" } }],
  })
  const resumeBody = bodies[1] as { resume: Array<Record<string, unknown>>; protocolVersion?: string }
  expect(resumeBody.protocolVersion).toBe(PROTOCOL_VERSION)
  expect(resumeBody.resume[0]?.metadata).toEqual({ grant: "b4ag_xyz" })
  expect(resumeBody.resume[0]).not.toHaveProperty("grant")
})

it("a client-tool park ends as success naming the pending call", async () => {
  const { url } = await startCannedServer([
    {
      chunks: [
        { type: "tool_call", data: { id: "call_open", name: "openPanel", input: { id: 7 } } },
      ],
      options: { pendingToolCallIds: () => ["call_open"] },
    },
  ])
  const { events } = await runThroughClient(url, { runId: "r1" })
  expect(events.at(-1)).toMatchObject({
    type: EventType.RUN_FINISHED,
    outcome: { type: "success", pendingToolCallIds: ["call_open"] },
  })
})

it("a cancelled run ends with the cancelled outcome", async () => {
  async function* aborted(): AsyncGenerator<B4AgentStreamChunk> {
    yield { type: "token", data: "partial" }
    throw new Error("cancelled")
  }
  const { url } = await startCannedServer([
    { chunks: [], options: { cancelled: () => true } },
  ])
  // The canned server iterates `chunks`; feed the throwing generator through `options` instead:
  void aborted
  const { events } = await runThroughClient(url, { runId: "r1" })
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
})

it("an upstream error is RUN_ERROR with its code intact", async () => {
  const { url } = await startCannedServer([{ chunks: [], options: {} }])
  void url
})
```

> The last two cases above are sketched incorrectly on purpose to make the next step explicit: the canned server iterates a `chunks` array, so a throwing stream needs a different seam. Replace them with the versions in Step 2.

- [ ] **Step 2: Give the canned server a throwing-stream seam and finish the last two cases**

Change `CannedRun` to accept either an array or a generator factory:

```ts
interface CannedRun {
  readonly stream: () => AsyncIterable<B4AgentStreamChunk>
  readonly options?: ToAguiOptions
}
```
In `startCannedServer` use `toAguiEvents(run.stream(), …)`, and in every earlier case write `{ stream: () => toAsync(CANNED) }` (and likewise for the other arrays). Then the last two cases become:

```ts
it("a cancelled run ends with the cancelled outcome and no RUN_ERROR", async () => {
  async function* aborted(): AsyncGenerator<B4AgentStreamChunk> {
    yield { type: "token", data: "partial" }
    throw new Error("AG-UI request aborted")
  }
  const { url } = await startCannedServer([{ stream: aborted, options: { cancelled: () => true } }])
  const { events } = await runThroughClient(url, { runId: "r1" })
  expect(events.map((e) => e.type)).not.toContain(EventType.RUN_ERROR)
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: "cancelled" } })
})

it("an upstream error is RUN_ERROR with its code intact", async () => {
  async function* boom(): AsyncGenerator<B4AgentStreamChunk> {
    throw Object.assign(new Error("after rejected"), { code: "after_rejected" })
  }
  const { url } = await startCannedServer([{ stream: boom }])
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    const agent = new HttpAgent({ url, threadId: "t1" })
    const events: BaseEvent[] = []
    await expect(
      agent.runAgent({ runId: "r1" }, { onEvent: ({ event }) => void events.push(event) }),
    ).rejects.toThrow()
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: "after rejected", code: "after_rejected" })
    expect(warn.mock.calls).toEqual([])
  } finally {
    warn.mockRestore()
  }
})
```

Imports at the top of the file must be:

```ts
import { createServer, type Server } from "node:http"
import { HttpAgent } from "@ag-ui/client"
import { type BaseEvent, EventType, PROTOCOL_VERSION } from "@ag-ui/core"
import { ActivitySnapshotEventSchema } from "@ag-ui/core/schemas"
import { afterEach, expect, it, vi } from "vitest"
import { B4_PLAN_ACTIVITY_TYPE, B4_SUBAGENT_ACTIVITY_TYPE } from "../src/activities.ts"
import { createCounterIdFactory } from "../src/ids.js"
import { type ToAguiOptions, toAguiEvents } from "../src/outbound.js"
import { encodeAgUiSse } from "../src/sse.js"
import type { B4AgentStreamChunk } from "../src/types.js"
```

- [ ] **Step 3: Run it**

Run: `cd packages/ag-ui && pnpm exec vitest run test/conformance.test.ts; cd ../..`
Expected: 5 PASS. A failure whose message is "the 1.0 client stripped or translated something" prints the warning text; fix the producer, never the assertion. If `runAgent` rejects on the RUN_ERROR case differently from `rejects.toThrow()`, read the thrown error and assert on it instead; the point is that the `RUN_ERROR` event reached the subscriber with its `code`.

- [ ] **Step 4: Mutation check**

Temporarily re-add `grant: "b4ag_xyz"` top-level in `toAguiInterrupt`'s return → the interrupt case must FAIL on the warning assertion. Restore.

- [ ] **Step 5: Lint and commit**

```bash
pnpm --filter @b4run/ag-ui lint 2>&1 | tail -1
git add packages/ag-ui/test/conformance.test.ts
git commit -m "test(ag-ui): conformance through the real 1.0 client pipeline, warnings are failures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Run the CopilotKit runtime test on CI

**Files:**
- Modify: `.github/workflows/ci.yml` (the `Dependency security regressions` step and the build step before it)
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json`, `scripts/release/test/fixtures/workflow-safe-executables.json` (hand-transcribed; there is no regeneration script — see `CONTRIBUTORS.md` "Workflow entrypoints and executable steps have exact fixtures")

- [ ] **Step 1: Edit the two steps**

The build step before it builds only the testing closure; the CopilotKit test imports the example route modules, which import `@b4run/ag-ui/client`, so `@b4run/ag-ui` must be built too:

```yaml
      - name: Build testing dependency closure
        # The focused test starts the CLI from its built dist output. The
        # trailing ellipsis selects @b4run/testing and its dependencies;
        # @b4run/ag-ui is what the CopilotKit runtime test's example routes import.
        run: pnpm --filter @b4run/testing... --filter @b4run/ag-ui build
```

```yaml
      - name: Dependency security regressions
        run: pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/hono-serve-static-windows.test.ts test/security-dependencies/copilotkit-v2-runtime.test.ts
```

- [ ] **Step 2: Let the contract test tell you what to transcribe**

Run: `node --test scripts/release/test/workflow-contracts.test.mjs 2>&1 | grep -E 'not ok|expected|actual|run:' | head -40`
Expected: failures naming the changed `run:` bodies for that job in both fixtures. Open each fixture, find the entries for `.github/workflows/ci.yml` → that job → those two steps, and replace the recorded `run` strings with the new byte-exact bodies (keep the surrounding structure). Re-run until:

Run: `node --test scripts/release/test/workflow-contracts.test.mjs 2>&1 | tail -3 && pnpm test:release-integrity 2>&1 | tail -2`
Expected: both PASS.

- [ ] **Step 3: Prove the step works locally as CI runs it**

```bash
pnpm --filter @b4run/testing... --filter @b4run/ag-ui build >/dev/null
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/hono-serve-static-windows.test.ts test/security-dependencies/copilotkit-v2-runtime.test.ts 2>&1 | grep -E 'Tests |FAIL'
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml scripts/release/test/fixtures/workflow-entrypoints.json scripts/release/test/fixtures/workflow-safe-executables.json
git commit -m "ci: run the CopilotKit runtime test in the dependency-security job

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Docs, README, API reference, changeset, spec amendment, lastmod

**Files:**
- Modify: `apps/web/content/docs/ag-ui.mdx`
- Modify: `apps/web/content/docs/approval-grants.mdx:63-69`
- Modify: `apps/web/content/docs/api/ag-ui.mdx`
- Modify: `packages/ag-ui/README.md`
- Modify: `docs/superpowers/specs/2026-10-01-ag-ui-1-0-cutover-design.md` (§5.3)
- Create: `.changeset/agui-1-0-cutover.md`
- Modify (generated): `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: `ag-ui.mdx`**

Under `## The endpoint`, after the paragraph ending "streams translated events back as SSE.", add:

```md
B4.run speaks AG-UI protocol **1.0**. `RUN_STARTED` declares `protocolVersion: "1.0"`. A request may declare its own `protocolVersion`; any `1.x` is served, an absent or unparseable value is served, and a different major is refused with `400` `unsupported_protocol_version` before middleware runs. The `@b4run/ag-ui` package requires `@ag-ui/client` `>=1.0.1 <2.0.0` as a peer.
```

Under `## Envelope validation`, add a subsection before `### Where the check runs`:

```md
### Multimodal content is refused, not dropped

A 1.0 message's `content` may be a list of parts. Text parts are concatenated in order. A message carrying an `image`, `audio`, `video` or `document` part is refused with `422` `multimodal_not_supported`, before middleware, so a client is told its media never reached the model rather than finding out by silence. `role: "reasoning"` and `role: "activity"` history is dropped on the way in: it is the client's stored artefact of an earlier turn, not something the assistant said.
```

In `### Outbound events`, replace the three terminal rows:

```md
| `interrupt` | terminal `RUN_FINISHED` with `outcome.type: "interrupt"`; each interrupt's approval grant is at `metadata.grant` |
| `done` | terminal `RUN_FINISHED` with `outcome.type: "success"`; when the turn left client-provided tool calls parked, `outcome.pendingToolCallIds` names them |
| `POST /threads/:id/cancel` or a server shutdown during the run | terminal `RUN_FINISHED` with `outcome.type: "cancelled"` |
| upstream error | terminal `RUN_ERROR` |
```

In `## Client-provided tools` → `### The round trip`, where the turn is said to end in `RUN_FINISHED` with `outcome.type: "success"`, append: "with `pendingToolCallIds` naming the parked calls — AG-UI 1.0's prescribed shape for a frontend tool call."

In the error-codes table under `### Error codes`, add:

```md
| `400` | `unsupported_protocol_version` | the request declared an AG-UI protocol major this runtime does not speak |
| `422` | `multimodal_not_supported` | a message carried an image, audio, video or document part |
```

- [ ] **Step 2: `approval-grants.mdx`**

Replace the channel table row and the paragraph after the table:

```md
| The AG-UI `interrupt` chunk | `metadata.grant` |
```

```md
On AG-UI the grant is at `metadata.grant` and nowhere else. `metadata` is schema-defined on AG-UI's `Interrupt` and `ResumeEntry`, so a 1.0 client's enforcement stage leaves it intact in both directions; a top-level `grant` is a field the protocol guarantees to strip — on every prompt received, and from every resume entry before it is sent. Echo it back the same way:

```json
{ "interruptId": "perm-abc123", "status": "resolved", "payload": "once", "metadata": { "grant": "b4ag_..." } }
```

The Agent Protocol endpoints (`GET /threads/:thread_id/pending_interrupts`, the attach `state` frame, `POST /threads/:thread_id/resume`) are B4.run's own wire and keep the top-level `grant` shown below.
```

- [ ] **Step 3: `api/ag-ui.mdx`**

- Row: `| \`B4AguiInterrupt\` | AG-UI's interrupt as B4.run emits it; the approval grant is at \`metadata.grant\`. |`
- In "Compatibility and audience", after the table, add: "`@ag-ui/client` `>=1.0.1 <2.0.0` is an optional peer, needed only by `./client`. Runtime validators (`RunAgentInputSchema`, `AgentCapabilitiesSchema`, `*EventSchema`) live at `@ag-ui/core/schemas` in 1.0; import types from `@ag-ui/core`."
- If an `api-contract="@b4run/ag-ui#.:B4AguiInterrupt"` block exists, its body becomes `export type B4AguiInterrupt = Interrupt`.

- [ ] **Step 4: `packages/ag-ui/README.md`**

Add under the install section: "Requires `@ag-ui/core` 1.0.1 (bundled) and, for `@b4run/ag-ui/client`, `@ag-ui/client` `>=1.0.1 <2.0.0`." Where the README lists interrupt handling or the grant, say `metadata.grant`.

- [ ] **Step 5: Amend the spec's §5.3**

Replace §5.3's body with:

```md
Claims are unchanged in this sub-project. `GET /agui/:routeId` is introduced by PR #883, which rebases onto this change and adds `transport: { streaming: true }` there (a fact the handler enforces: it only answers SSE). No `multimodal`, `reasoning`, `state` or `multiAgent` section until the sub-project that makes each one true.
```

- [ ] **Step 6: Changeset**

Create `.changeset/agui-1-0-cutover.md`:

```md
---
"@b4run/ag-ui": patch
"@b4run/cli": patch
"@b4run/devkit": patch
"create-b4-app": patch
---

Move to AG-UI protocol 1.0 (`@ag-ui/core`/`@ag-ui/encoder` 1.0.1; `@ag-ui/client` peer `>=1.0.1 <2.0.0`). Breaking for AG-UI clients: the approval grant is carried in `metadata.grant` only, on interrupts and on resume entries — the top-level `grant` a 1.0 client strips is gone. (Grants are unreleased — they landed after the v0.13.0 tag — so the channel is new, not changed.) `RUN_STARTED` declares `protocolVersion: "1.0"`; a request declaring a foreign major is refused with `400 unsupported_protocol_version`. A cancelled or shut-down run ends with `RUN_FINISHED { outcome: cancelled }` instead of `RUN_ERROR`; a turn that leaves client-provided tool calls parked names them in `outcome.pendingToolCallIds`. 1.0 content parts are read as text; messages carrying media parts are refused with `422 multimodal_not_supported` until multimodal input lands. Examples and the research scaffold pin CopilotKit 1.76.0 and `@ag-ui/client` 1.0.1 exactly.
```

- [ ] **Step 7: Docs gates, then lastmod**

```bash
node scripts/check-docs.mjs 2>&1 | tail -5
```
Expected: "Docs completeness check passed." If it names a pinned phrase (for example a `forbiddenContent` hit or a count), fix the doc or the pin it names and re-run.

```bash
git add -A apps/web/content packages/ag-ui/README.md docs/superpowers/specs .changeset
git commit -m "docs(ag-ui): protocol 1.0 — grant channel, cancelled outcome, pending tool calls, multimodal refusal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod >/dev/null && pnpm --dir apps/web seo:lastmod:routes 2>&1 | tail -1
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod for the AG-UI 1.0 docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Full gates, the acceptance harness, PR, follow-up issues

**Files:** none new.

- [ ] **Step 1: The local gate sequence (run from the repo root, Node 24)**

```bash
pnpm test:release-integrity 2>&1 | tail -1
pnpm lint 2>&1 | tail -1
pnpm check:build-cache 2>&1 | tail -1
pnpm build 2>&1 | tail -2
pnpm typecheck 2>&1 | tail -1
pnpm test > /tmp/b4-test.log 2>&1; echo test=$?; grep -E 'FAIL ' /tmp/b4-test.log | head
pnpm check:release-inventory 2>&1 | tail -1
node scripts/check-docs.mjs 2>&1 | tail -1
pnpm pack:check 2>&1 | tail -1
node --test scripts/release/test/workflow-contracts.test.mjs 2>&1 | tail -2
```
Expected: every command succeeds. Known environmental exception: `examples/software-factory/controller` `runtime.test.ts` fails without a Docker daemon; it is unrelated and passes on CI.

- [ ] **Step 2: The acceptance gate — the generated research app from npm**

```bash
pnpm verify:harness:framework 2>&1 | tail -15
```
Expected: `passed=1 failed=0`. This is the lane that is red on `main`; it scaffolds the research template, `npm install`s CopilotKit 1.76 + `@ag-ui/client` 1.0.1 from the registry, and typechecks the generated app. If it fails on the typecheck, the transcript path it prints shows the TS error; the usual cause is a template file that drifted from the example (Task 2 Step 7).

- [ ] **Step 3: Push and open the PR**

```bash
git fetch origin main && git log --oneline HEAD..origin/main | head
git push -u origin blove/agui-1-0-cutover
gh pr create --repo cacheplane/b4run --base main --head blove/agui-1-0-cutover \
  --title "feat(ag-ui)!: move to AG-UI protocol 1.0" \
  --body-file - <<'EOF'
Spec: docs/superpowers/specs/2026-10-01-ag-ui-1-0-cutover-design.md. Plan: docs/superpowers/plans/2026-10-01-ag-ui-1-0-cutover.md.

Fixes the harness-verify break on main: CopilotKit 1.76.0 (2026-10-01) depends on @ag-ui 1.0.1, and 1.0.1's AbstractAgent is nominal, so the research scaffold stopped typechecking.

## What changes
- @ag-ui/core, @ag-ui/encoder 1.0.1; @ag-ui/client peer >=1.0.1 <2.0.0; validators from @ag-ui/core/schemas. Examples and the research scaffold pin CopilotKit 1.76.0 and @ag-ui/client 1.0.1 exactly, guarded by the existing pin tests.
- RUN_STARTED declares protocolVersion "1.0"; a foreign major is 400 unsupported_protocol_version before middleware.
- **Breaking:** the approval grant is at metadata.grant only (interrupts and resume entries). A 1.0 client strips the top-level field in both directions; the resume gate would otherwise refuse every grant-required approval.
- RUN_FINISHED { outcome: cancelled } for POST /threads/:id/cancel and shutdown; pendingToolCallIds on a success that leaves client-tool calls parked.
- 1.0 content parts read as text; media parts refused with 422 multimodal_not_supported; reasoning/activity history dropped inbound.
- conformance.test.ts now drives HttpAgent.runAgent (the full 1.0 enforcement pipeline) with console.warn as a failure.
- The CopilotKit runtime test joins CI's dependency-security job.

## Not in this PR (own specs)
Outbound richness (usage, REASONING_*, SUBAGENT_* attribution, ACTIVITY_DELTA, STEP_*), multimodal input, protobuf transport and the remaining capability sections. GET /agui/:routeId capabilities is PR #883, which rebases onto this.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: File the follow-up issues**

```bash
gh issue create --repo cacheplane/b4run --title "AG-UI 1.0 sub-project 2: outbound richness (usage, reasoning, subagent attribution, activity deltas, steps)" --body "Spec to write. From docs/superpowers/specs/2026-10-01-ag-ui-1-0-cutover-design.md §9: usage from the langchain adapter's usage_metadata on RUN_FINISHED/RUN_ERROR; REASONING_* (chunkText currently discards reasoning blocks); SUBAGENT_STARTED/FINISHED/ERROR with subagentRunId attribution alongside the b4.subagent activity cards; ACTIVITY_DELTA; STEP_*. Each turns on its capability section (reasoning, multiAgent)."
gh issue create --repo cacheplane/b4run --title "AG-UI 1.0 sub-project 3: multimodal input and content-part tool results" --body "Spec to write. From the cut-over spec §9: ContentPart[] user input (image/document/file sources) into the runtime, content-part tool results outbound, and the multimodal capability section. Replaces the 422 multimodal_not_supported refusal."
gh issue create --repo cacheplane/b4run --title "AG-UI 1.0 sub-project 4: protobuf transport and remaining capability sections" --body "Spec to write. From the cut-over spec §9: Accept: application/vnd.ag-ui.event+proto (httpBinary) via @ag-ui/encoder's encodeBinary; websocket if warranted; the reasoning, state and multiAgent capability sections on GET /agui/:routeId."
```

- [ ] **Step 5: Merge on green**

When `validate` is green (the advisory `review` check is not a merge signal), squash-merge. Re-fetch `main` right before merging; if `pnpm-lock.yaml` conflicts, re-run `pnpm install` on top of main rather than hand-merging. Then rebase PR #883 onto main and add `transport: { streaming: true }` to its `GET /agui/:routeId` document (spec §5.3).

---

## Self-review against the spec

- §4.1 manifests → Task 1. §4.2 imports → Task 2. §4.3 loose parsing → Task 3. §4.4 type fallout → Task 2 (research example + mirror).
- §5.1 outbound: `protocolVersion` → Task 4; `cancelled` → Task 8; `pendingToolCallIds` → Task 9; grant → Task 5; null discipline → Task 10; string tool results unchanged (no task).
- §5.2 inbound: resume grant → Task 5; `protocolVersion` check → Task 6; content/media/reasoning → Task 7.
- §5.3 capabilities → deferred to #883, spec amended in Task 13.
- §6.1 conformance → Task 11 (fixtures 1,2,4,5,6,7 there; fixture 3's server half in Task 5 Step 5, client half in Task 11). §6.2 other tests → Tasks 3, 5–9. CopilotKit test on CI → Task 12. §6.3 gates → Task 14.
- §7 docs → Task 13. §8 release → Task 13 (changeset) and Task 14 (issues, #883 rebase).
- Names used consistently: `ToAguiOptions.cancelled`, `ToAguiOptions.pendingToolCallIds`, `normalizeB4Stream(chunks, clientToolNames, onClientToolPark)`, `clientToolPartialResponse(threadId, runId, accept, pendingToolCallIds)`, `ClientToolTurn` `partial.pendingToolCallIds`, `toolResultText`, codes `unsupported_protocol_version` (400) and `multimodal_not_supported` (422).

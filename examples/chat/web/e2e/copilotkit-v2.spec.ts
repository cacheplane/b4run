import { expect, type Page, test } from "@playwright/test"

const appOrigin = "http://127.0.0.1:3000"
const connectPath = "/api/copilotkit/agent/default/connect"

type RuntimeRequest = {
  method: string
  pathname: string
}

type ReplayEvent = Record<string, unknown> & { type: string }

/** One SSE frame per event, as the runtime's connect endpoint streams them. */
function sse(events: readonly ReplayEvent[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
}

/** A finished turn: the user's question, one `listDir` call, and the answer. */
function doneTurn(threadId: string): ReplayEvent[] {
  return [
    {
      type: "RUN_STARTED",
      threadId,
      runId: "run-1",
      input: {
        threadId,
        runId: "run-1",
        messages: [{ id: "user-1", role: "user", content: "List the files in the workspace." }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    },
    { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "listDir" },
    { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: '{"path":"."}' },
    { type: "TOOL_CALL_END", toolCallId: "call-1" },
    {
      type: "TOOL_CALL_RESULT",
      messageId: "tool-1",
      toolCallId: "call-1",
      content: "AGENTS.md\nnotes.txt",
      role: "tool",
    },
    { type: "TEXT_MESSAGE_START", messageId: "assistant-1", role: "assistant" },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "assistant-1",
      delta: "The workspace holds AGENTS.md and notes.txt.",
    },
    { type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
    { type: "RUN_FINISHED", threadId, runId: "run-1" },
  ]
}

/** A turn parked on a `runBash` permission prompt, as B4.run's adapter emits it. */
function parkedTurn(threadId: string): ReplayEvent[] {
  return [
    {
      type: "RUN_STARTED",
      threadId,
      runId: "run-2",
      input: {
        threadId,
        runId: "run-2",
        messages: [{ id: "user-2", role: "user", content: "Run `node --version` with runBash." }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    },
    { type: "TOOL_CALL_START", toolCallId: "call-2", toolCallName: "runBash" },
    { type: "TOOL_CALL_ARGS", toolCallId: "call-2", delta: '{"command":"node --version"}' },
    { type: "TOOL_CALL_END", toolCallId: "call-2" },
    {
      type: "RUN_FINISHED",
      threadId,
      runId: "run-2",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "interrupt-1",
            reason: "command",
            toolCallId: "call-2",
            metadata: {
              interruptId: "interrupt-1",
              type: "permission-request",
              kind: "command",
              toolCallId: "call-2",
              detail: { command: "node --version" },
            },
            responseSchema: { type: "string", enum: ["once", "always", "deny"] },
          },
        ],
      },
    },
  ]
}

/**
 * Answers the sidebar's `connect` with a replay instead of the B4.run server, so the
 * page renders the activity kit's DOM with no server and no model.
 */
async function replayOnConnect(
  page: Page,
  events: (threadId: string) => ReplayEvent[],
): Promise<void> {
  await page.route(`**${connectPath}`, async (route) => {
    const threadId = String(route.request().postDataJSON()?.threadId)
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: sse(events(threadId)),
    })
  })
}

test("selects the CopilotKit V2 multi-route transport", async ({ page }) => {
  const runtimeRequests: RuntimeRequest[] = []

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin === appOrigin && url.pathname.startsWith("/api/copilotkit")) {
      runtimeRequests.push({ method: request.method(), pathname: url.pathname })
    }
  })
  await replayOnConnect(page, () => [])

  const infoResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      response.request().method() === "GET" &&
      url.origin === appOrigin &&
      url.pathname === "/api/copilotkit/info"
    )
  })
  // The sidebar restores this tab's thread by connecting to it.
  const connectRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return request.method() === "POST" && url.origin === appOrigin && url.pathname === connectPath
  })

  await page.goto("/")

  const infoResponse = await infoResponsePromise
  expect(infoResponse.ok()).toBe(true)
  expect(await infoResponse.finished()).toBeNull()
  const connectRequest = await connectRequestPromise
  expect(typeof connectRequest.postDataJSON()?.threadId).toBe("string")
  await page.waitForLoadState("networkidle")
  expect(runtimeRequests[0]).toEqual({ method: "GET", pathname: "/api/copilotkit/info" })
  expect(runtimeRequests).not.toContainEqual({ method: "POST", pathname: "/api/copilotkit" })
})

test("keeps the tab's thread across a reload", async ({ page }) => {
  await replayOnConnect(page, () => [])
  const threadIds: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === connectPath) {
      threadIds.push(String(request.postDataJSON()?.threadId))
    }
  })

  await page.goto("/")
  await expect.poll(() => threadIds.length).toBeGreaterThan(0)
  await page.reload()
  await expect.poll(() => threadIds.length).toBeGreaterThan(1)
  expect(new Set(threadIds).size).toBe(1)
})

test("renders a restored turn with the activity kit", async ({ page }) => {
  await replayOnConnect(page, doneTurn)
  await page.goto("/")

  const turn = page.locator('section.b4-turn[data-state="done"]')
  await expect(turn).toHaveCount(1)
  // A settled turn folds to its summary line; opening it lists the steps.
  const summary = turn.locator(":scope > button.b4-turn__summary")
  await expect(summary).toHaveAttribute("aria-expanded", "false")
  await summary.click()
  await expect(summary).toHaveAttribute("aria-expanded", "true")
  await expect(turn.locator('li.b4-step[data-kind="tool"]')).toHaveCount(1)
  await expect(page.getByText("The workspace holds AGENTS.md and notes.txt.")).toBeVisible()
  // The user's bubble restores from the replayed RUN_STARTED's input.
  await expect(page.getByText("List the files in the workspace.")).toBeVisible()
})

test("restores a parked permission prompt as an approval card", async ({ page }) => {
  await replayOnConnect(page, parkedTurn)
  await page.goto("/")

  const card = page.locator(".b4-approval")
  await expect(card).toHaveCount(1)
  await expect(card).toContainText("node --version")
  await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible()
  await expect(card.getByRole("button", { name: "Always allow" })).toBeVisible()
  await expect(card.getByRole("button", { name: "Deny" })).toBeVisible()
})

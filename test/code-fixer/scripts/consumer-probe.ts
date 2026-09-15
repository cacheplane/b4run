import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readdir, readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { type FixtureResponse, LLMock } from "@copilotkit/aimock"
import { replayFixture, taskInput } from "../evaluation/replay.js"

type Run = (exe: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<string>

/** No paid calls: real packaged runtime and Docker tools, controlled model responses. */
export async function exerciseConsumer(appRoot: string, run: Run) {
  const steps = (await replayFixture("cli-flags")).build().slice(0, -1)
  let step = 0
  let expectedCandidate: unknown
  const mock = new LLMock({ port: 0, chunkSize: 4096 })
  mock.addFixture({
    match: {},
    response(request): FixtureResponse {
      const response = steps[step++]?.response
      if (response && "toolCalls" in response)
        return {
          toolCalls: response.toolCalls.map((call) => ({
            ...call,
            arguments: JSON.stringify(call.arguments),
          })),
        }
      if (step === steps.length + 1) {
        const message = [...request.messages].reverse().find((message) => message.role === "tool")
        assert.ok(message)
        assert.equal(typeof message.content, "string")
        const prepared = JSON.parse(message.content as string)
        assert.equal(prepared.verification.passed, true)
        expectedCandidate = prepared.candidate
        return {
          toolCalls: [
            {
              id: "export_candidate",
              name: "exportForReview",
              arguments: JSON.stringify({ candidate: expectedCandidate }),
            },
          ],
        }
      }
      return { content: "Approved candidate exported locally." }
    },
  })
  await mock.start()
  const env = { ...process.env, OPENAI_API_KEY: "test-not-used", OPENAI_BASE_URL: mock.baseUrl }
  try {
    // Exercise the ordinary CLI eval loader/scorers with a local recording upstream.
    // The recorded candidate contains runtime identities; it is never shipped as a reusable fixture.
    await run("npm", ["run", "eval", "--", "--record"], appRoot, {
      ...env,
      B4_RECORD_UPSTREAM: mock.baseUrl.replace(/\/v1$/, ""),
    })
    step = 0
    expectedCandidate = undefined
    const reservation = createServer()
    reservation.listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const address = reservation.address()
    assert.ok(address && typeof address !== "string")
    const port = address.port
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    )
    const child = spawn(process.execPath, [".b4/build/server.mjs"], {
      cwd: appRoot,
      env: { ...env, PORT: String(port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })
    const closed = once(child, "close")
    const url = `http://127.0.0.1:${port}`
    try {
      let ready = false
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) throw new Error(`Built server stopped: ${output}`)
        try {
          const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })
          if (response.ok) {
            ready = true
            break
          }
        } catch {
          /* Wait for this owned server to bind. */
        }
        await delay(200)
      }
      assert.ok(ready, `Built server did not become ready: ${output}`)
      const json = async (path: string, body?: unknown) => {
        const response = await fetch(`${url}${path}`, {
          ...(body === undefined
            ? {}
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }),
          signal: AbortSignal.timeout(180_000),
        })
        assert.equal(response.ok, true, await response.clone().text())
        return response
      }
      const { thread_id: thread } = (await (await json("/threads", {})).json()) as {
        thread_id: string
      }
      try {
        await (
          await json(`/threads/${thread}/runs/stream`, {
            route: "/fix#agent",
            input: { messages: [{ role: "user", content: taskInput }] },
          })
        ).text()
        const pending = (await (await json(`/threads/${thread}/pending_interrupts`)).json()) as {
          interrupts: { interruptId: string }[]
        }
        assert.equal(pending.interrupts.length, 1)
        assert.ok(expectedCandidate)
        const outbox = join(appRoot, ".b4/code-fixer/review-outbox")
        assert.deepEqual(await readdir(outbox).catch(() => []), [])
        await (
          await json(`/threads/${thread}/resume`, {
            route: "/fix#agent",
            resume: [
              {
                interruptId: pending.interrupts[0]!.interruptId,
                status: "resolved",
                payload: "once",
              },
            ],
          })
        ).text()
        const receipts = await readdir(outbox)
        assert.equal(receipts.length, 1)
        assert.deepEqual(
          JSON.parse(await readFile(join(outbox, receipts[0]!), "utf8")).candidate,
          expectedCandidate,
        )
        console.log("Consumer: built HTTP run, approval, exact local export passed")
      } finally {
        const response = await fetch(`${url}/threads/${thread}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(30_000),
        })
        assert.ok(response.ok, await response.text())
      }
    } finally {
      child.kill("SIGTERM")
      const kill = setTimeout(() => child.kill("SIGKILL"), 10_000)
      try {
        await closed
      } finally {
        clearTimeout(kill)
      }
    }
  } finally {
    await mock.stop()
  }
}

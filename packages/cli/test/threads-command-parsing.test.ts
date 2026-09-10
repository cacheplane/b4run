import { describe, expect, it, vi } from "vitest"
import { resolveTailRequest, runThreadsCommand } from "../src/commands/threads.js"
import { createProgram } from "../src/index.js"
import { CliError, type CommandIo } from "../src/lib/output.js"

/**
 * `b4 threads` is registered as `threads [subcommand] [args...]`. Unlike `memory`,
 * its flags (`--url`, `--header`, `--json`) are declared directly on the command
 * rather than hand-parsed out of `args`, specifically so `scripts/check-docs.mjs`
 * (which enumerates `command.options` from the built CLI) can see them. These tests
 * drive the real `createProgram` to prove commander actually binds them given the
 * program's `enablePositionalOptions()` (set for `memory`'s sake) rather than
 * swallowing them as extra positional `args`.
 */
function collectIo(): { io: CommandIo; stderr: string[] } {
  const stderr: string[] = []
  const io: CommandIo = {
    stderr: (message: string) => {
      stderr.push(message)
    },
    stdout: () => {},
  }
  return { io, stderr }
}

async function parse(
  argv: string[],
): Promise<{ error?: unknown; stderr: string[]; options: Record<string, unknown> | undefined }> {
  const { io, stderr } = collectIo()
  const program = createProgram(io)
  const threads = program.commands.find((command) => command.name() === "threads")
  if (!threads) throw new Error("threads command is not registered")
  let captured: Record<string, unknown> | undefined
  threads.action(async (_subcommand: string, _args: string[], options: Record<string, unknown>) => {
    captured = options
  })

  try {
    await program.parseAsync(["node", "b4", ...argv])
  } catch (error) {
    return { error, stderr, options: captured }
  }
  return { stderr, options: captured }
}

describe("b4 threads tail flag parsing", () => {
  it("binds --url, repeated --header, and --json to the threads command", async () => {
    const { error, stderr, options } = await parse([
      "threads",
      "tail",
      "t1",
      "--url",
      "http://127.0.0.1:9/",
      "--header",
      "x-a: 1",
      "--header",
      "x-b: 2",
      "--json",
    ])

    expect(stderr.join("")).not.toMatch(/unknown option/)
    expect(error).toBeUndefined()
    expect(options?.url).toBe("http://127.0.0.1:9/")
    expect(options?.json).toBe(true)
    // Repeated --header accumulates into a list rather than overwriting.
    expect(options?.header).toEqual(["x-a: 1", "x-b: 2"])
  })
})

describe("b4 threads dispatch", () => {
  it("rejects a missing subcommand naming the usage", async () => {
    const { io } = collectIo()
    const program = createProgram(io)
    await expect(program.parseAsync(["node", "b4", "threads"])).rejects.toThrow()
  })
})

describe("resolveTailRequest", () => {
  it("builds the attach URL against the default base", () => {
    const request = resolveTailRequest("t1", {})
    expect(request.url.toString()).toBe("http://127.0.0.1:3000/threads/t1/runs/stream")
    expect(request.json).toBe(false)
    expect(request.headers).toEqual({})
  })

  it("encodes the thread id and honours a custom --url base", () => {
    const request = resolveTailRequest("t 1", { url: "http://example.test:9/" })
    expect(request.url.toString()).toBe("http://example.test:9/threads/t%201/runs/stream")
  })

  it("parses repeated --header on the first colon only, keeping later colons in the value", () => {
    const request = resolveTailRequest("t1", { header: ["x-a: 1", "x-b: http://x:1"] })
    expect(request.headers).toEqual({ "x-a": "1", "x-b": "http://x:1" })
  })

  it("sets json from --json", () => {
    const request = resolveTailRequest("t1", { json: true })
    expect(request.json).toBe(true)
  })

  it("rejects a header with no colon", () => {
    expect(() => resolveTailRequest("t1", { header: ["nocolon"] })).toThrow(CliError)
  })

  it("rejects a header with an empty name", () => {
    expect(() => resolveTailRequest("t1", { header: [": value"] })).toThrow(CliError)
  })

  it.each([
    "TEST_ONLY_CREDENTIAL",
    ": TEST_ONLY_CREDENTIAL",
    "authorization: Bearer TEST_ONLY_CREDENTIAL\ninvalid",
  ])("rejects malformed headers without exposing their values", (header) => {
    let error: unknown
    try {
      resolveTailRequest("t1", { header: [header] })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(CliError)
    expect(String(error)).not.toContain("TEST_ONLY_CREDENTIAL")
  })

  it.each(["not a url TEST_ONLY_CREDENTIAL", "https://user:TEST_ONLY_CREDENTIAL@example.test"])(
    "rejects unsafe base URLs without echoing credentials",
    (url) => {
      let error: unknown
      try {
        resolveTailRequest("t1", { url })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(CliError)
      expect(String(error)).not.toContain("TEST_ONLY_CREDENTIAL")
    },
  )

  it("does not echo credential-bearing transport exceptions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("Invalid authorization value Bearer TEST_ONLY_CREDENTIAL"))
    const { io } = collectIo()
    try {
      let error: unknown
      try {
        await runThreadsCommand(
          "tail",
          ["t1"],
          { header: ["authorization: Bearer TEST_ONLY_CREDENTIAL"] },
          io,
        )
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(CliError)
      expect(String(error)).not.toContain("TEST_ONLY_CREDENTIAL")
      expect(String(error)).toContain("Cannot reach")
    } finally {
      fetchMock.mockRestore()
    }
  })

  it("throws a CliError(2) for an unparseable --url", () => {
    try {
      resolveTailRequest("t1", { url: "not a url" })
      throw new Error("expected resolveTailRequest to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(2)
    }
  })
})

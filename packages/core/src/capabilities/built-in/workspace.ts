import type { PermissionsStore } from "@b4run/permissions"
import { POSIX_SEP, pureJoin, pureRelative, pureResolve } from "@b4run/sdk/pure"
import type { BackendContext, ExecBackend, FilesystemBackend } from "@b4run/workspace"
import { z } from "zod"

import { gateBashOp } from "../permission-gate.js"
import type { B4ToolDefinition, CapabilityMarker } from "../types.js"
import { createWorkspaceFs } from "../workspace-fs.js"

const WORKSPACE_DIRNAME = "workspace"

/**
 * Resolve the workspace root relative to the given app root. In production
 * (`b4 dev`) appRoot === process.cwd(), so this is a no-op change there.
 * In-process testing harnesses pass the explicit app root so capabilities
 * activate regardless of the test runner's working directory.
 */
function workspaceRoot(appRoot: string): string {
  return pureJoin(appRoot, WORKSPACE_DIRNAME)
}

const READ_FILE_INPUT = z.object({
  path: z.string().min(1),
  startLine: z
    .number()
    .int()
    .min(1)
    .nullish()
    .describe("First line to return, 1-based. Omit (with endLine) to read the whole file."),
  endLine: z
    .number()
    .int()
    .min(1)
    .nullish()
    .describe("Last line to return, 1-based and inclusive. May exceed the file's length."),
})
const WRITE_FILE_INPUT = z.object({ path: z.string().min(1), content: z.string() })
const EDIT_FILE_INPUT = z.object({
  path: z.string().min(1),
  oldText: z
    .string()
    .min(1)
    .describe("Exact text to replace, including whitespace and line endings."),
  newText: z.string().describe("Replacement text."),
  replaceAll: z
    .boolean()
    .nullish()
    .describe(
      "Replace every non-overlapping occurrence, left to right, instead of requiring exactly one.",
    ),
})
const LIST_DIR_INPUT = z.object({ path: z.string().default(".") })
const RUN_BASH_INPUT = z.object({ command: z.string().min(1) })

function backendContext(workspaceRoot: string, signal: AbortSignal): BackendContext {
  return { signal, workspaceRoot }
}

/**
 * Slice a whole-file read down to a 1-based inclusive line range, with a
 * one-line header telling the model the file's length and where it is. Lines
 * are split on "\n" only, so a CRLF file keeps its "\r" bytes. A trailing
 * newline ends the last line rather than starting an empty one.
 */
function sliceLines(
  path: string,
  data: string,
  startLine: number | undefined,
  endLine: number | undefined,
): string {
  const lines = data.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const total = lines.length
  const start = startLine ?? 1
  if (endLine !== undefined && start > endLine) {
    throw new Error(`readFile: startLine (${start}) is greater than endLine (${endLine})`)
  }
  if (start > total) {
    throw new Error(`readFile: startLine ${start} is past the end of ${path} (${total} lines)`)
  }
  const end = Math.min(endLine ?? total, total)
  const header = `[${path} lines ${start}-${end} of ${total}]`
  return `${header}\n${lines.slice(start - 1, end).join("\n")}`
}

/** 1-based line number of each character offset in `text`. */
function lineNumbersAt(text: string, offsets: readonly number[]): number[] {
  const result: number[] = []
  let line = 1
  let cursor = 0
  for (const offset of offsets) {
    for (; cursor < offset; cursor++) {
      if (text.charCodeAt(cursor) === 10) line++
    }
    result.push(line)
  }
  return result
}

/** A bare "\n" (not preceded by "\r") anywhere in `text`. */
const BARE_LF = /(^|[^\r])\n/

/**
 * Replace `oldText` with `newText` in `content` by exact string match.
 *
 * Without `replaceAll`, `oldText` must occur exactly once, and uniqueness
 * counts OVERLAPPING matches: `aa` occurs twice in `aaa`, so that edit is
 * refused as ambiguous rather than silently applied to the first match.
 * With `replaceAll`, occurrences are replaced non-overlapping, left to right
 * (`aa` in `aaa` replaces the first two characters once).
 *
 * Splicing by offset (rather than String.prototype.replace) keeps `$`
 * sequences in `newText` literal.
 */
function applyEdit(
  path: string,
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): { readonly content: string; readonly lines: readonly number[] } {
  if (oldText.length === 0) throw new Error(`editFile: oldText must not be empty`)
  const first = content.indexOf(oldText)
  if (first === -1) {
    const crlfHint =
      content.includes("\r\n") && BARE_LF.test(oldText)
        ? " (the file uses CRLF line endings, but oldText contains bare \\n line breaks)"
        : ""
    throw new Error(`oldText not found in ${path}${crlfHint}`)
  }
  if (!replaceAll && content.indexOf(oldText, first + 1) !== -1) {
    let count = 0
    for (let at = first; at !== -1; at = content.indexOf(oldText, at + 1)) count++
    throw new Error(
      `oldText occurs ${count} times in ${path}; include more surrounding text or set replaceAll`,
    )
  }
  const offsets: number[] = [first]
  if (replaceAll) {
    for (
      let at = content.indexOf(oldText, first + oldText.length);
      at !== -1;
      at = content.indexOf(oldText, at + oldText.length)
    ) {
      offsets.push(at)
    }
  }
  let next = ""
  let cursor = 0
  for (const at of offsets) {
    next += content.slice(cursor, at) + newText
    cursor = at + oldText.length
  }
  next += content.slice(cursor)
  return { content: next, lines: lineNumbersAt(content, offsets) }
}

/**
 * Decode a file for editing, refusing rather than guessing: a lossy decode
 * would turn every invalid byte into U+FFFD and the write-back would corrupt
 * the whole file. `ignoreBOM` keeps a leading BOM in the decoded text so the
 * write-back preserves it.
 */
function decodeUtf8ForEdit(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error(
      `editFile: ${path} is not valid UTF-8; editFile only edits UTF-8 text files, and the file was left unchanged`,
    )
  }
}

function describeEdit(path: string, lines: readonly number[]): string {
  const count = lines.length
  const noun = count === 1 ? "occurrence" : "occurrences"
  const shown = lines.slice(0, 20).join(", ")
  const more = count > 20 ? `, and ${count - 20} more` : ""
  const where = count === 1 ? `line ${shown}` : `lines ${shown}${more}`
  return `replaced ${count} ${noun} in ${path} at ${where}`
}

interface OverridableTool extends B4ToolDefinition {
  readonly overridable: true
}

/**
 * Backend resolution, deferred to the first tool invocation that needs it:
 * an already-constructed instance wins, then the runtime's factory, then a
 * loud failure. Deferring keeps `load` working on runtimes that contribute the
 * tools but never call them, and keeps the failure attached to the operation
 * that actually needed a backend.
 */
function backendResolver<T>(
  instance: T | undefined,
  factory: (() => T) | undefined,
  what: string,
): () => T {
  let resolved: T | undefined = instance
  return () => {
    if (resolved === undefined) {
      if (!factory) {
        throw new Error(
          `workspace ${what} backend: no instance provided and this runtime has no ${what} fallback — pass one via context.backendFactories (see the edge deployment docs).`,
        )
      }
      resolved = factory()
    }
    return resolved
  }
}

function buildWorkspaceTools(
  workspaceRoot: string,
  resolveFs: () => FilesystemBackend,
  resolveExec: () => ExecBackend,
  permissions: PermissionsStore | undefined,
): readonly OverridableTool[] {
  // Agent tools run inside the graph, so the handle may surface the
  // interactive LangGraph permission interrupt.
  function handleFor(signal: AbortSignal) {
    return createWorkspaceFs({
      workspaceRoot,
      backend: resolveFs(),
      permissions,
      signal,
      interruptCapable: true,
    })
  }
  const readFile: OverridableTool = {
    name: "readFile",
    description:
      "Read a UTF-8 file from the workspace. Pass startLine/endLine (1-based, inclusive) to read part of a file; " +
      "the result then begins with a `[<path> lines a-b of N]` header. Read large files (thousands of lines) in ranges, " +
      "and change them with editFile instead of rewriting them with writeFile. The read size cap (256 KiB by default) " +
      "applies to the whole file even when a range is requested.",
    schema: READ_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const parsed = READ_FILE_INPUT.parse(input)
      const { path } = parsed
      const startLine = parsed.startLine ?? undefined
      const endLine = parsed.endLine ?? undefined
      const handle = handleFor(ctx.signal)
      // Same containment arithmetic as the path jail (workspace-fs.ts): an
      // absolute `path` discards the root, so a read that escapes the
      // workspace produces a `../…` relative path and never inherits the
      // uncapped-read exemption.
      const absPath = pureResolve(workspaceRoot, path)
      const rel = pureRelative(workspaceRoot, absPath)
      // NOTE: must match SUBDIR ("tool-outputs") in @b4run/langchain offload-store.ts
      const isToolOutput = rel === "tool-outputs" || rel.startsWith(`tool-outputs${POSIX_SEP}`)
      const data = await handle.readFile(
        path,
        isToolOutput ? { maxBytes: Number.POSITIVE_INFINITY } : undefined,
      )
      const fs = resolveFs()
      if (isToolOutput && fs.touchFile) {
        try {
          await fs.touchFile(absPath, backendContext(workspaceRoot, ctx.signal))
        } catch {
          /* touch is best-effort; never fail a read because of it */
        }
      }
      if (startLine === undefined && endLine === undefined) return data
      return sliceLines(path, data, startLine, endLine)
    },
  }
  const writeFile: OverridableTool = {
    name: "writeFile",
    description:
      "Write a UTF-8 file inside the workspace, replacing its whole content. To change an existing file, " +
      "prefer editFile: rewriting a large file in full risks truncating it.",
    schema: WRITE_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path, content } = WRITE_FILE_INPUT.parse(input)
      const result = await handleFor(ctx.signal).writeFile(path, content)
      return `wrote ${result.bytesWritten} bytes to ${path}`
    },
  }
  const editFile: OverridableTool = {
    name: "editFile",
    description:
      "Edit a UTF-8 file in the workspace by replacing oldText with newText. oldText must match the file exactly " +
      "(whitespace and line endings included) and occur exactly once unless replaceAll is true; include enough " +
      "surrounding lines to make it unique (overlapping matches count). With replaceAll, occurrences are replaced " +
      "non-overlapping, left to right. Prefer this to writeFile for changing an existing file. Files over the read " +
      "size cap (256 KiB by default) cannot be edited, and non-UTF-8 files are refused.",
    schema: EDIT_FILE_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path, oldText, newText, replaceAll } = EDIT_FILE_INPUT.parse(input)
      // Both halves go through the same permission-gated handle as readFile
      // and writeFile: the read is gated as a read, the write as a write.
      // Bytes, not text, so a non-UTF-8 file is refused instead of rewritten
      // with U+FFFD in place of every invalid byte.
      const handle = handleFor(ctx.signal)
      const current = decodeUtf8ForEdit(path, await handle.readBinaryFile(path))
      const edit = applyEdit(path, current, oldText, newText, replaceAll === true)
      if (newText === oldText) {
        return `no change: newText is identical to oldText in ${path}; the file was not written`
      }
      // Not atomic: a concurrent writer between this read and the write below
      // is overwritten. The workspace backends offer no compare-and-swap.
      await handle.writeFile(path, edit.content)
      return describeEdit(path, edit.lines)
    },
  }
  const listDir: OverridableTool = {
    name: "listDir",
    description: "List entries in a workspace directory.",
    schema: LIST_DIR_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { path } = LIST_DIR_INPUT.parse(input)
      return [...(await handleFor(ctx.signal).listDir(path))]
    },
  }
  const runBash: OverridableTool = {
    name: "runBash",
    description: "Run a shell command inside the workspace.",
    schema: RUN_BASH_INPUT,
    overridable: true,
    run: async (input, ctx) => {
      const { command } = RUN_BASH_INPUT.parse(input)
      const gate = await gateBashOp(permissions, command)
      if (!gate.allowed) {
        throw new Error(gate.reason)
      }
      return resolveExec().runCommand({ command }, backendContext(workspaceRoot, ctx.signal))
    },
  }
  return [readFile, writeFile, editFile, listDir, runBash]
}

export function createWorkspaceMarker(): CapabilityMarker {
  return {
    name: "workspace",
    detect: async (_routeDir, context) =>
      context.workspaceRoot !== undefined ||
      (context.markerFs?.existsSync(workspaceRoot(context.appRoot)) ?? false),
    load: async (_routeDir, context) => {
      const root = context.workspaceRoot ?? workspaceRoot(context.appRoot)
      if (context.workspaceRoot === undefined && !(context.markerFs?.existsSync(root) ?? false))
        return {}
      const resolveFs = backendResolver(
        context.backends?.filesystem,
        context.backendFactories?.filesystem,
        "filesystem",
      )
      const resolveExec = backendResolver(
        context.backends?.exec,
        context.backendFactories?.exec,
        "exec",
      )
      const permissions = context.permissions

      if (permissions?.mode === "bypass") {
        console.warn(
          "[b4:permissions] mode=bypass — path-jail disabled, all bash unrestricted. Do not use in production.",
        )
      }

      return {
        tools: buildWorkspaceTools(root, resolveFs, resolveExec, permissions),
      }
    },
  }
}

export interface BuildStubArgs {
  readonly content: string
  readonly relPath: string
  readonly previewLines: number
  readonly thresholdChars: number
}

/**
 * Hard cap on the preview's characters, whatever `previewLines` allows. Lines
 * bound a normal preview, but one line can be arbitrarily long (minified JSON,
 * a grep hit on a bundle), and the stub exists precisely to keep oversized
 * output out of the model context.
 */
export const STUB_PREVIEW_MAX_CHARS = 8192

/**
 * Source text used for the preview slice. When the offloaded content is a
 * single-line JSON blob (e.g. a tool returned an object, so newlines are escaped
 * as `\n`), pretty-print it so the preview shows readable lines instead of one
 * giant escaped line. A JSON string literal (a tool that returned a string) is
 * decoded to its text. Plain-text content (the common case) is returned as-is.
 * Only the preview is affected — the stored file and its hash are unchanged.
 */
function previewSource(content: string): string {
  const trimmed = content.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(content)
      return typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)
    } catch {
      // Not valid JSON — fall through to the raw content.
    }
  }
  return content
}

export interface Preview {
  readonly text: string
  readonly lines: number
  /** True when the character cap cut the preview short. */
  readonly clipped: boolean
}

/** The first `previewLines` lines of `content`, capped at `maxChars` characters. */
export function buildPreview(content: string, previewLines: number, maxChars: number): Preview {
  // Slice before splitting so a multi-megabyte output is never split whole.
  const source = previewSource(content)
  const head = source.slice(0, maxChars + 1)
  const lines = head.split("\n").slice(0, previewLines)
  const joined = lines.join("\n")
  const clipped = joined.length > maxChars
  return {
    text: clipped ? joined.slice(0, maxChars) : joined,
    lines: lines.length,
    clipped,
  }
}

export function buildStub(args: BuildStubArgs): string {
  const preview = buildPreview(args.content, args.previewLines, STUB_PREVIEW_MAX_CHARS)
  const chars = args.content.length.toLocaleString("en-US")
  const threshold = args.thresholdChars.toLocaleString("en-US")
  return [
    `[Tool output offloaded — ${chars} chars exceeded the ${threshold}-char limit.`,
    `Full output saved to: ${args.relPath}`,
    `Preview (first ${preview.lines} lines${preview.clipped ? `, clipped to ${STUB_PREVIEW_MAX_CHARS.toLocaleString("en-US")} chars` : ""}):`,
    preview.text,
    `Read the full output with the readFile tool at the path above.]`,
  ].join("\n")
}

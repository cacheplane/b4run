/**
 * Incremental Server-Sent Events parser for the Agent Protocol attach stream.
 *
 * Deliberately structural: it knows the SSE framing and nothing about B4.run's
 * frame vocabulary, so `b4 threads tail` consumes the documented wire the way
 * any third-party client would rather than importing the server's own types.
 */
export interface SseFrame {
  /** The `event:` name, or SSE's default `"message"` when the block omits one. */
  readonly event: string
  /** Parsed `data:` payload. Absent on a bare `retry:` block. */
  readonly data?: unknown
  /** Present on a block carrying `retry:`. */
  readonly retry?: number
  /** The raw data text, present only when it could not be parsed as JSON. */
  readonly raw?: string
  readonly malformed?: boolean
}

export interface SseFrameParser {
  /** Feed decoded text; returns every frame completed by this chunk. */
  push(text: string): SseFrame[]
}

export function createSseFrameParser(): SseFrameParser {
  let buffer = ""
  let skipLf = false
  return {
    push(text) {
      // Normalize CR, LF and CRLF incrementally, including a CRLF pair split
      // across chunks. A CR already completes its line; only its LF is skipped.
      for (const character of text) {
        if (skipLf && character === "\n") {
          skipLf = false
          continue
        }
        skipLf = character === "\r"
        buffer += skipLf ? "\n" : character
      }
      const frames: SseFrame[] = []
      for (;;) {
        const end = buffer.indexOf("\n\n")
        if (end === -1) return frames
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)

        let event: string | undefined
        let retry: number | undefined
        const dataLines: string[] = []
        for (const line of block.split("\n")) {
          // A leading colon is a comment — this is how the server's keepalive
          // (`: ping`) arrives. Never a frame.
          if (line.startsWith(":")) continue
          const colon = line.indexOf(":")
          const field = colon === -1 ? line : line.slice(0, colon)
          const rawValue = colon === -1 ? "" : line.slice(colon + 1)
          const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue
          if (field === "event") event = value
          else if (field === "data") dataLines.push(value)
          else if (field === "retry" && /^\d+$/.test(value)) {
            const delay = Number(value)
            if (Number.isFinite(delay)) retry = delay
          }
          // `id:` and unknown fields are ignored: this wire carries no ids, and
          // reconnect is a fresh snapshot rather than a cursor resume.
        }
        if (dataLines.length === 0 && retry === undefined) continue

        const name = event || "message"
        if (dataLines.length === 0) {
          frames.push(retry === undefined ? { event: name } : { event: name, retry })
          continue
        }
        // SSE folds data lines with actual newlines before interpreting JSON.
        // Invalid JSON stays malformed; framing must not rewrite its contents.
        const raw = dataLines.join("\n")
        try {
          const parsed: unknown = JSON.parse(raw)
          frames.push(
            retry === undefined
              ? { event: name, data: parsed }
              : { event: name, data: parsed, retry },
          )
        } catch {
          frames.push({
            event: name,
            malformed: true,
            raw,
            ...(retry !== undefined ? { retry } : {}),
          })
        }
      }
    },
  }
}

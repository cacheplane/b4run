import { CAPTURE_MAX_BYTES, parseCapture } from "./capture-schema"
/** The only fetch target is a content-addressed static recording on this origin. */
export async function readVerifiedAsset(
  digest: string,
  kind: "recording" | "source",
  signal?: AbortSignal,
) {
  const limit = kind === "source" ? 256_000 : CAPTURE_MAX_BYTES
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid capture digest")
  const response = await fetch(`/docs-recordings/${digest}.${kind === "source" ? "txt" : "json"}`, {
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
  })
  if (!response.ok) throw new Error(`Recording unavailable (${response.status})`)
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    throw new Error("Recording byte limit exceeded")
  }
  if (!response.body) throw new Error("Empty recording response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error("Recording byte limit exceeded")
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("")
  if (actual !== digest) throw new Error("Recording digest mismatch")
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

export async function readCaptureAsset(digest: string, signal?: AbortSignal) {
  return parseCapture(await readVerifiedAsset(digest, "recording", signal))
}

import { type B4ContentPart, type B4MediaPart, isContentPart } from "@b4run/sdk"

/**
 * Content parts as the app renders them. Pure, no React: the shapes here are
 * AG-UI 1.0's `ContentPart` (`@b4run/sdk` declares them structurally
 * identical). Live and restored messages both carry `string | ContentPart[]`:
 * the replay converts LangChain's stored blocks server-side.
 */

/** A message's content as a part list: a string is one text part, an array keeps its valid parts. */
export function partsOf(content: unknown): B4ContentPart[] {
  if (typeof content === "string")
    return content.length > 0 ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.filter(isContentPart)
}

/** The parts that are not text — what a bubble or card has to draw beside its text. */
export function mediaParts(parts: readonly B4ContentPart[]): B4MediaPart[] {
  return parts.filter((part): part is B4MediaPart => part.type !== "text")
}

/**
 * Something an `<img src>` can load: inline bytes as a `data:` URL, a URL
 * source as itself. A provider file handle has no browser-loadable form, so it
 * is `undefined` and the caller shows the handle instead.
 */
export function dataUrl(part: B4MediaPart): string | undefined {
  const { source } = part
  if (source.type === "data") return `data:${source.mimeType};base64,${source.value}`
  if (source.type === "url") return source.value
  return undefined
}

import type { B4ContentPart, B4MediaPart } from "@b4run/sdk"
import { memo } from "react"
import { dataUrl, mediaParts } from "../lib/parts"

/**
 * The non-text parts of a user message or a tool result, drawn beside the
 * text the bubble or card already shows. Text parts are skipped on purpose:
 * rendering them here too would print the message twice.
 *
 * - An image with a loadable source is an `<img>`; audio and video get the
 *   native players.
 * - A document is a download chip.
 * - Anything held as a provider file handle (`source.type === "file"`) has no
 *   browser-loadable form, so it is a chip that names the handle — the
 *   honest thing to show for bytes that only the model provider can read.
 */
export function MediaParts({ parts }: { readonly parts: readonly B4ContentPart[] }) {
  const media = mediaParts(parts)
  if (media.length === 0) return null
  return (
    <div className="flex flex-col items-start gap-2">
      {media.map((part, index) => (
        // The part list is append-only per message and parts carry no stable
        // id of their own, so the position is the identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <MediaPart key={index} part={part} />
      ))}
    </div>
  )
}

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-wb-sm border border-wb-border bg-wb-surface px-2.5 py-1 text-[12px] text-wb-muted [overflow-wrap:anywhere]"

/**
 * Memoized: the part objects are stable references out of `agent.messages`,
 * and the transcript re-renders on every streamed token — decoding the same
 * base64 image on each of those is the cost this skips.
 */
const MediaPart = memo(function MediaPart({ part }: { readonly part: B4MediaPart }) {
  const src = loadableUrl(part)
  const name = filenameOf(part)
  if (src === undefined) {
    return (
      <span className={CHIP}>
        <span className="font-medium text-wb-text">{part.type}</span>
        {part.source.type === "file" ? <span>{part.source.value}</span> : null}
        {name !== undefined ? <span>{name}</span> : null}
      </span>
    )
  }
  switch (part.type) {
    case "image":
      return (
        // biome-ignore lint/performance/noImgElement: inline `data:` bytes from a message, which `next/image` has nothing to optimize
        <img
          src={src}
          alt={name ?? "image"}
          className="max-w-full rounded-wb border border-wb-border bg-wb-surface"
        />
      )
    case "audio":
      // biome-ignore lint/a11y/useMediaCaption: a model's or user's clip has no caption track to offer
      return <audio controls src={src} className="max-w-full" />
    case "video":
      // biome-ignore lint/a11y/useMediaCaption: a model's or user's clip has no caption track to offer
      return <video controls src={src} className="max-w-full rounded-wb border border-wb-border" />
    case "document":
      return (
        // The download name comes from the (allow-listed) MIME type, never from
        // `metadata.filename`: a model-driven tool could name it `invoice.exe`.
        // The filename is only the visible label.
        <a
          href={src}
          download={downloadName(part.source.mimeType)}
          className={`${CHIP} wb-focus hover:border-wb-muted`}
        >
          <span className="font-medium text-wb-text">document</span>
          <span>{name ?? part.source.mimeType ?? "download"}</span>
        </a>
      )
    default: {
      const unhandled: never = part.type
      return unhandled
    }
  }
})

/** The document types a link may be built for, and the extension each downloads as. */
const DOCUMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
}

function downloadName(mimeType: string | undefined): string | true {
  const extension = mimeType !== undefined ? DOCUMENT_EXTENSIONS[mimeType] : undefined
  return extension !== undefined ? `document.${extension}` : true
}

/**
 * Whether a part's declared MIME type matches what it claims to be: an image
 * must be `image/*`, audio `audio/*`, video `video/*`, a document one of
 * `DOCUMENT_EXTENSIONS`. A `data:` URL is served with exactly the type it
 * names, so an "image" whose bytes say `text/html` must never become a `src`
 * or an `href`. A url source with no declared type passes (the server decides).
 */
function isAllowedMimeType(part: B4MediaPart): boolean {
  const { mimeType } = part.source
  if (mimeType === undefined) return part.source.type !== "data"
  if (part.type === "document") return mimeType in DOCUMENT_EXTENSIONS
  return mimeType.startsWith(`${part.type}/`)
}

/**
 * A URL the browser may load: inline bytes, or an http(s) URL. Anything else a
 * `url` source might say (`javascript:`, `file:`) is shown as a chip instead,
 * because these parts can come from a tool result, which is model-driven.
 */
function loadableUrl(part: B4MediaPart): string | undefined {
  const url = dataUrl(part)
  if (url === undefined || !isAllowedMimeType(part)) return undefined
  // An http(s) URL source is still auto-loaded (an `<img src>` is a request to
  // that host, which a model-driven tool could use to exfiltrate); the
  // example's own `renderChart` emits inline `data` parts, never URLs.
  if (part.source.type === "data") return url
  return /^https?:\/\//i.test(url) ? url : undefined
}

/** `metadata.filename`, which the composer sets on an attachment. */
function filenameOf(part: B4MediaPart): string | undefined {
  const { metadata } = part
  if (typeof metadata !== "object" || metadata === null) return undefined
  const filename = (metadata as { filename?: unknown }).filename
  return typeof filename === "string" && filename.length > 0 ? filename : undefined
}

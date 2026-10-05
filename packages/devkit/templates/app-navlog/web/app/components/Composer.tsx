"use client"
import type { B4MediaPart } from "@b4run/sdk"
import { type ChangeEvent, type KeyboardEvent, useId, useRef, useState } from "react"
import { neutralButton } from "./ui"

/**
 * What a send hands up: the trimmed text, and the attached images as AG-UI
 * media parts (text is NOT repeated in `parts` — the shell decides how the two
 * become one message's content). `parts` is empty for a text-only send.
 */
export interface ComposerMessage {
  readonly text: string
  readonly parts: B4MediaPart[]
}

interface Attachment {
  readonly id: string
  readonly name: string
  readonly part: B4MediaPart
}

/**
 * A picked file as an inline image part: `readAsDataURL` gives
 * `data:<mime>;base64,<bytes>`, and the part wants the bytes and the type
 * separately. The filename rides in `metadata` so the transcript can label it.
 */
function readImage(file: File): Promise<B4MediaPart> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : ""
      const comma = url.indexOf(",")
      resolve({
        type: "image",
        source: { type: "data", value: url.slice(comma + 1), mimeType: file.type },
        metadata: { filename: file.name },
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

/**
 * The image types the composer attaches: the ones OpenAI's vision input takes.
 * The adapter has no image MIME gate of its own, so an `.svg` or `.heic` sent
 * from here would reach the provider and come back as a 400.
 */
const ATTACHABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const

/**
 * Per attachment. Every turn sends the WHOLE history over `/agui`, whose body
 * limit is 8 MiB, so one large image would make every later turn fail; base64
 * also grows the bytes by a third.
 */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024

export interface ComposerProps {
  readonly onSend: (message: ComposerMessage) => void
  /**
   * Whether the route's model takes an image (`multimodal.input.image` in its
   * capability document). False hides the attach control entirely: offering
   * an upload the model will never see is worse than not offering it.
   */
  readonly canAttachImages: boolean
  /** Aborts the in-flight run. */
  readonly onStop: () => void
  /** True while a run is in flight. */
  readonly isRunning: boolean
  /**
   * True while the agent is parked on an unresolved interrupt.
   *
   * A separate flag from `isRunning`, not a refinement of it: when B4.run's
   * permission gate parks a run, the run has *finished* — `isRunning` is false
   * and `agent.pendingInterrupts` is non-empty. Gating on `isRunning` alone
   * therefore leaves the composer live under an open approve/deny card, and
   * sending from there throws `Thread has N pending interrupt(s) not addressed
   * by resume` from inside `runAgent` — after the user's message is already in
   * the transcript.
   */
  readonly isAwaitingApproval: boolean
}

export function Composer({
  onSend,
  onStop,
  canAttachImages,
  isRunning,
  isAwaitingApproval,
}: ComposerProps) {
  const [value, setValue] = useState("")
  const [attachments, setAttachments] = useState<readonly Attachment[]>([])
  // Reads still in flight. Send waits for them: sending mid-read would drop
  // the image the user just picked, silently.
  const [pendingReads, setPendingReads] = useState(0)
  // One line about the last pick that did not become an attachment.
  const [attachHint, setAttachHint] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const isBlocked = isRunning || isAwaitingApproval
  // An image with no words is a complete question ("what is this?" is implied).
  const canSend =
    !isBlocked && pendingReads === 0 && (value.trim().length > 0 || attachments.length > 0)

  function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosen = [...(event.target.files ?? [])]
    // Cleared so picking the same file again (after removing it) still fires.
    event.target.value = ""
    // `accept` is a hint to the OS dialog, not a guarantee ("All files" is one
    // click away), so the type is checked again here.
    const images = chosen.filter((file) =>
      (ATTACHABLE_IMAGE_TYPES as readonly string[]).includes(file.type),
    )
    const tooLarge = images.filter((file) => file.size > MAX_ATTACHMENT_BYTES)
    const files = images.filter((file) => file.size <= MAX_ATTACHMENT_BYTES)
    setAttachHint(
      tooLarge[0] !== undefined
        ? `${tooLarge[0].name} is larger than 4 MB`
        : images.length < chosen.length
          ? "Only PNG, JPEG, GIF or WebP images can be attached"
          : null,
    )
    for (const file of files) {
      setPendingReads((count) => count + 1)
      void readImage(file)
        .then(
          (part) => {
            setAttachments((current) => [
              ...current,
              { id: globalThis.crypto.randomUUID(), name: file.name, part },
            ])
          },
          (error: unknown) => {
            console.error("Composer: could not read the attachment", error)
            setAttachHint(`Could not read ${file.name}`)
          },
        )
        .finally(() => {
          setPendingReads((count) => count - 1)
        })
    }
  }

  function send() {
    if (!canSend) return
    onSend({ text: value.trim(), parts: attachments.map((attachment) => attachment.part) })
    setValue("")
    setAttachments([])
    setAttachHint(null)
    // Sending empties the box, which flips `canSend` false and disables the
    // very button the user just activated — and a disabled element cannot hold
    // focus, so it lands on <body> and the next Tab restarts from the top of
    // the page. Put the caret back where the user is working.
    inputRef.current?.focus()
  }

  // Enter sends, Shift+Enter newlines. `isComposing` guards IME input: while a
  // Japanese or Chinese keyboard is composing, Enter commits the candidate and
  // must not send the message.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    send()
  }

  // A greyed-out box with no explanation reads as broken. Say which of the two
  // reasons it is — and say it in the accessibility tree too, via the
  // `aria-describedby` below, since "the text under the box" is a visual
  // relationship that assistive tech cannot infer.
  const placeholder = isAwaitingApproval
    ? "Waiting on your decision above…"
    : isRunning
      ? "The agent is working…"
      : "Ask the flight planner…"
  const hint = isAwaitingApproval
    ? "Allow or deny the request above to continue this conversation."
    : "Enter to send · Shift+Enter for a new line"

  return (
    <div className="border-t border-wb-border px-6 py-4">
      <form
        className="mx-auto max-w-3xl"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        {attachHint !== null ? (
          <p role="status" className="mb-2 text-[11px] text-wb-muted">
            {attachHint}
          </p>
        ) : null}
        {attachments.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                data-attachment=""
                className="inline-flex max-w-full items-center gap-1.5 rounded-wb-sm border border-wb-border bg-wb-surface py-0.5 pl-2.5 pr-1 text-[12px] text-wb-muted"
              >
                <span className="truncate">{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => {
                    setAttachments((current) =>
                      current.filter((candidate) => candidate.id !== attachment.id),
                    )
                  }}
                  className="wb-focus rounded-wb-sm px-1 leading-5 hover:text-wb-text"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2 rounded-wb border border-wb-border bg-wb-surface p-2 transition-colors focus-within:border-wb-muted">
          {canAttachImages ? (
            <>
              {/*
                A real button driving a hidden input, rather than a styled
                <label>: a label is not in the tab order, so a keyboard user
                could not reach the picker at all.
              */}
              <input
                ref={fileRef}
                type="file"
                accept={ATTACHABLE_IMAGE_TYPES.join(",")}
                multiple
                hidden
                tabIndex={-1}
                onChange={onFiles}
              />
              <button
                type="button"
                disabled={isBlocked}
                onClick={() => fileRef.current?.click()}
                className={`${neutralButton("md")} shrink-0 disabled:cursor-not-allowed disabled:opacity-40`}
              >
                Attach image
              </button>
            </>
          ) : null}
          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            // `readOnly` + `aria-disabled`, NOT `disabled`. An interrupt can
            // arrive mid-sentence, and `disabled` would yank focus out of the
            // box the user is typing in, hide it from assistive tech, and lose
            // the draft's reachability. `readOnly` keeps it focusable and
            // readable while refusing edits.
            readOnly={isAwaitingApproval}
            aria-disabled={isAwaitingApproval}
            aria-describedby={hintId}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label="Message"
            // `field-sizing-content` grows the box with the text, bounded by
            // `max-h-40` — without it, "Shift+Enter for a new line" produces a
            // one-row box the user cannot see their own message in.
            className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none field-sizing-content placeholder:text-wb-muted read-only:cursor-not-allowed"
          />
          {isRunning ? (
            // Swapped in rather than sitting alongside Send: the two are never
            // both meaningful, and without it a hung stream (where `isRunning`
            // never clears) leaves the composer dead with no way out but
            // abandoning the conversation.
            <button type="button" onClick={onStop} className={`${neutralButton("md")} shrink-0`}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              className="wb-primary-action wb-focus shrink-0 rounded-wb-sm px-3.5 py-1.5 text-[13px] font-medium tracking-tight transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isAwaitingApproval ? "Waiting" : "Send"}
            </button>
          )}
        </div>
        <p id={hintId} className="mt-2 text-[11px] text-wb-muted">
          {hint}
        </p>
      </form>
    </div>
  )
}

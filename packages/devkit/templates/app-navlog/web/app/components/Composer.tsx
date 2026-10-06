"use client"
import type { B4MediaPart } from "@b4run/sdk"
import {
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { neutralButton } from "./ui"

/** Eight 24 px lines plus the textarea's vertical padding: where growing stops and scrolling starts. */
const MAX_TEXTAREA_PX = 212

/**
 * Grows the textarea with its text where CSS `field-sizing: content` is not
 * supported (Firefox, older Safari). Where it is, the CSS does the work and
 * this does nothing, so there is exactly one sizing mechanism per browser.
 */
function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the re-measure trigger
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return
    node.style.height = "auto"
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_PX)}px`
    // `value` is the trigger: the height is re-measured whenever the text changes.
  }, [ref, value])
}

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
  useAutoGrow(inputRef, value)
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
    <div className="border-t border-wb-border px-3 pt-2.5 pb-3 md:px-4">
      <form
        className="mx-auto max-w-3xl"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        {attachHint !== null ? (
          <p role="status" className="mb-2 text-[11.5px] text-wb-muted">
            {attachHint}
          </p>
        ) : null}
        {attachments.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                data-attachment=""
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-wb-border bg-wb-surface py-0.5 pl-2.5 pr-0.5 text-[12px] text-wb-muted"
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
                  className="wb-focus inline-flex size-6 items-center justify-center rounded-full hover:bg-wb-rail hover:text-wb-text pointer-coarse:size-9"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {/*
          The box is a column: the textarea gets the full width, and the
          controls live in a toolbar row under it. Beside the textarea, the
          attach button used to squeeze the message to a third of the dock.
        */}
        <div className="rounded-wb border border-wb-border bg-wb-surface transition-colors focus-within:border-wb-muted">
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
            // `field-sizing-content` grows the box with the text up to eight
            // lines (8 × 24 px + padding), then it scrolls. Browsers without
            // it get the same growth from `useAutoGrow` above.
            className="block max-h-[13.25rem] min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[14px] leading-6 outline-none field-sizing-content placeholder:text-wb-muted read-only:cursor-not-allowed"
          />
          <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
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
                {/*
                  Icon-only, so the name is visually hidden text rather than an
                  `aria-label`: the accessible name AND the text content are
                  both "Attach image", which is what the tests find it by.
                  `title` is the pointer's tooltip.
                */}
                <button
                  type="button"
                  title="Attach image"
                  disabled={isBlocked}
                  onClick={() => fileRef.current?.click()}
                  className="wb-focus inline-flex size-8 shrink-0 items-center justify-center rounded-wb-sm text-wb-muted transition-colors hover:bg-wb-rail hover:text-wb-text disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:size-11"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="2" y="2.5" width="12" height="11" rx="2" />
                    <circle cx="5.75" cy="6.25" r="1.25" />
                    <path d="m14 11-3.25-3.25L5 13.5" />
                  </svg>
                  <span className="sr-only">Attach image</span>
                </button>
              </>
            ) : null}
            <p
              id={hintId}
              className={`min-w-0 flex-1 px-1 text-[11px] leading-4 ${
                isAwaitingApproval
                  ? "text-[var(--wb-chat-warn)]"
                  : "text-wb-muted pointer-coarse:sr-only"
              }`}
            >
              {hint}
            </p>
            {isRunning ? (
              // Swapped in rather than sitting alongside Send: the two are never
              // both meaningful, and without it a hung stream (where `isRunning`
              // never clears) leaves the composer dead with no way out but
              // abandoning the conversation.
              <button
                type="button"
                onClick={onStop}
                className={`${neutralButton("md")} inline-flex min-h-8 shrink-0 items-center gap-1.5 pointer-coarse:min-h-11`}
              >
                <span aria-hidden="true" className="size-2 rounded-[2px] bg-current" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                className="wb-primary-action wb-focus inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-wb-sm px-3 text-[13px] font-medium tracking-tight transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-4"
              >
                {isAwaitingApproval ? "Waiting" : "Send"}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M7 11.5v-9M3 6.5l4-4 4 4" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}

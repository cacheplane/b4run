"use client"

import { track } from "../../lib/analytics/client"
import { SIGNAL_EVENTS, type SignalSurface } from "../../lib/analytics/events"
import { CopyStatus, useCopyFeedback } from "../copy-feedback"
import { Icon } from "./Icon"

interface CopyCommandProps {
  readonly command: string
  /** light on paper (default); dark on the code panel (blog CTA, homepage takeaway). */
  readonly variant?: "light" | "dark"
  readonly className?: string
  /** Where the chip sits; when set, a copy is reported as an install signal. */
  readonly surface?: SignalSurface
}

/**
 * The `$ command` chip. The whole chip is the copy button (the icon alone was
 * a 21px target); the result shows beneath it, out of flow, and is announced.
 * Presentation lives in ui.css under `[data-ui="copy-command"]`.
 */
export function CopyCommand({ command, variant = "light", className, surface }: CopyCommandProps) {
  const { state, copy } = useCopyFeedback()
  const copied = state === "copied"

  return (
    <span data-ui="copy-command" data-variant={variant} {...(className ? { className } : {})}>
      <button
        type="button"
        onClick={() => {
          void copy(command)
          if (surface) track(SIGNAL_EVENTS.siteInstallCommandCopied, { surface })
        }}
        data-copied={copied}
        aria-label={`Copy command: ${command}`}
      >
        <span>
          <span>$</span> {command}
        </span>
        <span aria-hidden>
          <Icon name={copied ? "check" : "copy"} />
        </span>
      </button>
      <CopyStatus state={state} />
    </span>
  )
}

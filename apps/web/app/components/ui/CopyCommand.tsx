"use client"

import { CopyStatus, useCopyFeedback } from "../copy-feedback"
import { Icon } from "./Icon"

interface CopyCommandProps {
  readonly command: string
  /** light on paper (default); dark on the code panel (blog CTA, homepage takeaway). */
  readonly variant?: "light" | "dark"
  readonly className?: string
}

/**
 * The `$ command` chip. The whole chip is the copy button (the icon alone was
 * a 21px target); the result shows beneath it, out of flow, and is announced.
 * Presentation lives in ui.css under `[data-ui="copy-command"]`.
 */
export function CopyCommand({ command, variant = "light", className }: CopyCommandProps) {
  const { state, copy } = useCopyFeedback()
  const copied = state === "copied"

  return (
    <span data-ui="copy-command" data-variant={variant} {...(className ? { className } : {})}>
      <button
        type="button"
        onClick={() => void copy(command)}
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

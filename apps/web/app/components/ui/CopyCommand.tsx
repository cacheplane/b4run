"use client"

import { useState } from "react"
import { Icon } from "./Icon"

interface Props {
  readonly command: string
  /** light on paper (default); dark on the code panel (blog CTA, homepage takeaway). */
  readonly variant?: "light" | "dark"
  readonly className?: string
}

export function CopyCommand({ command, variant = "light", className }: Props) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // clipboard unavailable — silent no-op
    }
  }

  return (
    <div data-ui="copy-command" data-variant={variant} {...(className ? { className } : {})}>
      <span>
        <span>$</span> {command}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        data-copied={copied}
        aria-label={copied ? "Copied" : `Copy command: ${command}`}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  )
}

"use client"

import { CopyStatus, useCopyFeedback } from "./copy-feedback"
import { Button } from "./ui/Button"
import { Icon } from "./ui/Icon"

export type CopyPromptVariant = "hero" | "docs"

interface Props {
  readonly prompt: string
  readonly label?: string
  readonly variant?: CopyPromptVariant
  readonly ariaLabel?: string
}

export function CopyPromptButton({
  prompt,
  label = "Copy prompt",
  variant = "hero",
  ariaLabel,
}: Props) {
  const { state, copy } = useCopyFeedback()
  const copied = state === "copied"

  const isHero = variant === "hero"
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3">
      <Button
        onClick={() => void copy(prompt)}
        variant={isHero ? "primary" : "secondary"}
        {...(isHero ? {} : { size: "sm" as const, className: "mb-4" })}
        aria-label={ariaLabel ?? `${label} to clipboard`}
      >
        <Icon name={copied ? "check" : "copy"} />
        {copied ? "Copied" : label}
      </Button>
      {/* The button already shows success; failures are shown and announced here. */}
      <CopyStatus
        state={state}
        messages={{ idle: "", copied: "Prompt copied", error: "Copy failed" }}
        showSuccess={false}
        className={`text-xs ${isHero ? "" : "mb-4"}`}
      />
    </span>
  )
}

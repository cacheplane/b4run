"use client"

import { useState } from "react"
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
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable — silent no-op
    }
  }

  const isHero = variant === "hero"
  return (
    <Button
      onClick={handleCopy}
      variant={isHero ? "primary" : "secondary"}
      {...(isHero ? {} : { size: "sm" as const, className: "mb-4" })}
      aria-label={copied ? "Prompt copied" : (ariaLabel ?? `${label} to clipboard`)}
    >
      <Icon name={copied ? "check" : "copy"} />
      {copied ? "Copied" : label}
    </Button>
  )
}

"use client"

import { CopyStatus, useCopyFeedback } from "./copy-feedback"

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
  const baseClass = isHero
    ? "px-6 py-2.5 bg-accent-saas text-bg-primary rounded-md text-sm font-semibold hover:bg-accent-saas transition-colors inline-flex items-center gap-2"
    : "mb-4 px-4 py-1.5 border border-accent-saas/40 text-accent-saas rounded-md text-xs font-mono hover:border-accent-saas hover:bg-accent-saas/5 transition-colors inline-flex items-center gap-2"

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3">
      <button
        type="button"
        onClick={() => void copy(prompt)}
        className={baseClass}
        aria-label={ariaLabel ?? `${label} to clipboard`}
      >
        {copied ? (
          <>
            <svg
              width={isHero ? "14" : "12"}
              height={isHero ? "14" : "12"}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              role="img"
            >
              <title>Copied</title>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Copied
          </>
        ) : (
          <>
            <svg
              width={isHero ? "14" : "12"}
              height={isHero ? "14" : "12"}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              role="img"
            >
              <title>Copy</title>
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {label}
          </>
        )}
      </button>
      <CopyStatus
        state={state}
        messages={{ idle: "", copied: "Prompt copied", error: "Copy failed" }}
        showSuccess={false}
        className={`text-xs ${isHero ? "" : "mb-4"}`}
      />
    </span>
  )
}

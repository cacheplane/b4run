"use client"

import { CopyStatus, useCopyFeedback } from "./copy-feedback"

interface Props {
  readonly command: string
  readonly className?: string
}

export function CopyCommand({ command, className }: Props) {
  const { state, copy } = useCopyFeedback()
  const copied = state === "copied"

  // The whole pill is the copy button, so the tap target is the pill (the
  // icon alone was 21px). The result shows beneath it, out of flow.
  return (
    <span className={`relative inline-flex ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => void copy(command)}
        aria-label={`Copy command: ${command}`}
        className="group font-mono text-sm text-ink-muted bg-surface inline-flex min-h-11 md:min-h-0 items-center gap-2 pl-4 pr-2 py-2 rounded-md border border-divider text-left hover:border-divider-strong transition-colors"
      >
        <span>
          <span className="text-accent-saas">$</span> {command}
        </span>
        <span className="ml-1 p-1 rounded group-hover:bg-accent-saas-soft text-ink-muted group-hover:text-accent-saas transition-colors">
          {copied ? (
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              aria-hidden="true"
              className="text-accent-saas"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </span>
      </button>
      <CopyStatus
        state={state}
        className="absolute right-0 top-full z-10 mt-1 whitespace-nowrap rounded border border-divider bg-surface px-2 py-0.5 font-sans text-xs text-ink-muted"
      />
    </span>
  )
}

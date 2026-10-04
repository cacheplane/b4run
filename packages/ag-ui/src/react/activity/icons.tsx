import type { ReactElement } from "react"

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

/** One glyph per `ToolDisplayIcon` name plus `alert` and `check`; 16×16, `currentColor`, 1.3 stroke. */
const GLYPHS: Readonly<Record<string, ReactElement>> = {
  think: (
    <>
      <path
        d="M8 2.5a4 4 0 0 0-2.3 7.3c.4.3.6.7.6 1.2v.5h3.4V11c0-.5.2-.9.6-1.2A4 4 0 0 0 8 2.5Z"
        {...STROKE}
      />
      <path d="M6.6 13.5h2.8" {...STROKE} />
    </>
  ),
  plan: (
    <>
      <path d="M6 4h7M6 8h7M6 12h7" {...STROKE} />
      <path d="m2.5 4 .8.8L4.6 3.3M2.5 8l.8.8 1.3-1.5" {...STROKE} strokeWidth={1.2} />
      <circle cx="3.4" cy="12" r=".9" {...STROKE} strokeWidth={1.1} />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" {...STROKE} />
      <path d="m10.2 10.2 3.3 3.3" {...STROKE} />
    </>
  ),
  read: (
    <>
      <path d="M4 2h5.5L12 4.5V14H4z" {...STROKE} />
      <path d="M6 8h4M6 10.5h4" {...STROKE} strokeWidth={1.2} />
    </>
  ),
  write: <path d="M3 13l.6-2.6L10.5 3.5l2 2L5.6 12.4z" {...STROKE} />,
  run: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" {...STROKE} />
      <path d="m5 7 1.6 1.4L5 9.8M8.2 10h2.6" {...STROKE} strokeWidth={1.2} />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="5.5" {...STROKE} />
      <path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11" {...STROKE} strokeWidth={1.1} />
    </>
  ),
  memory: (
    <path
      d="M3 4.5C3 3.7 5.2 3 8 3s5 .7 5 1.5-2.2 1.5-5 1.5S3 5.3 3 4.5Zm0 0v7C3 12.3 5.2 13 8 13s5-.7 5-1.5v-7"
      {...STROKE}
    />
  ),
  agent: (
    <>
      <circle cx="8" cy="5.5" r="2.5" {...STROKE} />
      <path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" {...STROKE} />
    </>
  ),
  tool: (
    <>
      <circle cx="8" cy="8" r="2.2" {...STROKE} />
      <path
        d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4"
        {...STROKE}
        strokeWidth={1.2}
      />
    </>
  ),
  alert: (
    <>
      <path d="M8 5v3.5" {...STROKE} strokeWidth={1.5} />
      <circle cx="8" cy="11" r=".9" fill="currentColor" />
      <circle cx="8" cy="8" r="6" {...STROKE} />
    </>
  ),
  check: <path d="m3.5 8.5 2.8 2.8 6.2-6.6" {...STROKE} strokeWidth={1.5} />,
}

/**
 * A step's glyph. Unknown names draw the generic `tool` glyph; the own-key
 * lookup keeps a wire name like `constructor` off `Object.prototype`.
 */
export function StepIcon({ name }: { readonly name: string | undefined }): ReactElement {
  const glyph =
    name !== undefined && Object.hasOwn(GLYPHS, name)
      ? (GLYPHS[name] as ReactElement)
      : (GLYPHS.tool as ReactElement)
  return (
    <svg
      className="b4-step__icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      {glyph}
    </svg>
  )
}

/** The disclosure chevron; CSS rotates it 90° when open. */
export function Chevron(): ReactElement {
  return (
    <svg
      className="b4-chevron"
      viewBox="0 0 12 12"
      width="11"
      height="11"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 2l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

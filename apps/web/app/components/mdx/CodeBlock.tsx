"use client"

import {
  Children,
  type CSSProperties,
  createContext,
  Fragment,
  type HTMLAttributes,
  isValidElement,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import { CopyStatus, useCopyFeedback } from "../copy-feedback"
import { Icon } from "../ui/Icon"

interface PreProps extends HTMLAttributes<HTMLPreElement> {
  readonly children?: ReactNode
  readonly "data-language"?: string
  readonly "data-theme"?: string
}

/**
 * When a `<Pre>` is rendered inside a `<CodeGroup>`, the group owns the chrome
 * (frame + header). We use this context to tell the inner `<Pre>` to render
 * just its code body, with no border or header bar.
 */
export const HeadlessPreContext = createContext(false)

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  js: "js",
  javascript: "js",
  jsx: "jsx",
  json: "json",
  text: "text",
  plaintext: "text",
  md: "md",
  markdown: "md",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
}

export function tabLabel(language: string | undefined, title: string | undefined): string {
  if (title) return title
  if (!language) return "code"
  return LANGUAGE_LABELS[language.toLowerCase()] ?? language
}

export function Pre({ children, className, ...rest }: PreProps) {
  const ref = useRef<HTMLPreElement>(null)
  const headless = useContext(HeadlessPreContext)
  const title = (rest as Record<string, unknown>)["data-rehype-pretty-code-title"] as
    | string
    | undefined
  const language = rest["data-language"]

  if (headless) {
    return (
      <ScrollFade scrollerRef={ref}>
        <pre ref={ref} className={`overflow-x-auto pl-3 pr-4 py-3 ${className ?? ""}`} {...rest}>
          {children}
        </pre>
      </ScrollFade>
    )
  }

  const label = tabLabel(language, title)

  return (
    <div data-code-frame className="relative my-6 overflow-hidden">
      <CodeHeaderRow
        left={<TabPill label={label} active />}
        right={<CopyButton getText={() => ref.current?.textContent ?? ""} />}
      />
      <ScrollFade scrollerRef={ref}>
        <pre ref={ref} className={`overflow-x-auto pl-3 pr-4 py-3 ${className ?? ""}`} {...rest}>
          {children}
        </pre>
      </ScrollFade>
    </div>
  )
}

/**
 * Header bar used above the code body: left-aligned tab pill(s) plus the copy
 * button pinned to the right. The active pill renders its own underline.
 */
export function CodeHeaderRow({
  left,
  right,
}: {
  readonly left: ReactNode
  readonly right: ReactNode
}) {
  return (
    <div data-code-header className="flex items-end justify-between pl-[18px] pr-3 pt-2">
      {/* Tabs wrap onto a second row rather than scroll: a scrolling strip
          is a keyboard-unreachable scroll region (axe scrollable-region-focusable). */}
      <div className="flex min-w-0 flex-wrap items-end gap-1">{left}</div>
      <div className="pb-1.5">{right}</div>
    </div>
  )
}

/** File paths may break after each "/" before any mid-name break. */
function breakablePath(label: string): ReactNode {
  const parts = label.split("/")
  return parts.map((part, i) =>
    i < parts.length - 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: path segments are positional
      <Fragment key={i}>
        {part}/<wbr />
      </Fragment>
    ) : (
      part
    ),
  )
}

export function TabPill({
  label,
  active,
  onClick,
}: {
  readonly label: string
  readonly active: boolean
  readonly onClick?: () => void
}) {
  const isButton = typeof onClick === "function"
  const baseClasses = "relative px-2 py-1.5 text-left font-mono text-xs transition-colors"
  const underline = active ? (
    <span
      aria-hidden
      data-code-active-marker
      className="absolute left-1 right-1 -bottom-px h-[2px]"
    />
  ) : null

  if (isButton) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-code-tab
        role="tab"
        aria-selected={active}
        className={baseClasses}
      >
        {breakablePath(label)}
        {underline}
      </button>
    )
  }
  return (
    <span data-code-tab data-active={active} className={baseClasses}>
      {breakablePath(label)}
      {underline}
    </span>
  )
}

/**
 * Copies `getText()` and shows the result beside the button in a live region.
 * The `after:` inset grows the 28px button's hit area to 44px (it is measured
 * from the padding box, inside the 1px border).
 */
export function CopyButton({ getText }: { readonly getText: () => string }) {
  const { state, copy } = useCopyFeedback()
  const copied = state === "copied"
  return (
    <span className="inline-flex items-center gap-2">
      <CopyStatus state={state} className="text-xs text-ink-muted" />
      <button
        type="button"
        onClick={() => void copy(getText())}
        aria-label="Copy code"
        data-copied={copied}
        className={`relative p-1.5 border transition-colors after:absolute after:-inset-[9px] after:content-[''] ${
          copied
            ? "border-panel-accent text-panel-accent"
            : "border-panel-rule text-panel-dim hover:text-panel-ink hover:border-panel-muted"
        }`}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </span>
  )
}

/**
 * Wraps a horizontally scrolling `<pre>` with edge fades that appear while
 * there is more code off that edge, so clipped lines read as scrollable.
 */
function ScrollFade({
  scrollerRef,
  children,
}: {
  readonly scrollerRef: RefObject<HTMLPreElement | null>
  readonly children: ReactNode
}) {
  const [edges, setEdges] = useState({ start: false, end: false })
  const [background, setBackground] = useState<string | undefined>(undefined)
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    // Fade into whatever the code actually sits on: the panel inside a code
    // frame, or a caller's own background.
    for (let el: HTMLElement | null = scroller; el; el = el.parentElement) {
      const color = getComputedStyle(el).backgroundColor
      if (color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color)) {
        setBackground(color)
        break
      }
    }
    const update = () => {
      const max = scroller.scrollWidth - scroller.clientWidth
      const start = scroller.scrollLeft > 1
      const end = max - scroller.scrollLeft > 1
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    update()
    scroller.addEventListener("scroll", update, { passive: true })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    observer?.observe(scroller)
    return () => {
      scroller.removeEventListener("scroll", update)
      observer?.disconnect()
    }
  }, [scrollerRef])
  return (
    <div
      className="relative"
      data-code-scroll-fade={edges.end ? "end" : edges.start ? "start" : "none"}
      style={background ? ({ "--code-fade-bg": background } as CSSProperties) : undefined}
    >
      {children}
      {/* The gradients live in ui.css ([data-code-fade]) on the panel token. */}
      <span
        aria-hidden
        data-code-fade="start"
        className={`pointer-events-none absolute inset-y-0 left-0 w-6 transition-opacity ${
          edges.start ? "opacity-100" : "opacity-0"
        }`}
      />
      <span
        aria-hidden
        data-code-fade="end"
        className={`pointer-events-none absolute inset-y-0 right-0 w-8 transition-opacity ${
          edges.end ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  )
}

/**
 * MDX `<figure>` mapping for rehype-pretty-code output. When a fence carries a
 * `title="..."` meta, the plugin wraps the code in a `<figure>` containing a
 * `<figcaption>` (the title) and the `<pre>`. Without this mapping, the
 * figcaption renders as plain text above the code block. RehypeFigure absorbs
 * the figcaption into the standard header chrome and renders the inner Pre
 * headless.
 */
// Recursively pull the first non-empty string descendant out of a React node.
// Used to extract the figcaption's title text regardless of whether MDX
// delivers it as a bare string, an array, or nested inside a wrapper element —
// hydration mismatches happen when server and client see different shapes here.
function extractTextContent(node: ReactNode): string | undefined {
  if (typeof node === "string") {
    const trimmed = node.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = extractTextContent(child)
      if (found) return found
    }
    return undefined
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as { children?: ReactNode }
    return extractTextContent(props.children)
  }
  return undefined
}

export function RehypeFigure({
  children,
  ...rest
}: {
  readonly children?: ReactNode
} & Record<string, unknown>) {
  const isRehype = rest["data-rehype-pretty-code-figure"] !== undefined
  // Walk children deterministically with Children.toArray so server and client
  // see the same shape — manual iteration on a possibly-single-child `children`
  // was producing different `el.props` reads under hydration in some MDX
  // configurations.
  let title: string | undefined
  let preLanguage: string | undefined
  let preChild: ReactNode = null

  for (const c of Children.toArray(children)) {
    if (!isValidElement(c)) continue
    const props = (c.props ?? {}) as Record<string, unknown> & { children?: ReactNode }
    if (c.type === "figcaption") {
      const direct = props["data-rehype-pretty-code-title"]
      if (typeof direct === "string" && direct.length > 0) {
        title = direct
      } else {
        title = extractTextContent(props.children)
      }
      continue
    }
    // Otherwise treat as the inner Pre (or anything else passed through).
    const lang = props["data-language"]
    if (typeof lang === "string") preLanguage = lang
    preChild = c
  }

  if (!isRehype || !preChild) {
    return <figure {...rest}>{children}</figure>
  }

  const label = tabLabel(preLanguage, title)

  return (
    <figure data-code-frame {...rest} className="relative my-6 overflow-hidden">
      <RehypeFigureHeader label={label} preChild={preChild} />
      <HeadlessPreContext.Provider value={true}>{preChild}</HeadlessPreContext.Provider>
    </figure>
  )
}

function RehypeFigureHeader({ label, preChild }: { label: string; preChild: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  // The DOM <pre> is the next sibling of this header; resolve via the
  // wrapping figure to find it.
  const text = () => ref.current?.closest("figure")?.querySelector("pre")?.textContent ?? ""
  // Silence preChild-unused warning when the header doesn't need it:
  void preChild
  return (
    <span ref={ref}>
      <CodeHeaderRow
        left={<TabPill label={label} active />}
        right={<CopyButton getText={text} />}
      />
    </span>
  )
}

export function InlineCode({
  children,
  className,
}: {
  readonly children?: ReactNode
  readonly className?: string
}) {
  return <code className={`mdx-inline-code ${className ?? ""}`}>{children}</code>
}

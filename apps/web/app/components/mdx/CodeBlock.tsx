"use client"

import {
  Children,
  createContext,
  Fragment,
  type HTMLAttributes,
  isValidElement,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react"
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
  const [copied, setCopied] = useState(false)
  const headless = useContext(HeadlessPreContext)
  const title = (rest as Record<string, unknown>)["data-rehype-pretty-code-title"] as
    | string
    | undefined
  const language = rest["data-language"]

  const copy = async () => {
    const text = ref.current?.textContent ?? ""
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (headless) {
    return (
      <pre ref={ref} className={`overflow-x-auto pl-3 pr-4 py-3 ${className ?? ""}`} {...rest}>
        {children}
      </pre>
    )
  }

  const label = tabLabel(language, title)

  return (
    <div data-code-frame className="relative my-6 overflow-hidden">
      <CodeHeaderRow
        left={<TabPill label={label} active />}
        right={<CopyButton onCopy={copy} copied={copied} />}
      />
      <pre ref={ref} className={`overflow-x-auto pl-3 pr-4 py-3 ${className ?? ""}`} {...rest}>
        {children}
      </pre>
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

export function CopyButton({
  onCopy,
  copied,
}: {
  readonly onCopy: () => void
  readonly copied: boolean
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy code"}
      data-copied={copied}
      className={`p-1.5 border transition-colors ${
        copied
          ? "border-panel-accent text-panel-accent"
          : "border-panel-rule text-panel-dim hover:text-panel-ink hover:border-panel-muted"
      }`}
    >
      {copied ? <Icon name="check" /> : <Icon name="copy" />}
    </button>
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
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    // The DOM <pre> is the next sibling of this header; resolve via the
    // wrapping figure to find it.
    const figure = ref.current?.closest("figure")
    const pre = figure?.querySelector("pre")
    const text = pre?.textContent ?? ""
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  // Silence preChild-unused warning when the header doesn't need it:
  void preChild
  return (
    <span ref={ref}>
      <CodeHeaderRow
        left={<TabPill label={label} active />}
        right={<CopyButton onCopy={copy} copied={copied} />}
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

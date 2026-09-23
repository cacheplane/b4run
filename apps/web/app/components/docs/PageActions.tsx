"use client"

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import { CopyStatus, useCopyFeedback } from "../copy-feedback"
import { Button } from "../ui/Button"
import { Icon } from "../ui/Icon"
import { pageUrl, sourceSlug } from "./page-actions"

interface PageActionsProps {
  readonly slug: string
  /** The page's coding-agent prompt, when it has one. */
  readonly promptBody?: string
}

const GITHUB_EDIT_BASE = "https://github.com/cacheplane/b4run/edit/main/apps/web/content/docs"

function aiPrompt(slug: string): string {
  return `Read this B4.run docs page and help me apply it to my project: ${pageUrl(slug)}`
}

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3" cy="8" r="1.4" fill="currentColor" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="13" cy="8" r="1.4" fill="currentColor" />
    </svg>
  )
}

function PageIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  )
}

function ChatBubbleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

interface MenuItemBase {
  readonly key: string
  readonly icon: ReactNode
  readonly title: string
  readonly subtitle: string
}

type MenuItem =
  | (MenuItemBase & { readonly kind: "action"; readonly onSelect: () => void })
  | (MenuItemBase & { readonly kind: "link"; readonly href: string })

const STATUS_MESSAGES = {
  page: { idle: "", copied: "Page copied", error: "Copy failed" },
  prompt: { idle: "", copied: "Prompt copied", error: "Copy failed" },
} as const

async function pageMarkdown(slug: string): Promise<string> {
  const response = await fetch(`/api/markdown/${sourceSlug(slug)}`)
  if (!response.ok) throw new Error(String(response.status))
  return response.text()
}

/**
 * The same actions on every docs page: a "Copy page" button, and a menu
 * button (APG menu-button pattern: focus moves into the menu, arrow keys move
 * between items, Escape returns focus to the button) for the agent prompt,
 * AI assistants, and editing on GitHub.
 */
export function PageActions({ slug, promptBody }: PageActionsProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<keyof typeof STATUS_MESSAGES>("page")
  const { state, copy } = useCopyFeedback()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Which item to focus when the menu opens: first (click, Enter, ArrowDown) or last (ArrowUp).
  const focusOnOpen = useRef<"first" | "last">("first")
  const menuId = useId()
  const triggerId = useId()

  const items: MenuItem[] = [
    ...(promptBody
      ? [
          {
            kind: "action" as const,
            key: "prompt",
            icon: <Icon name="copy" />,
            title: "Copy agent prompt",
            subtitle: "Instructions to paste into your coding agent",
            onSelect: () => {
              setCopied("prompt")
              void copy(promptBody)
            },
          },
        ]
      : []),
    {
      kind: "link",
      key: "chatgpt",
      icon: <ChatBubbleIcon />,
      title: "Open in ChatGPT",
      subtitle: "Ask ChatGPT about this page",
      href: `https://chatgpt.com/?hints=search&q=${encodeURIComponent(aiPrompt(slug))}`,
    },
    {
      kind: "link",
      key: "claude",
      icon: <ChatBubbleIcon />,
      title: "Open in Claude",
      subtitle: "Ask Claude about this page",
      href: `https://claude.ai/new?q=${encodeURIComponent(aiPrompt(slug))}`,
    },
    {
      kind: "link",
      key: "github",
      icon: <PencilIcon />,
      title: "Edit on GitHub",
      subtitle: "Suggest changes in a pull request",
      href: `${GITHUB_EDIT_BASE}/${sourceSlug(slug)}.mdx`,
    },
  ]

  const menuItems = () => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ]

  const closeMenu = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (!open) return
    const all = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const target = focusOnOpen.current === "last" ? all.at(-1) : all[0]
    target?.focus()
  }, [open])

  // Close on a click outside.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open])

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      focusOnOpen.current = event.key === "ArrowUp" ? "last" : "first"
      setOpen(true)
    }
  }

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const all = menuItems()
    const index = all.indexOf(document.activeElement as HTMLElement)
    const focusAt = (i: number) => all[(i + all.length) % all.length]?.focus()
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        focusAt(index + 1)
        break
      case "ArrowUp":
        event.preventDefault()
        focusAt(index - 1)
        break
      case "Home":
        event.preventDefault()
        focusAt(0)
        break
      case "End":
        event.preventDefault()
        focusAt(all.length - 1)
        break
      case "Escape":
        event.preventDefault()
        closeMenu(true)
        break
      case "Tab":
        // Let focus leave naturally; the menu goes with it.
        setOpen(false)
        break
    }
  }

  const itemClass =
    "w-full text-left px-3 py-2 flex items-start gap-3 no-underline hover:bg-relay-tint focus:bg-relay-tint transition-colors"

  function renderItem(item: MenuItem) {
    const body = (
      <>
        <span className="mt-0.5 text-ink-muted shrink-0">{item.icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-ink">
            {item.title}
            {item.kind === "link" ? <span className="sr-only"> (opens in a new tab)</span> : null}
          </span>
          <span className="block text-xs text-ink-muted leading-snug">{item.subtitle}</span>
        </span>
      </>
    )
    if (item.kind === "link") {
      return (
        <a
          key={item.key}
          role="menuitem"
          tabIndex={-1}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => closeMenu(false)}
          className={itemClass}
        >
          {body}
        </a>
      )
    }
    return (
      <button
        key={item.key}
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={() => {
          item.onSelect()
          closeMenu(true)
        }}
        className={itemClass}
      >
        {body}
      </button>
    )
  }

  return (
    <div data-page-actions ref={containerRef} className="relative flex items-center gap-2">
      <CopyStatus
        state={state}
        messages={STATUS_MESSAGES[copied]}
        // Out of flow, so the result never shifts the buttons.
        className="absolute right-0 top-full mt-1 text-xs text-ink-muted whitespace-nowrap"
      />
      <Button
        variant="ghost"
        size="sm"
        data-copy-page
        onClick={() => {
          setCopied("page")
          void copy(pageMarkdown(slug))
        }}
        title="Copy this page as Markdown, for pasting into an LLM"
        className="shrink-0 min-h-11 md:min-h-8"
      >
        {state === "copied" && copied === "page" ? <Icon name="check" /> : <PageIcon />}
        Copy page
      </Button>

      <Button
        variant="ghost"
        size="icon"
        ref={triggerRef}
        id={triggerId}
        onClick={() => {
          focusOnOpen.current = "first"
          setOpen((o) => !o)
        }}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="More page actions"
        className="shrink-0 md:min-h-8 md:w-8"
      >
        <DotsIcon />
      </Button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full mt-2 w-72 z-30 py-1"
        >
          {items.map(renderItem)}
        </div>
      )}
    </div>
  )
}

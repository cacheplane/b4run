"use client"

import { usePathname, useRouter } from "next/navigation"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { Icon } from "../ui/Icon"
import {
  isTypingTarget,
  loadDocsSearchIndex,
  OPEN_DOCS_SEARCH_EVENT,
  openDocsSearch,
} from "./docs-search-events"
import {
  type DocsSearchHit,
  type DocsSearchResult,
  filterDocsSearchResults,
} from "./docs-search-results"

type IndexState =
  | { readonly status: "idle" | "loading" | "error" }
  | { readonly status: "ready"; readonly results: readonly DocsSearchResult[] }

const noSubscribe = () => () => {}

/**
 * `true` on Apple platforms, `false` elsewhere, `null` while server rendering
 * (so the shortcut hint renders only once the platform is known).
 */
export function useIsApplePlatform(): boolean | null {
  return useSyncExternalStore(
    noSubscribe,
    () => {
      const platform =
        (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ||
        navigator.platform ||
        navigator.userAgent
      return /mac|iphone|ipad|ipod/i.test(platform)
    },
    () => null,
  )
}

export function SearchShortcutHint({ className }: { readonly className?: string }) {
  const apple = useIsApplePlatform()
  if (apple === null) return null
  return (
    <kbd aria-hidden data-ui="kbd" {...(className ? { className } : {})}>
      {apple ? "⌘K" : "Ctrl K"}
    </kbd>
  )
}

const SHORTCUTS = "Meta+K Control+K /"

/** The docs sidebar's full-width search field button. */
export function DocsSearchTrigger() {
  return (
    <button
      type="button"
      onClick={openDocsSearch}
      onPointerEnter={() => void loadDocsSearchIndex().catch(() => {})}
      onFocus={() => void loadDocsSearchIndex().catch(() => {})}
      aria-haspopup="dialog"
      aria-keyshortcuts={SHORTCUTS}
      data-docs-search-trigger
      className="w-full flex items-center justify-between gap-3 px-3 py-2 border border-rule-strong bg-page text-sm text-ink-muted hover:border-ink hover:text-ink transition-colors mb-6"
    >
      <span className="flex items-center gap-2">
        <Icon name="search" />
        Search docs
      </span>
      <SearchShortcutHint />
    </button>
  )
}

function ResultBody({ hit }: { readonly hit: DocsSearchHit }) {
  const match = hit.match
  if (match?.kind === "alias") {
    return (
      <span className="block text-xs text-ink-muted truncate" data-search-match="alias">
        <code className="font-mono text-ink-muted">{match.alias}</code>
        {match.surface ? <> in {match.surface}</> : null}
      </span>
    )
  }
  if (match?.kind === "code") {
    return (
      <span className="block text-xs text-ink-muted truncate" data-search-match="code">
        <code className="font-mono text-ink-muted">{match.term}</code> in code examples
      </span>
    )
  }
  if (match?.kind === "text") {
    return (
      <span className="block text-xs text-ink-muted line-clamp-2" data-search-match="text">
        {match.before}
        <mark className="bg-relay-tint text-ink">{match.match}</mark>
        {match.after}
      </span>
    )
  }
  return null
}

/**
 * Site-wide docs search: a native modal `<dialog>` (the page behind is inert
 * and focus stays inside), with an ARIA combobox input driving a listbox of
 * results through `aria-activedescendant`. Opens with Cmd/Ctrl-K, "/", or the
 * open event; the index is fetched from a static route on first open.
 */
export function DocsSearch() {
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [index, setIndex] = useState<IndexState>({ status: "idle" })
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Whatever had focus when the dialog opened (a search trigger, or the page
  // under a keyboard shortcut); focus returns there on close.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const baseId = useId()
  const listId = `${baseId}-results`
  const optionId = (i: number) => `${baseId}-option-${i}`

  const results = useMemo<readonly DocsSearchHit[]>(
    () => (index.status === "ready" ? filterDocsSearchResults(query, index.results) : []),
    [index, query],
  )

  const load = useCallback(() => {
    setIndex((current) =>
      current.status === "ready" || current.status === "loading" ? current : { status: "loading" },
    )
    loadDocsSearchIndex().then(
      (loaded) => setIndex({ status: "ready", results: loaded }),
      () => setIndex({ status: "error" }),
    )
  }, [])

  const openSearch = useCallback(() => {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused !== document.body) {
      returnFocusRef.current = focused
    }
    setOpen(true)
    load()
  }, [load])

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setActive(0)
    const target = returnFocusRef.current
    returnFocusRef.current = null
    if (target?.isConnected) window.setTimeout(() => target.focus({ preventScroll: true }), 0)
  }, [])

  const navigate = useCallback(
    (href: string) => {
      returnFocusRef.current = null
      close()
      router.push(href)
    },
    [router, close],
  )

  // Native modal lifecycle: showModal makes the rest of the page inert.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      inputRef.current?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Lock page scroll while open.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Global shortcuts: Cmd/Ctrl-K anywhere, "/" when not typing.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey) return
      const commandK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"
      const slash =
        event.key === "/" && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target)
      if (!commandK && !slash) return
      event.preventDefault()
      if (open) inputRef.current?.focus()
      else openSearch()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener(OPEN_DOCS_SEARCH_EVENT, openSearch)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener(OPEN_DOCS_SEARCH_EVENT, openSearch)
    }
  }, [open, openSearch])

  // A completed navigation (including browser back) closes the dialog.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // Keep the active option in view.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${optionId(active)}"]`)
      ?.scrollIntoView?.({ block: "nearest" })
  })

  const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActive((a) => (results.length === 0 ? 0 : (a + 1) % results.length))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActive((a) => (results.length === 0 ? 0 : (a - 1 + results.length) % results.length))
    } else if (event.key === "Enter") {
      event.preventDefault()
      const hit = results[active]
      if (hit) navigate(hit.href)
    }
  }

  const trimmed = query.trim()
  const status =
    index.status === "error"
      ? "Search is unavailable. Check your connection and try again."
      : index.status !== "ready"
        ? open
          ? "Loading search…"
          : ""
        : !trimmed
          ? ""
          : results.length === 0
            ? `No results for “${trimmed}”`
            : `${results.length} result${results.length === 1 ? "" : "s"}`

  const activeHit = results[active]

  return (
    <dialog
      ref={dialogRef}
      data-docs-search-dialog
      data-docs-search-overlay
      aria-label="Search docs"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onClose={() => {
        if (open) close()
      }}
      onClick={(event) => {
        // A click on the dialog element itself is a click outside the panel.
        if (event.target === event.currentTarget) close()
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          close()
        }
      }}
      className="fixed inset-0 z-50 m-0 h-dvh max-h-none w-full max-w-none items-start justify-center border-0 p-0 pt-[12vh] backdrop-blur-sm backdrop:bg-transparent open:flex"
    >
      {/* The scrim and the panel are styled by ui.css ([data-docs-search-overlay]). */}
      <div className="w-full max-w-xl mx-4 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-rule">
          <Icon name="search" className="text-ink-muted" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search docs"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            {...(activeHit ? { "aria-activedescendant": optionId(active) } : {})}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onInputKey}
            placeholder="Search B4.run docs..."
            className="flex-1 min-w-0 bg-transparent text-ink placeholder:text-ink-muted text-sm"
          />
          <button type="button" onClick={close} aria-label="Close search" data-ui="kbd">
            ESC
          </button>
        </div>

        <p role="status" aria-live="polite" className="sr-only" data-docs-search-status>
          {status}
        </p>
        {index.status === "ready" ? null : (
          <p aria-hidden className="px-4 py-6 text-sm text-ink-muted text-center">
            {index.status === "error" ? status : "Loading search…"}
          </p>
        )}
        {index.status === "error" ? (
          <div className="pb-4 text-center">
            <button
              type="button"
              onClick={load}
              className="text-sm text-ink underline decoration-olive underline-offset-2"
            >
              Try again
            </button>
          </div>
        ) : null}
        {index.status === "ready" && trimmed && results.length === 0 ? (
          <p aria-hidden className="px-4 py-6 text-sm text-ink-muted text-center">
            {status}
          </p>
        ) : null}

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="max-h-[60vh] overflow-y-auto py-2 empty:hidden"
        >
          {results.map((hit, i) => {
            const selected = i === active
            return (
              // Options are never focused: the combobox input keeps focus and
              // points at the active option with aria-activedescendant.
              // biome-ignore lint/a11y/useFocusableInteractive: activedescendant pattern
              // biome-ignore lint/a11y/useKeyWithClickEvents: chosen with arrow keys and Enter in the input
              <div
                key={hit.key}
                id={optionId(i)}
                role="option"
                aria-selected={selected}
                data-active={selected}
                onMouseMove={() => {
                  if (!selected) setActive(i)
                }}
                onClick={() => navigate(hit.href)}
                className="cursor-pointer px-4 py-2.5"
              >
                <span
                  className={`block text-[10px] uppercase tracking-wider font-semibold whitespace-nowrap ${
                    selected ? "text-ink" : "text-ink-muted"
                  }`}
                >
                  {hit.section}
                </span>
                <span className="block text-sm font-semibold text-ink">
                  {hit.heading ? hit.heading.text : hit.title}
                </span>
                {hit.heading ? (
                  <span className="block text-xs text-ink-muted truncate">in {hit.title}</span>
                ) : null}
                <ResultBody hit={hit} />
              </div>
            )
          })}
        </div>
      </div>
    </dialog>
  )
}

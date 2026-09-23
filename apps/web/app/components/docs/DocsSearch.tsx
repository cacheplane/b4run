"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Icon } from "../ui/Icon"
import { OPEN_DOCS_SEARCH_EVENT } from "./docs-search-events"
import { filterDocsSearchResults, flattenDocsSearchIndex } from "./docs-search-results"
import type { DocsSearchEntry } from "./search-index"

interface Props {
  readonly index: readonly DocsSearchEntry[]
}

export function DocsSearch({ index }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // Whatever had focus when the dialog opened (the sidebar button, the
  // header's mobile search button, or the page under Cmd/Ctrl-K).
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(false)

  // Portal target only exists in the browser; gate on mount to stay SSR-safe.
  useEffect(() => {
    setMounted(true)
  }, [])

  const flat = useMemo(() => flattenDocsSearchIndex(index), [index])
  const results = useMemo(() => filterDocsSearchResults(query, flat), [query, flat])

  const openSearch = useCallback(() => {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused !== document.body) {
      returnFocusRef.current = focused
    }
    setOpen(true)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setActive(0)
    const target = returnFocusRef.current
    returnFocusRef.current = null
    // After the portal unmounts, hand focus back to the trigger.
    if (target) window.setTimeout(() => target.focus({ preventScroll: true }), 0)
  }, [])

  const navigate = useCallback(
    (href: string) => {
      close()
      router.push(href)
    },
    [router, close],
  )

  // Global Cmd/Ctrl-K opens the palette
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        if (!open) openSearch()
      } else if (e.key === "Escape" && open) {
        close()
      }
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener(OPEN_DOCS_SEARCH_EVENT, openSearch)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener(OPEN_DOCS_SEARCH_EVENT, openSearch)
    }
  }, [open, close, openSearch])

  // Focus input whenever opened
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Keep active result in view. `active` is read via the data attribute, so
  // the effect needs to run on every render but not include `active` in deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active triggers DOM query
  useEffect(() => {
    if (!listRef.current) return
    const activeEl = listRef.current.querySelector<HTMLElement>(`[data-active="true"]`)
    activeEl?.scrollIntoView({ block: "nearest" })
  }, [active])

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Escape is handled by the dialog panel for every focused control.
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, Math.max(0, results.length - 1)))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const r = results[active]
      if (r) navigate(r.href)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openSearch}
        aria-haspopup="dialog"
        className="w-full flex items-center justify-between gap-3 px-3 py-2 border border-rule-strong bg-page text-sm text-ink-muted hover:border-ink hover:text-ink transition-colors mb-6"
        aria-label="Search docs (press Cmd+K)"
      >
        <span className="flex items-center gap-2">
          <Icon name="search" />
          Search
        </span>
        <kbd data-ui="kbd">⌘K</kbd>
      </button>

      {open &&
        mounted &&
        createPortal(
          <div
            data-docs-search-overlay
            className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] backdrop-blur-sm"
            onClick={close}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                close()
              }
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Search docs"
          >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: wrapper stops modal-close propagation; roles are on ancestor dialog */}
            <div
              className="w-full max-w-xl mx-4 overflow-hidden"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // Escape bubbles to the dialog so it closes from the input or
                // a focused result; other keys stay inside the panel.
                if (e.key !== "Escape") e.stopPropagation()
              }}
            >
              <div className="flex items-center gap-3 px-4 py-3 border-b border-rule">
                <Icon name="search" className="text-ink-muted" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActive(0)
                  }}
                  onKeyDown={onInputKey}
                  placeholder="Search B4.run docs..."
                  aria-label="Search docs"
                  className="flex-1 bg-transparent text-ink placeholder:text-ink-muted text-sm"
                />
                <button type="button" onClick={close} aria-label="Close search" data-ui="kbd">
                  ESC
                </button>
              </div>

              <ul ref={listRef} className="max-h-[60vh] overflow-y-auto py-2">
                {results.length === 0 ? (
                  <li className="px-4 py-6 text-sm text-ink-muted text-center">
                    No results for &quot;{query}&quot;
                  </li>
                ) : (
                  results.map((r, i) => (
                    <li key={r.key}>
                      <button
                        type="button"
                        data-active={i === active}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => navigate(r.href)}
                        className="w-full text-left px-4 py-2.5 flex items-center gap-3"
                      >
                        <span
                          className={`text-[10px] uppercase tracking-wider font-semibold w-20 shrink-0 ${
                            i === active ? "text-ink" : "text-ink-muted"
                          }`}
                        >
                          {r.section}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-semibold text-ink">{r.title}</span>
                          {r.heading && (
                            <span className="block text-xs text-ink-muted truncate">
                              <span aria-hidden>#</span> {r.heading.text}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

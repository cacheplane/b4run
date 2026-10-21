"use client"

import posthog from "posthog-js"
import { type FormEvent, useState } from "react"
import { track } from "../lib/analytics/client"
import { SIGNAL_EVENTS } from "../lib/analytics/events"
import { DISCLOSURE_VERSION, FOUNDER_UPDATES_DISCLOSURE } from "../lib/growth/disclosure"

const ENDPOINT = "/api/growth/forms/founder-updates"

/** The PostHog id, only when the library is loaded and the visitor has not opted out. */
function distinctId(): string | undefined {
  try {
    return posthog.__loaded && !posthog.has_opted_out_capturing()
      ? posthog.get_distinct_id()
      : undefined
  } catch {
    return undefined
  }
}

async function submit(payload: Record<string, unknown>): Promise<string | undefined> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    const body: unknown = await response.json()
    if (response.ok) return undefined
    const code =
      typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined
    return typeof code === "string" && code !== "" ? code : "network"
  } catch {
    return "network"
  }
}

export function FounderUpdatesForm() {
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState("")
  const [website, setWebsite] = useState("")
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">("idle")

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (state === "sending") return
    setState("sending")
    track(SIGNAL_EVENTS.siteFormSubmit, { form: "founder_updates" })
    const id = distinctId()
    const failure = await submit({
      email,
      ...(message !== "" ? { message } : {}),
      website_url: website,
      disclosure_version: DISCLOSURE_VERSION,
      submission_id: crypto.randomUUID(),
      ...(id !== undefined ? { posthog_distinct_id: id } : {}),
    })
    if (failure === undefined) {
      track(SIGNAL_EVENTS.siteFormSuccess, { form: "founder_updates" })
      setState("done")
    } else {
      track(SIGNAL_EVENTS.siteFormFail, { form: "founder_updates", failure_reason: failure })
      setState("failed")
    }
  }

  if (state === "done") {
    return (
      <p role="status" className="mt-8 text-ink">
        Thanks. Watch for a note from Brian.
      </p>
    )
  }

  const field =
    "w-full border border-ink-muted/40 bg-transparent px-3 py-2 text-ink focus:outline-none focus:ring-2"
  return (
    <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm text-ink">
        Email
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-ink">
        What are you building? (optional)
        <textarea
          name="message"
          maxLength={1000}
          rows={4}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className={field}
        />
      </label>
      <input
        type="text"
        name="website_url"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={website}
        onChange={(event) => setWebsite(event.target.value)}
        style={{ position: "absolute", left: "-10000px", width: 1, height: 1, opacity: 0 }}
      />
      <div className="flex flex-col gap-3">
        <button
          type="submit"
          disabled={state === "sending"}
          className="self-start bg-ink px-4 py-2 text-sm font-medium text-page disabled:opacity-60"
        >
          Send me updates
        </button>
        <p className="text-sm text-ink-muted">
          {FOUNDER_UPDATES_DISCLOSURE} See the <a href="/privacy">privacy policy</a>.
        </p>
      </div>
      {state === "failed" ? (
        <p role="alert" className="text-sm text-ink">
          That did not go through. Please try again in a moment.
        </p>
      ) : null}
    </form>
  )
}

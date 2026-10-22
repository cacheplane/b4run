import posthog, { type PostHogConfig } from "posthog-js"
import { shouldCaptureSignals } from "./app/lib/analytics/capture-gate"

export const POSTHOG_INIT_OPTIONS = {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",
  capture_pageview: "history_change",
  capture_pageleave: "if_capture_pageview",
  autocapture: true,
  capture_performance: { web_vitals: true },
  person_profiles: "identified_only",
  respect_dnt: true,
  disable_surveys: true,
  disable_session_recording: true,
} satisfies Partial<PostHogConfig>

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY

if (
  shouldCaptureSignals({
    key,
    host: window.location.host,
    captureAnywhere: process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_ANYWHERE === "true",
  })
) {
  // The gate guarantees a non-blank key.
  posthog.init(key as string, POSTHOG_INIT_OPTIONS)
}

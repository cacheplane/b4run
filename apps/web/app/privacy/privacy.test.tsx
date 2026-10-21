import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import Page, { metadata } from "./page"

it("names the controller, the deletion address, and every subprocessor", () => {
  const html = renderToStaticMarkup(<Page />)
  expect(html).toContain("Cacheplane")
  expect(html).toContain("2843 NW Lolo Dr")
  expect(html).toContain("brian@b4.run")
  for (const sub of ["Vercel", "Neon", "PostHog", "Resend", "Google Calendar"])
    expect(html).toContain(sub)
  expect(html).toContain("B4_TELEMETRY_DISABLED")
  expect(html).not.toMatch(/tracking/i)
  expect(metadata.alternates?.canonical).toBe("https://b4.run/privacy")
})

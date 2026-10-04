import { afterEach } from "vitest"

// Testing Library only auto-cleans with `globals: true`; this package keeps
// globals off, so unmount every rendered tree after each test in DOM files.
afterEach(async () => {
  if (typeof document === "undefined") return
  const { cleanup } = await import("@testing-library/react")
  cleanup()
})

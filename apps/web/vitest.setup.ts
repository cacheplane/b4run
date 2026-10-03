import { afterAll } from "vitest"

// Registering ScrollTrigger starts a 250ms interval that calls the global
// `requestAnimationFrame`. jsdom deletes that global when a test file's
// environment is torn down, and the worker lives on a little longer, so a tick
// in that window throws an unhandled ReferenceError that fails the run with
// every test passing. Stop ScrollTrigger while the window still exists. Setup
// hooks run after the test file's own, so every island has unmounted by now.
afterAll(async () => {
  if (typeof window === "undefined") return
  const { stopScrollTrigger } = await import("./app/components/homepage/motion/gsap")
  stopScrollTrigger()
})

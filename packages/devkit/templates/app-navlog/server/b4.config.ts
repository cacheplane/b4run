import { config } from "@b4run/cli"

export default config({
  appDir: "src/app",

  // Tool scoping lives on the route (src/app/navlog/index.ts): runBash is
  // denied and fileFlightPlan asks a person before each call.

  // Tool-output offloading. Large tool results are spilled to
  // workspace/tool-outputs/ and replaced in-context with a short stub the
  // agent can read back on demand. The threshold is low so a TAF bundle or a
  // full POH table trips it (the default is 40000 chars).
  toolOutput: {
    offloadThresholdChars: 1500,
    previewLines: 10,
  },

  memory: {
    // Keep durable writes reviewable: remember() creates candidates until a
    // developer runs `npm run memory:approve -- <id>`.
    writes: "candidate",
  },

  // Persistence (SQLite checkpointer + Agent Protocol) is on by default.

  // --- Capability seam (documented, inactive): cross-origin access ---
  // B4.run sends no `Access-Control-*` header unless this block exists, and
  // `web/` deliberately does not need it: its browser client reaches B4.run
  // through a same-origin Next proxy (`web/app/api/b4/[...path]/route.ts`).
  //
  // server: {
  //   cors: { origins: ["http://localhost:3010", "http://127.0.0.1:3010"] },
  // },

  // --- Capability seam (documented, inactive): conversation summarization ---
  // summarization: {
  //   enabled: true,
  //   maxTokens: 12000,
  //   keepRecentTurns: 6,
  // },
})

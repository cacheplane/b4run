import { config } from "@b4run/cli"
import { openaiEmbedder } from "@b4run/langchain"
import { pgvectorMemoryStore } from "@b4run/memory-pgvector"

// Memory backend: SQLite with keyword recall by default, which is what every
// keyless run gets. Postgres + pgvector when DATABASE_URL is set (the live
// demo), and vector recall only on top of that store, when OPENAI_API_KEY is
// set too. The harness lanes set a fake OPENAI_API_KEY pointed at aimock, so an
// embedder keyed on the API key alone would send them embedding calls no
// fixture answers. Both connect lazily, so constructing them here does no I/O.
const databaseUrl = process.env.DATABASE_URL
const embedder = databaseUrl && process.env.OPENAI_API_KEY ? openaiEmbedder() : undefined

export default config({
  appDir: "src/app",

  // Tool scoping lives on the route (src/app/navlog/index.ts): runBash is
  // denied and fileFlightPlan asks a person before each call.

  // Tool-output offloading. Results above the threshold are spilled to
  // workspace/tool-outputs/ and replaced in-context with a short stub.
  // High enough that a navlog is never offloaded: the Workbench reads
  // computeNavlog's result off the wire. POH tables and weather bundles stay
  // inline too.
  toolOutput: {
    offloadThresholdChars: 12000,
    previewLines: 10,
  },

  memory: {
    // Keep durable writes reviewable: remember() creates candidates until a
    // developer runs `npm run memory:approve -- <id>`.
    writes: "candidate",
    ...(embedder ? { vector: { embedder } } : {}),
    ...(databaseUrl
      ? { store: pgvectorMemoryStore({ connectionString: databaseUrl, dimensions: 1536 }) }
      : {}),
  },

  // Persistence (SQLite checkpointer + Agent Protocol) is on by default.

  // The node target only: src/thread-access.ts makes threads visitor-owned, and
  // the langsmith target cannot carry a thread access policy, so `b4 build`
  // refuses it rather than deploy every thread endpoint ungated. The live demo
  // runs the node build (main.mjs, Dockerfile.railway).
  build: {
    targets: ["node"],
  },

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

import { createMemoryDocumentStore } from "@b4run/sdk"
import { describe } from "vitest"
import { runDocumentStoreConformance } from "../src/document-store-conformance.js"

// The in-process store answers the contract unconditionally and with no
// infrastructure. `@b4run/postgres-storage/test/documents.test.ts` runs the
// SAME suite against a real Postgres (gated on `B4_TEST_PGSTORAGE=1`), which
// is what makes "identical semantics" a checked claim rather than a comment.
runDocumentStoreConformance({
  name: "createMemoryDocumentStore",
  makeStore: () => createMemoryDocumentStore(),
  describe,
})

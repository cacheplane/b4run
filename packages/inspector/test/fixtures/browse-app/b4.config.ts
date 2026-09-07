// A dedicated app root so the verification lane's 1250-record store never collides
// with the small `test/fixtures/app` store the JSON-API e2e tests seed and wipe.
import { join } from "node:path"
import { sqliteMemoryStore } from "@b4run/memory"

export default {
  appDir: "src/app",
  memory: {
    writes: "candidate",
    store: sqliteMemoryStore({ path: join(import.meta.dirname, ".b4", "memory.sqlite") }),
  },
}

import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isolatedApp } from "../evaluation/isolated-app.js"

// Each fixture's evaluation installation names its own content-addressed image, so
// prepare exactly those installations with the example's own preparation script.
const prepare = fileURLToPath(
  new URL("../../../examples/code-fixer/server/scripts/prepare.ts", import.meta.url),
)
const temporary = await mkdtemp(join(tmpdir(), "b4-code-fixer-image-"))
try {
  for (const id of ["cli-flags", "nullable-inputs"]) {
    const root = await isolatedApp(join(temporary, id), id)
    execFileSync(process.execPath, ["--import", "tsx", prepare, root], { stdio: "inherit" })
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}

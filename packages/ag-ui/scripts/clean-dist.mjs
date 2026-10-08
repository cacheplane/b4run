// Removes build output that no current source produces, so a stale `dist/`
// (from before a move or rename) is never packed: the root modules the
// translator split replaced, the React connector's old `./copilotkit` entry
// (now `./react/copilotkit`) and the stylesheet's old `./react/styles.css`
// path (now `./styles.css`).
import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

if (existsSync("dist")) {
  for (const entry of readdirSync("dist", { withFileTypes: true })) {
    if (entry.isFile() && /^(?:encode|run-input|translate)\./.test(entry.name)) {
      rmSync(join("dist", entry.name))
    }
  }
  rmSync("dist/copilotkit", { recursive: true, force: true })
  rmSync("dist/react/styles.css", { force: true })
}

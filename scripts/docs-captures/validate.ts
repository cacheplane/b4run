import { readFileSync } from "node:fs"
import { parseCapture } from "../../apps/web/lib/turn-inspector/capture-schema"
import { assertSafeValues } from "./sanitize"

const file = process.argv[2]
if (!file) throw new Error("Usage: validate.ts <normalized-capture.json>")
const capture = parseCapture(readFileSync(file, "utf8"))
assertSafeValues(capture)
console.log(
  JSON.stringify({
    id: capture.id,
    provenance: capture.provenance,
    events: capture.events.length,
    moments: capture.moments.length,
  }),
)

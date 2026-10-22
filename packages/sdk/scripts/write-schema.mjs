import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { B4_ANSWER_JSON_SCHEMA, B4_TOOL_STEP_JSON_SCHEMA } from "../dist/tool-step.js"

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist")
mkdirSync(dist, { recursive: true })
for (const [file, schema] of [
  ["tool-step.schema.json", B4_TOOL_STEP_JSON_SCHEMA],
  ["answer.schema.json", B4_ANSWER_JSON_SCHEMA],
]) {
  writeFileSync(resolve(dist, file), `${JSON.stringify(schema, null, 2)}\n`)
}

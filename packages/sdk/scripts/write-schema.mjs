import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { B4_TOOL_STEP_JSON_SCHEMA } from "../dist/tool-step.js"

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/tool-step.schema.json")
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(B4_TOOL_STEP_JSON_SCHEMA, null, 2)}\n`)

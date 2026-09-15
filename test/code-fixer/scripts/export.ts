import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { assertExportable } from "../evaluation/evidence.js"

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: { input: { type: "string" }, output: { type: "string" } },
})
if (!values.input || !values.output)
  throw new Error("Provide --input <result.json> --output <new-recording.json>")
const receipt = JSON.parse(await readFile(resolve(values.input), "utf8"))
assertExportable(receipt)
await writeFile(resolve(values.output), JSON.stringify(receipt, null, 2), { flag: "wx" })
console.log(`Exported verified live recording: ${resolve(values.output)}`)

import { parseArgs } from "node:util"
import { qualifyFixture } from "../src/blueprint/qualify.js"

const argv = process.argv.slice(2)
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: { task: { type: "string" } },
})
for (const id of values.task ? [values.task] : ["cli-flags", "nullable-inputs"]) {
  const receipt = await qualifyFixture(id)
  console.log(JSON.stringify(receipt, null, 2))
  if (!receipt.qualified) process.exitCode = 1
}

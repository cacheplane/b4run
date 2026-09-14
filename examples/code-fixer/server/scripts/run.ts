import { parseArgs } from "node:util"
import { runAttempt } from "../src/blueprint/run-attempt.js"

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    task: { type: "string", default: "cli-flags" },
    replay: { type: "boolean", default: false },
    output: { type: "string", default: "artifacts/code-fixer" },
  },
})
const result = await runAttempt({
  task: values.task,
  mode: values.replay ? "replay" : "live",
  outputRoot: values.output,
  interactive: process.stdin.isTTY === true,
})
console.log(
  JSON.stringify(
    { output: result.output, status: result.receipt.status, passed: result.receipt.passed },
    null,
    2,
  ),
)
if (!result.receipt.passed) process.exitCode = 1

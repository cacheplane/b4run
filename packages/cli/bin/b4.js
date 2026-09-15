#!/usr/bin/env node

import { renderError, run } from "../dist/index.js"

run(process.argv.slice(2)).then(
  (exitCode) => {
    process.exit(exitCode)
  },
  (error) => {
    process.stderr.write(`${renderError(error)}\n`)
    process.exit(1)
  },
)

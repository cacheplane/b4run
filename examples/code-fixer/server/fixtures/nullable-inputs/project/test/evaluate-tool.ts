import { readFileSync } from "node:fs"
import { compileTool } from "../src/pipeline.js"

const { source, inputs } = JSON.parse(readFileSync(0, "utf8"))
const { schema, validator } = compileTool(source)
process.stdout.write(JSON.stringify({ schema, accepted: inputs.map((input: unknown) => validator.safeParse(input).success) }))

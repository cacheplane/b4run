import type { RunAgentInput } from "@ag-ui/core"
import { B4HttpAgent } from "@b4run/ag-ui/client"
import { describe, expect, it } from "vitest"
import { RESPONSE_SCHEMA_NAME, readResponseFormat } from "../src/lib/dev/response-schema.js"
import { validateRunEnvelope } from "../src/lib/dev/run-envelope.js"

/**
 * Conformance: the run body `B4HttpAgent({ responseSchema })` sends is the
 * envelope the AG-UI endpoint's `readResponseFormat` binds as structured
 * output. The two live in different packages, so this pins the wire shape
 * from the reader's side.
 */

const runInput: RunAgentInput = {
  context: [],
  forwardedProps: {},
  messages: [],
  runId: "r1",
  state: {},
  threadId: "t1",
  tools: [],
}

const schema = {
  additionalProperties: false,
  properties: { ui: { type: "array", items: { type: "string" } } },
  required: ["ui"],
  type: "object",
}

class RunBodyProbe extends B4HttpAgent {
  body(): unknown {
    return JSON.parse(String(this.requestInit(runInput).body))
  }
}

describe("B4HttpAgent run body against readResponseFormat", () => {
  it("binds the agent's responseSchema as the run's response format", () => {
    const body = new RunBodyProbe({ responseSchema: schema, url: "http://b4.test/agui/x" }).body()
    expect(readResponseFormat(body)).toEqual({
      ok: true,
      responseFormat: { name: RESPONSE_SCHEMA_NAME, schema, type: "json_schema" },
    })
  })

  it("passes the envelope check on a route that allows only responseSchema", () => {
    const body = new RunBodyProbe({ responseSchema: schema, url: "http://b4.test/agui/x" }).body()
    expect(
      validateRunEnvelope(body, { clientTools: false, forwardedProps: ["responseSchema"] }),
    ).toBeUndefined()
    expect(validateRunEnvelope(body, { clientTools: false, forwardedProps: [] })).toMatchObject({
      code: "forwarded_props_not_allowed",
    })
  })

  it("binds nothing for an agent without one", () => {
    const body = new RunBodyProbe({ url: "http://b4.test/agui/x" }).body()
    expect(readResponseFormat(body)).toEqual({ ok: true, responseFormat: undefined })
  })
})

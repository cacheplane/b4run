/**
 * The client-supplied response schema on an AG-UI run envelope.
 *
 * Hashbrown's AG-UI client sends `hashbrown: { ui: true, responseSchema }` on
 * every run: a JSON Schema the assistant's FINAL message must conform to, so
 * the client can render it as UI. AG-UI's `RunAgentInputSchema` strips the
 * unknown key, so this reads the ORIGINAL parsed JSON — the same body route
 * middleware sees — and turns it into the runtime's provider-neutral
 * `JsonSchemaResponseFormat`.
 *
 * Absent is ordinary (every non-Hashbrown client). Present-but-malformed is a
 * request error, and present-but-unsupported (a provider or route kind that
 * cannot constrain its output) is rejected further down, at
 * `checkRouteResponseFormatSupport`. Nothing here is ever ignored: a client
 * that sent a schema either gets it applied or gets told why not, because
 * from its side an ignored schema and an honored one look identical until a
 * reply fails to parse.
 *
 * Pure: no `node:` imports, so the module is reachable from the edge bundle.
 */

import type { JsonSchemaResponseFormat } from "@b4run/langchain"

/** The `json_schema.name` the provider sees; OpenAI requires `^[a-zA-Z0-9_-]{1,64}$`. */
export const RESPONSE_SCHEMA_NAME = "hashbrown_response"

export type ResponseSchemaRejectionCode =
  | "invalid_response_schema"
  | "response_schema_not_supported"

export interface ResponseSchemaRejection {
  readonly ok: false
  readonly code: ResponseSchemaRejectionCode
  readonly message: string
  readonly status: 422
}

export type ReadResponseFormatResult =
  | { readonly ok: true; readonly responseFormat: JsonSchemaResponseFormat | undefined }
  | ResponseSchemaRejection

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function rejectResponseSchema(
  code: ResponseSchemaRejectionCode,
  message: string,
): ResponseSchemaRejection {
  return { ok: false, code, message, status: 422 }
}

/**
 * Read `hashbrown.responseSchema` off the raw run body. `undefined` when the
 * envelope carries no `hashbrown` block or no schema (a Hashbrown run without
 * `ui: true` sends none); a rejection when what is there is not a schema.
 */
export function readResponseFormat(body: unknown): ReadResponseFormatResult {
  if (!isRecord(body) || body.hashbrown === undefined) {
    return { ok: true, responseFormat: undefined }
  }
  const hashbrown = body.hashbrown
  if (!isRecord(hashbrown)) {
    return rejectResponseSchema(
      "invalid_response_schema",
      "`hashbrown` must be a JSON object when present",
    )
  }
  const schema = hashbrown.responseSchema
  if (schema === undefined) {
    return { ok: true, responseFormat: undefined }
  }
  if (!isRecord(schema)) {
    return rejectResponseSchema(
      "invalid_response_schema",
      "`hashbrown.responseSchema` must be a JSON Schema object when present",
    )
  }
  return {
    ok: true,
    responseFormat: { type: "json_schema", name: RESPONSE_SCHEMA_NAME, schema },
  }
}

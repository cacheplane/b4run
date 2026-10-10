/**
 * The client-supplied response schema on an AG-UI run envelope.
 *
 * A client sends `forwardedProps: { responseSchema }`: a JSON Schema the
 * assistant's FINAL message must conform to, so the client can render it as
 * UI. `forwardedProps` is AG-UI's own field for client additions, so no
 * library-specific key is involved; whether a route accepts the key at all is
 * `server.agui.clientForwardedProps`, judged by `validateRunEnvelope` before
 * this runs. This reads the ORIGINAL parsed JSON — the same body route
 * middleware sees — and turns the schema into the runtime's provider-neutral
 * `JsonSchemaResponseFormat`.
 *
 * Absent is ordinary. Present-but-malformed is a request error, and
 * present-but-unsupported (a provider or route kind that cannot constrain its
 * output) is rejected further down, at `checkRouteResponseFormatSupport`.
 * Nothing here is ever ignored: a client that sent a schema either gets it
 * applied or gets told why not, because from its side an ignored schema and
 * an honored one look identical until a reply fails to parse.
 *
 * Pure: no `node:` imports, so the module is reachable from the edge bundle.
 */

import type { JsonSchemaResponseFormat } from "@b4run/langchain"

/** The `forwardedProps` key a client sends its schema under. */
export const RESPONSE_SCHEMA_KEY = "responseSchema"

/** The `json_schema.name` the provider sees; OpenAI requires `^[a-zA-Z0-9_-]{1,64}$`. */
export const RESPONSE_SCHEMA_NAME = "b4_response"

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
 * Read `forwardedProps.responseSchema` off the raw run body. `undefined` when
 * the envelope carries no `forwardedProps` or no schema; a rejection when what
 * is there is not a schema.
 */
export function readResponseFormat(body: unknown): ReadResponseFormatResult {
  const forwardedProps = isRecord(body) ? body.forwardedProps : undefined
  // A `forwardedProps` that is not an object is the envelope check's to refuse.
  const schema = isRecord(forwardedProps) ? forwardedProps[RESPONSE_SCHEMA_KEY] : undefined
  if (schema === undefined) {
    return { ok: true, responseFormat: undefined }
  }
  if (!isRecord(schema)) {
    return rejectResponseSchema(
      "invalid_response_schema",
      "`forwardedProps.responseSchema` must be a JSON Schema object when present",
    )
  }
  return {
    ok: true,
    responseFormat: { type: "json_schema", name: RESPONSE_SCHEMA_NAME, schema },
  }
}

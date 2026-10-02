import type { BaseEvent } from "@ag-ui/core"
import { EventEncoder } from "@ag-ui/encoder"

/**
 * The AG-UI HTTP bindings, selected by the request's `Accept` header.
 *
 * SSE (`data: <json>\n\n`) unless `accept` admits
 * `application/vnd.ag-ui.event+proto` with a positive quality — named
 * explicitly, or through an `application` or a wildcard range — in which case
 * each event is a 4-byte unsigned big-endian length followed by exactly that
 * many bytes of one protobuf-encoded event, frames abutting with no separator.
 * The rule is `@ag-ui/encoder`'s own, so the two functions always agree: a
 * producer sets the header from one and writes the frames from the other.
 */
function encoder(accept?: string): EventEncoder {
  return new EventEncoder(accept ? { accept } : {})
}

/** One AG-UI event as the bytes of the binding `accept` selects. */
export function encodeAgUiEvent(event: BaseEvent, accept?: string): Uint8Array {
  return encoder(accept).encodeBinary(event)
}

/** The `content-type` of the binding `accept` selects. */
export function agUiContentType(accept?: string): string {
  return encoder(accept).getContentType()
}

---
"@b4run/cli": patch
---

A middleware `reject(status)` that omits the body now answers with that status instead of a 500. The runtime built the reply with `Response.json(body)`, which throws when `body` is `undefined`, so the documented body-omitted form of `reject` reached the caller as `500 Unexpected runtime server failure` — turning an intended 401 or 403 into a server error on the AG-UI and Agent Protocol run endpoints. A body-less reject now sends an empty payload under the JSON content-type at the requested status; rejects that do supply a body are unchanged.

On the Node targets, body-less replies are now framed with `Content-Length: 0` rather than `Transfer-Encoding: chunked`, restoring how the pre-`fetch`-core server framed them and extending the adapter's existing content-length rule for JSON to cover empty payloads. The statuses that forbid a body (204, 205, 304) keep Node's own suppression and send no `Content-Length`.

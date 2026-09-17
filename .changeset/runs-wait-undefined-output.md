---
"@b4run/cli": patch
---

A route that returns nothing no longer makes `POST /threads/:id/runs/wait` answer 500. The endpoint serialized the route's return value with `Response.json`, which throws on `undefined`, so a run that had actually succeeded came back as `Unexpected runtime server failure` while `POST /threads/:id/runs/stream` reported the same run as done. Such a run now answers 200 with JSON `null`, and the two endpoints agree.

`null` rather than the empty body the pre-`fetch`-core server sent: B4's own client for this endpoint parses every 200 body, and an empty one reads as a malformed payload, which would trade the 500 for a transport error. Falsy outputs (`0`, `false`, `""`) are unaffected (#714).

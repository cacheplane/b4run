---
"@b4run/sandbox": patch
---

The Kubernetes sandbox backend now implements `walkTree` and `readBinaryFiles`, so `inspectWorkspace` over a pod's workspace costs a few execs instead of one per `listDir`, `lstat`, and read. Over 1,212 entries on a kind cluster, batched inspection took under a second, where each per-entry exec cost about 80 ms. The batch read's script goes to `sh -s` on stdin rather than in argv, because a Kubernetes exec carries its command in the request URL, where an API server or proxy may cap the length. Batch read scripts also redirect each read's stdin from `/dev/null`, so no command in a script fed on stdin can consume the rest of it.

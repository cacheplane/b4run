---
"@b4run/langchain": patch
---

Keep tool middleware context scoped to the current request, including resumed
approval runs. Agent graphs capturing middleware context no longer share the
compiled graph cache, preventing earlier request identity or authorization
from reaching later tool calls. Context-free agents retain their existing cache.

---
"@b4run/cli": patch
"@b4run/core": patch
---

The Tools docs and the `returnDirect` JSDoc now say that a failed call ends the run too: when a `returnDirect` tool throws, or the model's arguments fail its schema, LangGraph's prebuilt agent stops on the error result and the model never gets to retry. Use `returnDirect` only for tools that cannot usefully fail.

---
"@b4run/core": patch
---

Workspace agents get an `editFile` tool and ranged `readFile`. `editFile({ path, oldText, newText, replaceAll? })` replaces an exact span of an existing file through the same permission-gated handle as `readFile` and `writeFile`, and refuses when `oldText` is missing or ambiguous instead of guessing. `readFile` accepts optional 1-based, inclusive `startLine`/`endLine` and prefixes a ranged read with a `[<path> lines a-b of N]` header; a read without a range is unchanged. The tool descriptions now steer models to read large files in ranges and change them with `editFile` rather than rewriting them in full with `writeFile`, which risked truncating large files.

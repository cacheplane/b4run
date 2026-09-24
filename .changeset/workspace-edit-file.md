---
"@b4run/core": patch
---

Workspace agents get an `editFile` tool and ranged `readFile`. `editFile({ path, oldText, newText, replaceAll? })` replaces an exact span of an existing file through the same permission-gated handle as `readFile` and `writeFile`, and refuses when `oldText` is missing or ambiguous (overlapping matches count) instead of guessing. It edits UTF-8 files only and refuses any other file without touching it. `readFile` accepts optional 1-based, inclusive `startLine`/`endLine` and prefixes a ranged read with a `[<path> lines a-b of N]` header; a read without a range is unchanged. The tool descriptions now steer models to read large files in ranges and change them with `editFile` rather than rewriting them in full with `writeFile`, which risked truncating large files.

Tool scoping: a route that denies `writeFile` also loses `editFile`, so existing `deny: ["writeFile"]` routes stay read-only. Name `editFile` in `allow` to keep it. An allow-list naming `writeFile` does not grant `editFile`. `b4 check` warns when `approve` names an `editFile` that a `writeFile` deny withholds.

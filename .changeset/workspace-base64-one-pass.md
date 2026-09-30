---
"@b4run/workspace": patch
---

`verifySourceBundle` now checks each file's base64 in one native pass instead of one character at a time, cutting that check from ~67 ms to ~2 ms for a 343-file, 2.55 MB bundle with the same strictness (invalid characters, the URL-safe alphabet, whitespace, misplaced or excess padding, and nonzero padding bits are still rejected), and it now checks the size limits from every file's encoded length before decoding any content.

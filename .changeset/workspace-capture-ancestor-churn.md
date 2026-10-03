---
"@b4run/workspace": patch
---

`captureWorkspaceSource` no longer reports "Source changed during capture" when an entry appears in or vanishes from a directory above the source — the capture root, or a staging area several captures share. Those directories are now checked by identity only (same inode, still a directory); the source tree itself and every referenced file are still compared by full metadata.

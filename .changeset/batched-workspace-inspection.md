---
"@b4run/workspace": patch
"@b4run/sandbox": patch
---

`inspectWorkspace` no longer makes one backend call per entry when the backend can batch. Filesystem backends gain two optional methods. `walkTree` returns every entry below a directory with `lstat` metadata in one call, and `readBinaryFiles` reads many files with `readBinaryFile`'s per-file `maxBytes` bound. When a backend has both, inspection walks once, reads in a few calls, and applies exactly the same name, kind, size, and budget checks as before. A file that grew between the walk and the read is refused.

The Docker backend and the Docker workspace reader implement both methods. Inspecting a container workspace now costs a few `docker exec` calls instead of one per `listDir`, `lstat`, and read. Over 1,214 entries that took inspection from 143 s to about 1 s. The walk is bounded inside the container, names travel as exact bytes, and a walk over the entry limit fails rather than being truncated. `withFilesystemLogging` passes both methods through. Other backends are unchanged and keep the per-entry path.

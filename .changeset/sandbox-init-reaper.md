---
"@b4run/sandbox": patch
---

The Docker sandbox now starts its session container with `--init`, so orphaned descendants of a command are reaped instead of lingering as zombies that hold PID slots and make process-tree termination look like it failed.

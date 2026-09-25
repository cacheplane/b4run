---
"@b4run/sandbox": patch
"@b4run/devkit": patch
---

A Docker command that exits before reading its stdin no longer crashes the process with an uncaught `EPIPE`. The Docker client and the devkit test process helper now ignore `EPIPE` on the child's stdin, where the exit status already reports the failure, and still surface any other stdin error. Batched workspace reads send their scripts over stdin, which made this reachable.

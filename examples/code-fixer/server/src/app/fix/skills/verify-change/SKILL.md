---
name: verify-change
description: Reproduce and verify a focused code repair.
---

Read TASK.md. Run the documented failing command and inspect its output before
editing. Follow the actual entry point through the source; don't stop at a
handler test if the failure occurs at a parser or adapter boundary.

Change only the permitted source files. Preserve tests and validation behavior.
Run the documented tests again and check the task's preservation requirements.
For validation changes, consider both accepted and rejected inputs with the
documented diagnostics. Report the commands, actual results, and remaining failures.
After verification, call exportForReview({}) to request runtime approval. The
runtime pauses before exporting; a prose approval question does not raise that gate.

---
"@b4run/cli": patch
---

Managed workspaces no longer re-read and re-verify the thread's whole captured source bundle before every filesystem or exec call. The bundle is read from storage and verified once when a session is admitted, and later calls on that session reuse the verified, frozen copy while the association still names the same operation and source digest. A new session, after idle reaping, an abort, or a failed call, reads and verifies the stored bundle again, so a tampered bundle is still refused at admission. `readInitialFile` also indexes the verified bundle once instead of re-hashing it for every file. On a 951-file, 10 MB workspace a warm backend call drops from about 340 ms to about 0.1 ms.

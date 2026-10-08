---
"@b4run/sdk": patch
"@b4run/devkit": patch
---

`ownedThreads({ owner?, adminsRead? })` is the common thread-access policy as a value. Each caller reaches only the threads it created, stamped `{ ownerId }` from its principal, and `adminsRead` principals may also read the rest. It denies an anonymous caller, and denies a missing row ahead of any admin branch, so "not yours" and "never existed" stay the same answer. The `create-b4-app` templates now use it in place of a hand-written policy. `ownedThreadsOptions(policy)` reads its options back, for build targets that translate it.

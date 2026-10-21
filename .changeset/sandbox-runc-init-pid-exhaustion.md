---
"@b4run/sandbox": patch
---

`dockerSandbox` now recognizes a `runc init` that aborts on thread creation while joining a full pids cgroup (`runtime/cgo: pthread_create failed` or `failed to create new OS thread`, with runc frames in the dump) as a PID-exhaustion admission failure. Before, that unwrapped Go crash dump came back as the command's own exit 2, and the keeper was never recycled.

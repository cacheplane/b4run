---
"@b4run/cli": patch
"@b4run/workspace": patch
"@b4run/sandbox": patch
---

A sandbox with no `network` setting now defaults to `{ mode: "allow" }`. The previous default was `{ mode: "allow", denylist: ["169.254.169.254"] }`, but neither the Docker nor the Kubernetes provider enforces an allow-mode `denylist`. The entry claimed a block on the cloud metadata endpoint that never took effect, and runtime behavior is unchanged: allow-mode egress was open before and is open now. On a cloud VM, set `network: { mode: "deny" }` when the sandbox does not need the network. Otherwise block the endpoint outside B4.run, with a host firewall or egress proxy for Docker, or with the `b4-sandbox-infra` chart's default-deny egress backstop or your own NetworkPolicy for Kubernetes. The `SandboxPolicy.network` JSDoc and the sandbox and configuration docs now say which lists each reference provider ignores.

---
"@b4run/sandbox": patch
"@b4run/devkit": patch
---

Breaking change: Docker and Kubernetes sandbox providers now require a stable
application/environment `scope`. All resource names hash scope and thread ID,
preventing collisions caused by the previous thread-name normalization. Research
scaffolds now supply scope explicitly.

Existing resources use different names and are not automatically reattached,
migrated, or deleted. Export required data before upgrading and manage old
resources explicitly. Scope is not authorization or cross-process coordination.

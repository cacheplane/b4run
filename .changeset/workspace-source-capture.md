---
"@b4run/workspace": patch
"@b4run/sqlite-storage": patch
---

Add Node utilities for capturing and verifying immutable workspace source bundles,
preserving exact bytes and checking declared file inventories and size limits.
Add an internal transactional SQLite source-bundle component with strict integrity
verification. Managed workspace lifecycle and runtime integration remain pending.

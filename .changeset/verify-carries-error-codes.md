---
"@b4run/cli": patch
---

`b4 verify` now renders the registry error code for every phase, not just `runtime`. An app root whose `package.json` lacks `"type": "module"` fails with `[B4_E1006]` and a route entry with no recognisable export fails with `[B4_E1007]` — the same codes `b4 check` reports for those apps. The `--json` payload carries the code too: a failed check's `error` object gains an optional `code` field, present only when the underlying failure has a registry entry.

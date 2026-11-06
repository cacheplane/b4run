---
"@b4run/cli": patch
---

Accept array-valued LangGraph checkpoint interrupts when resuming approvals, while preserving validation of every interrupt and rejection of duplicate or ambiguous identifiers. This fixes Navlog approval continuation with newer installed LangGraph versions.

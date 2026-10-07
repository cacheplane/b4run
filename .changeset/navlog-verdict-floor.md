---
"@b4run/devkit": patch
---

The navlog template's web client now enforces the weather brief's verdict rules in code. A deterministic floor (IFR or LIFR at the ETA, a reserve under 45 min: NO-GO; MVFR, gusts over 20 kt, a preliminary forecast, a freezing level near the cruise, LLWS, turbulence or convection during the flight: CAUTION) raises the agent's call when it is too optimistic, and the verdict card, the pills and the planning brief's bottom line all show the raised level with the reasons and the agent's own call. The planning brief's closing question no longer lands under Assumptions: it is parsed as a separate closing and shown after the sections, on screen only.

---
"@b4run/devkit": patch
"create-b4-app": patch
---

The navlog template's tools word their failures ("Couldn't find KXYZ"), its flight-plan approval card names the ICAO items ("7 Aircraft ID") instead of `item7`, and the planner asks once for a UTC time when the pilot gives only a part of the day ("tomorrow morning") instead of failing to resolve it.

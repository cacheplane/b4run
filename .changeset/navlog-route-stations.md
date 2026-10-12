---
"@b4run/devkit": patch
"create-b4-app": patch
---

The navlog template's en-route weather stays on the route. `findRouteStations` holds a wider corridor to 40 nm and `max` to 8, after a model asked for a 100 nm corridor and listed airports two valleys over as en route. The coordinator now hands the weather subagent the route's legs and its en-route stations as separate, labelled lists, and the subagent fetches winds aloft once per leg and advisories at the route's own waypoints, never per station.

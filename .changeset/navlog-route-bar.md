---
"@b4run/devkit": patch
---

The navlog template gains a route bar on the map, with autocomplete over a bundled OurAirports snapshot of US airports and navaids. Its Plan/Replan button sends the route as one chat message. Two new tools, `lookupNavaid` and `findRouteStations`, resolve navaids and find reporting stations within 25 nm of the course. A new Weather tab groups METARs and TAFs by origin, en route and destination, replacing the weather chips on the map.

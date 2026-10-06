---
"@b4run/memory-pgvector": patch
"@b4run/devkit": patch
---

`@b4run/memory-pgvector` no longer registers pgvector type parsers from the pool's `connect` event. That call could not be awaited, so a freshly opened connection reached its caller while the type lookup was still running and the caller's first statement landed on a busy client: pg's "Calling client.query() when the client is already executing a query" deprecation, which pg@9 turns into an error. Nothing in the store reads a vector-typed column, so no parser is needed.

The navlog scaffold's `getAdvisories` tool normalizes aviationweather.gov advisories: fields AWC sends as null are omitted instead of reading `"null"`, validity times are ISO 8601 for every product (the G-AIRMET expiry and AIRMET/SIGMET times arrive as epoch seconds), altitudes read "surface", "freezing level" or "4,000 ft", freezing-level contours report their level, AIRMETs are labelled AIRMET, and a G-AIRMET's cause is kept.

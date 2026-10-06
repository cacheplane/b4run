---
"@b4run/devkit": patch
---

The navlog scaffold's `getWindsAloft` reads the shortest published winds-aloft forecast (6, 12 or 24 hours) that reaches the requested hours ahead, instead of rejecting anything but those three values. A model that asks for the wind one hour out now gets the 6-hour product on the first call rather than an error and a retry; a period past 24 hours, or a negative one, is still refused.

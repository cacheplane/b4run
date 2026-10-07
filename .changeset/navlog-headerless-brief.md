---
"@b4run/devkit": patch
---

The navlog scaffold's weather-brief parser reads airport lines that arrive without their "Airports:" header. A model sometimes writes them straight after "Forecast horizon:", which used to fold them into the horizon, leave the brief with no airports, hide the weather strip and switch off the verdict floor.

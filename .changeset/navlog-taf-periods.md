---
"@b4run/devkit": patch
---

The navlog scaffold's `getTaf` tool returns each forecast group decoded: its UTC window, ceiling, visibility, wind, weather and flight category. The weather subagent reads the TAF at the ETA from these periods instead of decoding day-hour groups such as FM080200 itself, which had placed a change 13 hours before departure "after arrival".

---
description: How to read the transcribed Cessna 172N POH tables and cite them.
---

# POH lookup

- Pressure altitude, not field elevation, enters every table. With a standard altimeter setting the two are equal; otherwise add 1000 ft per inch below 29.92.
- Temperature columns are 0, 10, 20, 30 and 40 °C for takeoff and landing; interpolate and say so.
- The cruise table lists specific RPM settings per altitude. Use the pilot's cruise RPM; if the table lacks it at that altitude, say which nearby settings exist.
- Cite as [poh/<file>.md, Figure N], the figure number is in each file's first lines.
- Climb figures are cumulative from sea level; subtract the row for the departure field's pressure altitude from the row for the cruise altitude, then add 1.1 gal for start, taxi and takeoff. computeNavlog already adds that 1.1 gal to the first leg, so the navlog's fuel total includes it; never tell the pilot to add it again.
- ETE is takeoff to landing, the navlog's total time; it does not include start or taxi.

# Navlog Route Memory

- The aircraft profile lives in long-term memory as subject `aircraft` with
  predicates `tail_number`, `cruise_rpm`, `usable_fuel_gal`, `reserve_minutes`.
  Recall it at the start of every plan; remember new facts the pilot states.
- Performance numbers come from POH tables the performance subagent read; cite
  the figure. Weather comes from the live tools; quote the raw observation.
- `computeNavlog` owns every number on the navlog.

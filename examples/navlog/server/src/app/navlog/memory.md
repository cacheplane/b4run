# Navlog Route Memory

- The demo aircraft's baseline lives in `aircraft/c172n.md`; read it with
  `readDoc`. Long-term memory holds what this pilot stated: subject `aircraft`
  with predicates `tail_number`, `cruise_rpm`, `usable_fuel_gal`,
  `reserve_minutes`, plus their preferences. A recalled fact overrides the
  baseline; what the pilot says in the request overrides both. Remember new
  facts the pilot states.
- Performance numbers come from POH tables the performance subagent read; cite
  the figure. Weather comes from the live tools; quote the raw observation.
- `computeNavlog` owns every number on the navlog.

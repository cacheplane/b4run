# Open tool-display icon authoring

This implements the already-approved open-string icon requirement in Hashbrown's
2026-10-21 shared tool-step contract and its slice 6. The wire schema and
B4ToolStep already accept arbitrary strings; no protocol/version change is needed.

## Design

Accept any nonempty string in ToolDisplay.icon and retain the current ten
TOOL_DISPLAY_ICONS as recommendations/autocomplete hints. Keep isToolDisplayIcon
as the existing known-glyph membership check for backward compatibility; its
TSDoc must make that limited purpose explicit. Its type predicate must remain
the known literal union `(typeof TOOL_DISPLAY_ICONS)[number]`, not the widened
ToolDisplayIcon type; false branches must retain arbitrary strings. Author validation must validate
nonempty strings rather than call that membership check. Non-string and empty
values remain invalid; do not trim or reinterpret authored names.

Preserve custom names through tool discovery, running/settled emitters, permission
steps, persisted legacy readers and AG-UI view projections. Do not change the
legacy event/status shapes or shared contract merge semantics. The generic glyph
fallback already uses an own-property lookup: preserve that behavior, including
prototype-like names such as constructor and __proto__. Unknown icons remain
opaque display hints, never markup, URLs, dynamic imports or executable assets.

An extensible icon registry or renderer API would add a separate UI surface;
leave that for a concrete application requirement. Dropping unknown names would
violate the existing open-string contract. Hashbrown already preserves them and
needs no runtime change.

## Verification and delivery

Test first: custom authoring acceptance/types; invalid empty/non-string values;
unknown names across live, persisted, restored and parked permission steps;
known-icon membership compatibility and safe generic glyph fallback. Use new
top-level test calls with arrange/act/assert, no hooks. Preserve existing inputs.
Add TSDoc to changed reusable/public APIs. No dependencies, live model calls,
recordings, file-search features, release machinery edits or publication.

Update SDK/tool-display/AG-UI docs and add a patch changeset for the fixed group.
Run affected package build/test/lint/typecheck plus repository docs/release gates
appropriate to the change; preserve warnings and limits. Open a focused B4 PR,
leave unmerged. Hashbrown documentation closeout is a separate PR and must label
this work as pending until it actually merges/releases.

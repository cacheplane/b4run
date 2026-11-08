# B4 inspector workbench visual design

Date: 2026-11-06
Status: Approved in chat; implementation inline.

## Direction

Adopt Hashbrown's current compact workbench structure with B4's Paper Relay palette. This amends the visual portion of the November 5 inspector design. The current LLA `docs/design-rules.md` and `src/app/globals.css`, Hashbrown's October 30 compact-inspector spec and actual `workbench.css` take precedence over the retired square-corner LLA draft. Existing capture data, source pins, noindex routes, links and privacy boundaries remain intact.

Use Hanken Grotesk for messages and UI; JetBrains Mono for code, identifiers and timing. A warm canvas contains two light, hairline-bordered panels and a bottom player. Outer panel corners are 12–16px; compact controls use 6–8px corners; Play is circular and ink-filled. No decorative shadows, gradients, icon tiles or uppercase labels. Functional controls retain 44px hit targets. Ink is the primary action color; relay tint marks selections; relay fills the timeline with an ink playhead; olive carries accessible accent text. Do not use relay for small text.

## Layout and reading

A quiet top bar combines Replay / optional Source, a recording label, and an open-inspector link for inline readers. Replay places conversation left (44%) and detail right (56%). Messages read as conversation: ink user bubbles, unboxed assistant prose, quiet selectable tool rows. Group observations under their turn and show observed status separately from messages. The selected item has a tint and edge marker. On narrow containers Conversation / Details selects one pane while the same player remains below it.

Detail is one full-height viewport. Tools expose Arguments / Result / Event; messages expose Content / Event. Event means the normalized, observed item, never an invented vendor payload. Structured objects/arrays offer Tree / JSON. JSON-encoded strings may be formatted only as an explicitly labeled derived view; the original string remains available in JSON/Event. Native details/summary disclosure controls provide keyboard-accessible expansion without pretending to implement ARIA tree keyboard semantics. Expansion survives event updates for the same selected item and resets on selecting another item. Bound traversal and paginate large collections so inspection cannot freeze on a legal large payload.

The bottom player contains previous turn/event, Play/Pause, next event/turn, a turn-segmented event-axis scrubber, named moment buttons, a current-moment label, receipt time and speed (0.5×, 1×, 2×). Keep native range keyboard behavior. Selecting a moment pauses and selects its item; selecting an item does not reset the clock. Speed changes scale future waits without rewriting recorded timestamps. Reduced motion disables automatic playback. No autoplay. Source selection pauses replay.

Source keeps verified, revision-pinned files and line ranges. Use the same light panel, compact file picker, readable code, line numbers and selected-range markers. Provenance remains expandable outside the workbench; the transcript remains available before hydration or after fetch failure. Inline and standalone use the same workbench.

## Scope and acceptance

No dependency, provider calls, new capture, permission decision, site-wide rebrand, video production or shared product package. No new resize/persistence subsystem in this pass: use the approved default split and responsive pane switcher. Verify semantic seek behavior, repeated calls, mode preservation, JSON escaping/bounds, source behavior and reduced motion. Review the real beta capture at 320/375/768/1024/1440px, with no horizontal page overflow and visible keyboard focus. Run focused tests, typecheck, lint and build; retain the earlier broad-validation limitation in the gate record rather than claiming it resolved.

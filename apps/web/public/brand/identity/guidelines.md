# b4.run brand guidelines

Version 1 · September 12, 2026 · Paper Relay

The approved visual direction combines the D2.2 wordmark with paper surfaces,
ink typography, Relay yellow-green accents, and dark code panels. It should feel
confident, precise, spacious, and comfortable to read.

These guidelines govern the visual identity. The homepage structure, positioning,
narrative, and copy will be rebuilt in a later phase. Neither the current homepage
nor the brainstorming layouts establish that future architecture.

## Status and source of truth

This document records the visual system approved during the September 12 brand
review. It supersedes the original kit's provisional palette and typography
guidance. The [D2.2 masters](logos/)
remain authoritative for logo geometry.

The [identity sheet](index.html),
[usage notes](usage-notes.md), and
[downloadable ZIP](https://b4.run/brand/b4-run-brand-assets.zip) are
synchronized to Paper Relay in this repository revision. Tight Shift files remain
available as archived alternatives, not approved defaults. Kit synchronization
does not change the main website's styling, logo masters, or favicon selection;
deployment status is separate from the checked-in assets.

## Name and identity

- Use the supplied lowercase `b4.run` wordmark. Pronounce it “bee-four dot run.”
- Retain the existing `B4.run` prose convention until the narrative phase decides
  editorial naming. Package names, commands, domains, and technical identifiers
  follow their actual spelling.
- The primary identity is D2.2: Big Dot, raised stem on the `4`, and open counters.
- The compact identity is `b4`, proportioned separately for small spaces.
- The logo consists of custom vector paths. Never recreate it by typing the name.

### Select the right master

| Placement | Master | Treatment |
| --- | --- | --- |
| Paper, white, or Relay surface | `wordmark-ink.svg` | Original ink geometry |
| Dark surface | `wordmark-white.svg` | Original white geometry |
| Avatar or constrained square | `compact-ink.svg` or `compact-white.svg` | Match ink to background |
| New Relay avatar | `compact-ink.svg` | Ink on a Relay field |
| Favicon | Existing `identity/icons/` size-specific exports | Verify at actual display size |

All master names above are relative to
[`apps/web/public/brand/identity/logos/`](logos/),
except favicon exports, which are in
[`identity/icons/`](icons/).

Use one wordmark dot diameter as clear space around the visible artwork. The
master dot diameter is 34 units; the visible artwork is 512 × 105 units inside a
522 × 115 viewBox. At a 160 px export width, allow approximately 10.4 px of clear
space on each side of the artwork. The SVG's built-in padding does not supply
the full margin.

For the compact mark, allow roughly one-third of the visible letter height as
clear space in ordinary compositions. Favicon containers are a constrained
exception. Start at 160 px wide for the wordmark and 24 px square for the compact;
use the included 120 px and 16 px proofs only after inspecting the actual context.
These are starting sizes, not guarantees of legibility.

Preserve proportions, letter spacing, raised stem, open counters, and the round
period. Use one ink per logo. Do not stretch, outline, recolor individual letters,
replace the period, or attach a tagline to the master.

## Color

Paper Relay is the default system. Tight Shift orange remains an archived
alternative in the original kit; it is not a second interchangeable brand theme.

| Role | Value | Use |
| --- | --- | --- |
| Paper | `#F5F4F0` | Primary page and editorial surface |
| Ink | `#111111` | Headings, primary text, ink logos |
| Dark | `#17181B` | Code panels and occasional contrasting compositions |
| Relay | `#B4CE37` | Primary actions, selected graphic emphasis, avatar fields |
| Relay tint | `#E7EDD1` | Quiet selection and informational backgrounds |
| Muted ink | `#595B53` | Secondary reading text on paper |
| Tint ink | `#424D18` | Inline code or small text on Relay tint |
| Divider | `#D6D6CC` | Decorative rules between already distinguishable sections |
| Focus | `#667811` | Focus indicator on paper; not normal text |

Paper should dominate ordinary reading surfaces. Concentrate Relay on a small
number of meaningful focal points. Dark fields can separate sections or support
code; they do not establish a dark-first website. White remains available where
an asset or embedding context requires it, but is not the primary page token.

### Contrast and interaction

Computed contrast ratios for solid, opaque color pairs:

| Foreground / background | Ratio | Intended use |
| --- | --- | --- |
| Ink / Paper | 17.16:1 | Primary text |
| Muted ink / Paper | 6.26:1 | Secondary text |
| Ink / Relay | 10.63:1 | Accent controls and titles |
| Paper / Dark | 16.13:1 | Text on dark panels |
| Tint ink / Relay tint | 7.56:1 | Small text and inline code |
| Focus / Paper | 4.48:1 | Focus ring |
| Relay / Paper | 1.61:1 | Decorative emphasis only |

These figures describe the specified pairs, not a finished-interface audit.
Keep normal text at or above 4.5:1 and essential control boundaries or focus
indicators at or above 3:1 against adjacent colors. Check actual rendered states,
including hover, disabled, selected, and focus treatments.

Use dark ink on Relay controls. Do not use Relay as reading text or the sole focus
indicator on paper. A Relay control that needs a visible perimeter should add a
contrasting ink boundary. Pale divider lines are decorative; they are not suitable
as the sole boundary of an input. Pair links with underlines and selected states
with a marker, label, or weight change so color is not the only cue.

Keep success, warning, error, and information semantics distinct. Their final
component colors and all dark-mode states belong to the UI implementation phase.

## Typography

Use **Inter** for display, headings, body text, and controls. Use **JetBrains Mono**
for code, paths, commands, and short technical labels. The logo is independent
of both families. Retain font licenses when distributing font files.

| Role | Starting size | Weight | Line height | Tracking |
| --- | --- | --- | --- | --- |
| Display | 64–96 px desktop; 40–56 px narrow screens | 600–700 | 1.0–1.08 | −0.04 to −0.055 em |
| Section heading | 32–44 px desktop; 28–34 px narrow screens | 600 | 1.1–1.2 | −0.03 to −0.04 em |
| Docs page title | 36–44 px desktop; 32–36 px narrow screens | 600 | 1.15 | −0.03 em |
| Subheading | 20–24 px | 600 | 1.3 | −0.02 em |
| Reading text | 16 px | 400; 500–600 for emphasis | 1.7–1.85 | Normal |
| Controls and navigation | 13–14 px | 500–600 | 1.4–1.5 | Normal |
| Code | 13–14 px | 400 | 1.65–1.8 | Normal |
| Short technical label | 10–12 px | 400–500 | 1.5 | Up to 0.08 em |

These are production starting values. The review mockups compressed some text to
fit multiple surfaces and are not pixel specifications. Keep reading measure near
60–75 characters and avoid all-uppercase prose. Use uppercase labels sparingly.
Scale type with available space; preserve hierarchy rather than forcing a fixed
line break from a desktop composition onto mobile.

Use sans-serif and monospace fallbacks from their respective families, and make
font loading non-blocking. Inspect wrapping with fallback fonts as well as loaded
fonts. Fraunces is not part of the approved new system; replacing its existing
uses is a later implementation step.

## Space, shape, and graphics

Use the spacing scale **8 / 16 / 24 / 32 / 48 / 72**, with smaller adjustments for
icon alignment and compact controls. Start page gutters at 24 px on narrow screens
and 40–48 px on desktop; adapt them to reading width and content density.

Prefer square panels, thin rules, and clear alignment. Avoid applying rounded
cards, shadows, gradients, or decorative containers to every section. Use a
container when it helps group related information. Preserve the logo's natural
curves; the preference for square panels does not alter icon masks or logos.

The oversized dot is the signature graphic. A separate circle may act as an
editorial focal point, diagram node, or section marker. It may crop at an outer
edge, but must not obscure text or intrude into logo clear space. Do not detach,
move, or animate the period inside the logo master.

Motion, if introduced, should explain state or direct attention briefly. Respect
reduced-motion preferences and avoid continuous decorative motion in reading
surfaces. Motion is optional, not a requirement of the brand.

## Applying the system

### Documentation

Use paper as the reading surface, ink headings, muted secondary text, and dark
code panels. Use Relay tint for restrained selection or informational callouts.
Keep code selectable and readable, with syntax colors that meet the contrast
requirements above. Long code lines can scroll within their panel.

Maintain visible navigation hierarchy and predictable focus states. Reading width,
zoom, narrow-screen navigation, anchor offsets, and search behavior must be
validated during implementation. The reviewed docs screen demonstrates styling;
its abbreviated content and navigation groups are not a new information
architecture. A complete docs dark theme remains outside this decision.

### Public asset templates

- **Social / Open Graph:** start with a 1200 × 630 composition, one headline,
  a clear logo, and optional category/context. Keep typography away from crop
  edges and inspect the card at a small feed size.
- **Avatar:** use the existing compact master on a square Relay or dark field.
  Check platform masks and actual small sizes before switching account imagery.
- **Editorial / release card:** use a paper or dark field, one announcement or
  guide title, and a restrained technical label. The logo and type rhythm should
  provide recognition across different topics.
- **Slides, video covers, and diagrams:** carry the same type, palette, spacing,
  and dot language into format-specific templates in later work.

Template text in the review study is placeholder content. Neither those titles
nor the original identity sheet's slogans are approved positioning or claims.
Existing product recordings remain evidence assets; do not change demonstrated
behavior, output, or timing to fit a visual treatment.

### Website and homepage

The visual foundation applies to the eventual website. Its homepage narrative,
section order, conversion flow, content, and overall structure will be designed
afresh in a later phase. No existing hero, headline, feature sequence, or
brainstorming composition is a requirement for that work.

## Adoption and review

This version formalizes the brand direction; it does not certify a complete
rollout. Apply it through separately scoped work:

1. Maintain the public kit, its usage guidance, previews, manifest, and downloadable
   archive together, preserving established asset URLs. The Paper Relay kit is
   synchronized in this revision.
2. Implement shared design tokens and docs styling while preserving actual docs
   content, navigation behavior, and technical contracts.
3. Develop the new homepage narrative and structure, then design and build the
   website around them.
4. Produce and review format-specific marketing assets and update the remaining
   public surfaces.

Before publishing each surface, inspect real logo sizes, loaded and fallback type,
contrast, keyboard focus, narrow layouts, and cropping. Verify links and technical
claims against the actual product. Keep exported assets and editable sources in
sync, and record exactly which surfaces changed. Brand approval does not imply
that an account, site, or package has already been updated.

---

Source: [repository brand guidelines](https://github.com/cacheplane/b4run/blob/brand/d2-2-identity-kit/docs/brand/guidelines.md).

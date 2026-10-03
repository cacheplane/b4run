import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "@b4run/ag-ui"
import { planActivityContentSchema } from "@b4run/ag-ui/react"
import type { ReactActivityMessageRenderer } from "@copilotkit/react-core/v2"
import { PlanCard } from "./PlanCard"

/**
 * The workbench registers its own wrapper rather than `b4ActivityRenderers`
 * so the card is the app's to restyle — the same source a scaffolded app will
 * own. The schema still comes from the package, so validation stays identical.
 * Subagents are not activities: `Transcript.tsx` renders them with the
 * package's `SubagentPanel`, from the agent's AG-UI `SUBAGENT_*` events.
 *
 * THE RULE EVERY CARD FOLLOWS — stated here once; `PlanCard.tsx` and the
 * `SubagentPanel` props in `Transcript.tsx` point back at it, so if the package
 * ever ships its stylesheet inside a layer, only this paragraph goes stale:
 *
 * A `classNames` entry may only set a property that `@b4run/ag-ui`'s
 * stylesheet leaves unset on that same element. That sheet is plain, UNLAYERED
 * CSS, while Tailwind emits its utilities inside `@layer utilities`, and
 * unlayered rules beat layered ones regardless of specificity — so a utility
 * touching a property the package already claims on that element loses
 * silently. Confirmed in the built CSS: every `.b4-activity*` rule sits at
 * top level, every utility inside `@layer utilities`.
 *
 * In practice that puts the card's own box out of reach from here: `background`,
 * `border`, `border-radius`, `color`, `font-size`, `margin` and `padding` are
 * all claimed on `.b4-activity`, as is `font-weight` on `.b4-activity__header`.
 * Rung 1 reaches every one of them: the package has a `--b4-activity-*` token
 * for surface, border color, text, radius, font-size, margin, padding and
 * header-weight. (Only the border's COLOR is a token — its 1px width and solid
 * style stay the package's.) `app/theme.css` overrides the five palette ones and
 * leaves the geometry and weight at the package's defaults.
 *
 * Still tokenless, and so still rung-4 work: the badge's radius, font-size,
 * weight and padding, the section label's weight and size, the item-status and
 * overflow font-sizes, and the list and item geometry.
 */
const planRenderer = {
  activityType: B4_PLAN_ACTIVITY_TYPE,
  content: planActivityContentSchema,
  render: ({ content }) => <PlanCard content={content} />,
} satisfies ReactActivityMessageRenderer<B4PlanActivityContent>

export const workbenchActivityRenderers = [planRenderer]

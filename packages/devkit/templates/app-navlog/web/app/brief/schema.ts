import { s, type UiComponentDefinition } from "@hashbrownai/core"

/**
 * The planning brief's components as the model sees them: a name, what each
 * is for, and its props as hashbrown schemas. No React here, so the server
 * route can derive the response schema from these (`kit.ts`) while the
 * browser pairs the same objects with their components (`components.tsx`).
 *
 * The schema is bound as OpenAI strict structured output, where every object
 * is closed and every property required. A prop the model may leave out
 * (`when`, `unit`) is therefore a string OR null, never absent; a citation
 * list the model may leave out is an array it can leave empty.
 */

const cite = s.array(
  "Ids of the Citations entries that back this claim, such as c1. Empty when nothing needs citing.",
  s.string("A Citations id"),
)

const bottomLineProps = {
  level: s.enumeration("The go/no-go call for the flight as planned.", ["GO", "CAUTION", "NO-GO"]),
  reason: s.string("One sentence: why that call, in plain words."),
  cite,
}

const routeSummaryProps = {
  from: s.string("Departure airport ICAO id, such as KSTP."),
  to: s.string("Destination airport ICAO id, such as KRST."),
  via: s.array(
    "Waypoints between them in flight order, as ICAO or fix ids. Empty when direct.",
    s.string("A waypoint id"),
  ),
  altitudeFt: s.number("Planned cruise altitude in feet MSL."),
  departureUtc: s.string("Planned departure time in UTC, such as 2026-10-10 1500Z."),
}

const watchForProps = {
  items: s.array(
    "What the pilot should watch during the flight, most serious first. Empty when nothing applies.",
    s.object("One thing to watch", {
      what: s.string("The hazard or concern, in one short sentence."),
      when: s.anyOf([s.string("When it applies, in UTC, such as 2100Z–0300Z."), s.nullish()]),
      severity: s.enumeration("How much it matters to this flight.", ["info", "caution", "danger"]),
      cite,
    }),
  ),
}

const keyNumbersProps = {
  items: s.array(
    "The figures the plan rests on: ETE, fuel burned (including 1.1 gal for start, taxi and runup), reserve, and any other number the pilot needs.",
    s.object("One figure", {
      label: s.string("What the figure is, in sentence case, such as Fuel burned."),
      value: s.string("The figure as the pilot reads it, such as 1:12 or 9.4."),
      unit: s.anyOf([s.string("Its unit, such as gal or kt."), s.nullish()]),
      cite,
    }),
  ),
}

const assumptionsProps = {
  items: s.array(
    "What the plan assumed that the pilot did not state outright.",
    s.object("One assumption", {
      statement: s.string("The assumption, in one short sentence."),
      origin: s.enumeration(
        "Where it came from: the pilot said it, memory recalled it, or it is a default.",
        ["pilot", "memory", "default"],
      ),
    }),
  ),
}

const citationsProps = {
  items: s.array(
    "The sources this answer cites, in the order they are first cited.",
    s.object("One source", {
      id: s.string("The id claims cite it by: c1, c2, …"),
      source: s.string(
        "The source, such as poh/cruise-performance.md, METAR KRST 1353Z, TAF KRST or AIRMET/SIGMET <id>.",
      ),
      locator: s.string(
        "Where in the source, such as Figure 5-7. Empty when the source is the whole thing.",
      ),
    }),
  ),
}

const proseProps = {
  markdown: s.string("Markdown text."),
}

export const bottomLineDefinition = {
  name: "BottomLine",
  description: "The go/no-go call and why. First in every planning answer, exactly once.",
  props: bottomLineProps,
} satisfies UiComponentDefinition

export const routeSummaryDefinition = {
  name: "RouteSummary",
  description:
    "The route the plan uses: from, via, to, cruise altitude and departure time. Distance and ETE come from the computed navlog, never repeated here.",
  props: routeSummaryProps,
} satisfies UiComponentDefinition

export const watchForDefinition = {
  name: "WatchFor",
  description: "Hazards and concerns during the flight, each with a severity and when it applies.",
  props: watchForProps,
} satisfies UiComponentDefinition

export const keyNumbersDefinition = {
  name: "KeyNumbers",
  description: "The figures the plan rests on, each with its unit and its citation.",
  props: keyNumbersProps,
} satisfies UiComponentDefinition

export const assumptionsDefinition = {
  name: "Assumptions",
  description:
    "What the plan assumed, each tagged with where it came from, so the pilot can correct it.",
  props: assumptionsProps,
} satisfies UiComponentDefinition

export const citationsDefinition = {
  name: "Citations",
  description:
    "The numbered sources the other components cite by id. Last of the brief components in a planning answer.",
  props: citationsProps,
} satisfies UiComponentDefinition

export const proseDefinition = {
  name: "Prose",
  description:
    "Plain markdown: a question, a short reply such as Filed., or anything that is not a planning brief. Any non-planning answer is a single Prose.",
  props: proseProps,
} satisfies UiComponentDefinition

/** Every component, in the order a planning answer uses them. */
export const briefDefinitions = [
  bottomLineDefinition,
  routeSummaryDefinition,
  watchForDefinition,
  keyNumbersDefinition,
  assumptionsDefinition,
  citationsDefinition,
  proseDefinition,
] as const

/** A props record's resolved TypeScript shape. */
type PropsOf<T extends Record<string, s.HashbrownType>> = { [K in keyof T]: s.Infer<T[K]> }

export type BottomLineProps = PropsOf<typeof bottomLineProps>
export type RouteSummaryProps = PropsOf<typeof routeSummaryProps>
export type WatchForProps = PropsOf<typeof watchForProps>
export type KeyNumbersProps = PropsOf<typeof keyNumbersProps>
export type AssumptionsProps = PropsOf<typeof assumptionsProps>
export type CitationsProps = PropsOf<typeof citationsProps>
export type ProseProps = PropsOf<typeof proseProps>

export type BriefLevel = BottomLineProps["level"]
export type WatchSeverity = WatchForProps["items"][number]["severity"]
export type AssumptionOrigin = AssumptionsProps["items"][number]["origin"]
export type Citation = CitationsProps["items"][number]

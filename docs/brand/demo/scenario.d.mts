/**
 * Types for the parts of `scenario.mjs` the generated navlog activation test
 * (test/generated/run-generated-navlog-activation.test.ts) reads. Nothing
 * type-checks this file against the .mjs; keep it in step by hand.
 */
export interface DemoScenario {
  /** The clock reading the scenario, and the AWC stub, are built from. */
  readonly now: number
  /** The next 1400Z at or after `now`, as an ISO 8601 instant. */
  readonly departureUtc: string
  readonly etaUtc: string
  readonly navlog: {
    readonly totals: {
      readonly distanceNm: number
      readonly eteMin: number
      readonly fuelGal: number
      readonly fuelRemainingGal: number
      readonly reserveMin: number
      readonly reserveOk: boolean
    }
  }
}

export function demoScenario(options?: { readonly now?: number }): DemoScenario

/** Throws when "1400Z" no longer resolves to the scenario's departure. */
export function assertScenarioCurrent(scenario: DemoScenario, now?: number): void

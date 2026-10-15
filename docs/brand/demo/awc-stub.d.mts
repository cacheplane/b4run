/**
 * Types for `awc-stub.mjs`, which the generated navlog activation test
 * (test/generated/run-generated-navlog-activation.test.ts) starts. Nothing
 * type-checks this file against the .mjs; keep the signature in step by hand.
 */
export interface AwcStub {
  /** `http://127.0.0.1:<port>`, for `B4_AWC_BASE_URL`. */
  readonly baseUrl: string
  /** Requests each product answered (a refused 400 is not a hit). */
  readonly hits: Readonly<
    Record<"airport" | "metar" | "taf" | "windtemp" | "gairmet" | "airsigmet", number>
  >
  close(): Promise<void>
}

export function startAwcStub(options: {
  readonly now: number
  readonly getPort?: () => Promise<number>
}): Promise<AwcStub>

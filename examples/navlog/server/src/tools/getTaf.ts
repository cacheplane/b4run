import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"

interface AwcTaf {
  readonly icaoId: string
  readonly issueTime?: string
  readonly validTimeFrom?: number
  readonly validTimeTo?: number
  readonly rawTAF: string
}

export interface Taf {
  readonly id: string
  readonly issuedAt: string
  readonly validFromUtc: string
  readonly validToUtc: string
  readonly raw: string
}

const iso = (epochSeconds: number | undefined): string =>
  epochSeconds === undefined ? "" : new Date(epochSeconds * 1000).toISOString()

/** Current TAF for one or more stations, with validity and the raw forecast text. */
export default async (
  input: { readonly ids: readonly string[] },
  ctx: B4ToolContext,
): Promise<Taf[]> => {
  const ids = input.ids.map((id) => id.trim().toUpperCase()).join(",")
  const records = await awc.getJson<AwcTaf[]>("taf", { ids }, ctx.signal)
  return records.map((record) => ({
    id: record.icaoId,
    issuedAt: record.issueTime ?? "",
    validFromUtc: iso(record.validTimeFrom),
    validToUtc: iso(record.validTimeTo),
    raw: record.rawTAF,
  }))
}

export const display = {
  icon: "web",
  running: ({ ids }) => `Fetching TAFs for ${ids.join(", ").toUpperCase()}`,
  done: (_input, tafs) => `Fetched ${tafs.length} TAF${tafs.length === 1 ? "" : "s"}`,
} satisfies ToolDisplay<{ readonly ids: readonly string[] }, Taf[]>

import { readFileSync } from "node:fs"

/**
 * US VORs and NDBs from the bundled OurAirports snapshot (`data/navaids.json`).
 * aviationweather.gov's navaid endpoint returns nothing, so the planner reads
 * navaids from this file instead.
 */
export interface Navaid {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly lat: number
  readonly lon: number
  readonly freqKhz: number | null
  /** Signed: east positive, west negative. */
  readonly magneticVariationDeg: number
}

/** One snapshot row: `[id, name, type, lat, lon, freqKhz, magVarDeg]`. */
export type NavaidRow = readonly [
  id: string,
  name: string,
  type: string,
  lat: number,
  lon: number,
  freqKhz: number | null,
  magVarDeg: number | null,
]

export interface NavaidIndex {
  find(id: string): Navaid | undefined
}

// A VOR and an NDB can share an identifier; the VOR is the one a VFR route means.
const VOR_FAMILY = new Set(["VOR", "VOR-DME", "VORTAC"])

/** Index snapshot rows by identifier. */
export function createNavaidIndex(rows: readonly NavaidRow[]): NavaidIndex {
  const byId = new Map<string, Navaid>()
  for (const [id, name, type, lat, lon, freqKhz, magVarDeg] of rows) {
    const key = id.trim().toUpperCase()
    const existing = byId.get(key)
    if (existing && (VOR_FAMILY.has(existing.type) || !VOR_FAMILY.has(type))) continue
    byId.set(key, {
      id: key,
      name,
      type,
      lat,
      lon,
      freqKhz,
      magneticVariationDeg: magVarDeg ?? 0,
    })
  }
  return { find: (id) => byId.get(id.trim().toUpperCase()) }
}

let snapshot: NavaidIndex | undefined

/** The bundled snapshot's index, read once on first use. */
function snapshotIndex(): NavaidIndex {
  if (!snapshot) {
    const file = JSON.parse(
      readFileSync(new URL("../../data/navaids.json", import.meta.url), "utf8"),
    ) as { readonly navaids: readonly NavaidRow[] }
    snapshot = createNavaidIndex(file.navaids)
  }
  return snapshot
}

/** Find a navaid in the bundled snapshot by identifier, case-insensitively. */
export function findNavaid(id: string): Navaid | undefined {
  return snapshotIndex().find(id)
}

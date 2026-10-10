// Types for build-waypoints.mjs, so the TypeScript tests can import it.

export type AirportRow = [id: string, alias: string | null, name: string, lat: number, lon: number]
export type WebNavaidRow = [
  id: string,
  name: string,
  type: string,
  lat: number,
  lon: number,
  freqKhz: number | null,
]
export type ServerNavaidRow = [...WebNavaidRow, magVarDeg: number | null]

export interface WebSnapshot {
  snapshot: string
  airports: AirportRow[]
  navaids: WebNavaidRow[]
}

export interface ServerSnapshot {
  snapshot: string
  navaids: ServerNavaidRow[]
}

export function parseCsv(text: string): string[][]

export function buildSnapshot(input: {
  airportsCsv: string
  navaidsCsv: string
  snapshot: string
}): { web: WebSnapshot; server: ServerSnapshot }

export function serializeSnapshot(data: WebSnapshot | ServerSnapshot): string

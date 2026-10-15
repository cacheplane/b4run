// Builds the winds-aloft station table: each FB station id in the contiguous-US
// low-level product, with its position.
//
// Usage (from examples/navlog/server):
//   node scripts/build-winds-stations.mjs [--date YYYY-MM-DD]
//
// Positions come from the bundled navaid snapshot (data/navaids.json, VOR
// family) first, then from aviationweather.gov's airport record for K<id>.
// Stations neither resolves (the Gulf points H51, H52, H61, offshore ids such
// as T01 and 2XG, and the land stations HAT and MQT, which the navaid snapshot
// lacks) are listed as unresolved and left out. Writes ../data/winds-stations.json.

import { readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const AWC = "https://aviationweather.gov/api/data"
const VOR_TYPES = /VOR|TAC|DME/

/**
 * The 3-character station ids of an FB product, in order. Ids are read only
 * below the altitude row (the line starting "FT "): the lines above it are
 * headers such as "FBUS31 KWNO 122001".
 */
export function stationIds(text) {
  const ids = []
  let inTable = false
  for (const line of text.split("\n")) {
    if (line.startsWith("FT ")) {
      inTable = true
      continue
    }
    if (!inTable) continue
    const id = line.slice(0, 3)
    if (/^[A-Z0-9]{3}$/.test(id) && line.length > 4) ids.push(id)
  }
  return [...new Set(ids)]
}

/** Resolves each id from the navaid rows, then from `lookupAirport(id)`; returns the table and the unresolved ids. */
export async function resolveStations(ids, navaidRows, lookupAirport) {
  const vors = new Map()
  for (const row of navaidRows)
    if (VOR_TYPES.test(row[2]) && !vors.has(row[0])) vors.set(row[0], row)
  const stations = []
  const unresolved = []
  for (const id of ids) {
    const vor = vors.get(id)
    if (vor) {
      stations.push([id, vor[3], vor[4]])
      continue
    }
    const airport = await lookupAirport(id)
    if (airport) stations.push([id, airport.lat, airport.lon])
    else unresolved.push(id)
  }
  return { stations, unresolved }
}

/** The table as Biome-formatted JSON: two-space indent, one station row per line. */
export function serializeTable(table) {
  const list = (items) => `[${items.map((item) => JSON.stringify(item)).join(", ")}]`
  const rows = table.stations.map((row) => `    ${list(row)}`).join(",\n")
  return [
    "{",
    `  "snapshot": ${JSON.stringify(table.snapshot)},`,
    `  "unresolved": ${list(table.unresolved)},`,
    `  "stations": [\n${rows}\n  ]`,
    "}",
    "",
  ].join("\n")
}

async function main() {
  const dateArg = process.argv.indexOf("--date")
  const snapshot = dateArg > 0 ? process.argv[dateArg + 1] : new Date().toISOString().slice(0, 10)
  const text = await (await fetch(`${AWC}/windtemp?region=all&level=low&fcst=06`)).text()
  const navaids = JSON.parse(
    readFileSync(new URL("../data/navaids.json", import.meta.url), "utf8"),
  ).navaids
  const lookupAirport = async (id) => {
    const body = await (await fetch(`${AWC}/airport?ids=K${id}&format=json`)).text()
    const [record] = body.trim() === "" ? [] : JSON.parse(body)
    return record && typeof record.lat === "number" ? { lat: record.lat, lon: record.lon } : null
  }
  const { stations, unresolved } = await resolveStations(stationIds(text), navaids, lookupAirport)
  writeFileSync(
    new URL("../data/winds-stations.json", import.meta.url),
    serializeTable({ snapshot, unresolved, stations }),
  )
  console.log(
    `winds-stations: ${stations.length} stations, unresolved: ${unresolved.join(", ") || "none"}`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()

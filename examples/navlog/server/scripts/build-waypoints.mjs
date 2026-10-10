// Builds the navlog waypoint snapshot from OurAirports CSV files.
//
// Source: OurAirports (https://ourairports.com/data/), public domain.
// Download the two inputs from:
//   https://davidmegginson.github.io/ourairports-data/airports.csv
//   https://davidmegginson.github.io/ourairports-data/navaids.csv
//
// Usage (from examples/navlog/server):
//   node scripts/build-waypoints.mjs <airports.csv> <navaids.csv> [--date YYYY-MM-DD]
//
// Writes ../../web/data/waypoints.json (airports and navaids for the route
// bar search) and ../data/navaids.json (navaids with magnetic variation for
// the lookupNavaid tool), both relative to this file. The date defaults to
// today (UTC).
//
// Community data for flight planning practice. Not for navigation.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const AIRPORT_TYPES = new Set(["small_airport", "medium_airport", "large_airport"])
const NAVAID_TYPES = new Set(["VOR", "VOR-DME", "VORTAC", "NDB", "NDB-DME"])

/** Parses RFC 4180 CSV text into an array of rows (arrays of strings). */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ""
  let quoted = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n" || ch === "\r") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
      if (ch === "\r" && text[i + 1] === "\n") i += 1
    } else {
      field += ch
    }
    i += 1
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function records(text) {
  const [header, ...rows] = parseCsv(text)
  if (header === undefined) return []
  return rows
    .filter((row) => !(row.length === 1 && row[0] === ""))
    .map((row) => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""])))
}

function round(value, places) {
  const factor = 10 ** places
  return Math.round(Number(value) * factor) / factor + 0
}

function numberOrNull(value, places) {
  if (value === undefined || value.trim() === "") return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return places === undefined ? number : round(number, places)
}

function compare(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Builds the web and server snapshots from OurAirports CSV text.
 * Returns `{ web, server }`.
 */
export function buildSnapshot({ airportsCsv, navaidsCsv, snapshot }) {
  const airports = records(airportsCsv)
    .filter((row) => row.iso_country === "US" && AIRPORT_TYPES.has(row.type))
    .map((row) => {
      const id = row.icao_code || row.gps_code || row.ident
      const alias = row.local_code !== "" && row.local_code !== id ? row.local_code : null
      return [id, alias, row.name, round(row.latitude_deg, 4), round(row.longitude_deg, 4)]
    })
    .sort((left, right) => compare(left[0], right[0]))

  const navaids = records(navaidsCsv)
    .filter((row) => row.iso_country === "US" && NAVAID_TYPES.has(row.type))
    .map((row) => [
      row.ident,
      row.name,
      row.type,
      round(row.latitude_deg, 4),
      round(row.longitude_deg, 4),
      numberOrNull(row.frequency_khz),
      numberOrNull(row.magnetic_variation_deg, 1),
    ])
    .sort((left, right) => compare(left[0], right[0]) || compare(left[2], right[2]))

  return {
    web: {
      snapshot,
      airports,
      navaids: navaids.map((navaid) => navaid.slice(0, 6)),
    },
    server: { snapshot, navaids },
  }
}

const LINE_WIDTH = 100

function row(item, last) {
  const values = item.map((value) => JSON.stringify(value))
  const inline = `    [${values.join(", ")}]${last ? "" : ","}`
  if (inline.length <= LINE_WIDTH) return inline
  return `    [\n${values.map((value) => `      ${value}`).join(",\n")}\n    ]${last ? "" : ","}`
}

function rows(list) {
  if (list.length === 0) return "[]"
  return `[\n${list.map((item, index) => row(item, index === list.length - 1)).join("\n")}\n  ]`
}

/**
 * Serializes a snapshot with one row per line, in the layout Biome's JSON
 * formatter produces (2-space indent, 100 columns), so the lint stays green.
 */
export function serializeSnapshot(data) {
  const parts = Object.entries(data).map(
    ([key, value]) =>
      `  ${JSON.stringify(key)}: ${Array.isArray(value) ? rows(value) : JSON.stringify(value)}`,
  )
  return `{\n${parts.join(",\n")}\n}\n`
}

function main(argv) {
  const args = [...argv]
  let snapshot = new Date().toISOString().slice(0, 10)
  const dateIndex = args.indexOf("--date")
  if (dateIndex !== -1) {
    snapshot = args[dateIndex + 1] ?? ""
    args.splice(dateIndex, 2)
  }
  if (args.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot)) {
    console.error(
      "Usage: node scripts/build-waypoints.mjs <airports.csv> <navaids.csv> [--date YYYY-MM-DD]",
    )
    process.exit(1)
  }
  const [airportsPath, navaidsPath] = args
  const { web, server } = buildSnapshot({
    airportsCsv: readFileSync(airportsPath, "utf8"),
    navaidsCsv: readFileSync(navaidsPath, "utf8"),
    snapshot,
  })
  const webPath = new URL("../../web/data/waypoints.json", import.meta.url)
  const serverPath = new URL("../data/navaids.json", import.meta.url)
  mkdirSync(new URL(".", webPath), { recursive: true })
  mkdirSync(new URL(".", serverPath), { recursive: true })
  writeFileSync(webPath, serializeSnapshot(web))
  writeFileSync(serverPath, serializeSnapshot(server))
  console.log(
    `snapshot ${snapshot}: ${web.airports.length} airports, ${web.navaids.length} navaids`,
  )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}

import { describe, expect, it } from "vitest"
import { buildSnapshot, parseCsv, serializeSnapshot } from "../scripts/build-waypoints.mjs"

const AIRPORTS_HEADER =
  '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"'

const AIRPORTS_CSV = [
  AIRPORTS_HEADER,
  '1,"00A","heliport","Total RF Heliport",40.070985,-74.933689,11,"NA","US","US-PA","Bensalem","no",,,"K00A","00A",,,',
  '2,"CYYZ","large_airport","Toronto Pearson",43.6772,-79.6306,569,"NA","CA","CA-ON","Toronto","yes","CYYZ","YYZ","CYYZ",,,,',
  '3,"KSTP","medium_airport","St Paul Downtown, Holman Field",44.93450164794922,-93.05999755859375,705,"NA","US","US-MN","St Paul","no","KSTP","STP","KSTP","STP",,,',
  '4,"00AA","small_airport","Aero B Ranch Airport",38.704022,-101.473911,3435,"NA","US","US-KS","Leoti","no",,,"00AA","00AA",,,',
  '5,"US-0001","small_airport","Sky ""Harbor"" Strip",45.123456,-92.987654,900,"NA","US","US-MN","Hudson","no",,,,"1W2",,,',
  '6,"K0XX","closed","Old Field",44,-93,800,"NA","US","US-MN","Nowhere","no",,,,"0XX",,,',
].join("\r\n")

const NAVAIDS_HEADER =
  '"id","filename","ident","name","type","frequency_khz","latitude_deg","longitude_deg","elevation_ft","iso_country","dme_frequency_khz","dme_channel","dme_latitude_deg","dme_longitude_deg","dme_elevation_ft","slaved_variation_deg","magnetic_variation_deg","usageType","power","associated_airport"'

const NAVAIDS_CSV = `${[
  NAVAIDS_HEADER,
  '1,"f","ODI","Nodine","VORTAC",117300,43.91320037841797,-91.47029876708984,1240,"US",,,,,,,-1.873,"BOTH","HIGH",',
  '2,"f","FCM","Flying Cloud","VOR-DME",111800,44.82,-93.4569,,"US",,,,,,,,"BOTH","LOW",',
  '3,"f","NZY","North Island","TACAN",,32.7,-117.2,,"US",,,,,,,12.3,"BOTH","HIGH",',
  '4,"f","1A","Williams Harbour","NDB",373,52.55889892578125,-55.78219985961914,70,"CA",,,,,,,-23.072,"LO","MEDIUM",',
  '5,"f","FCM","Flying Cloud, MN","NDB",254,44.825,-93.457,,"US",,,,,,,0.04,"LO","LOW",',
].join("\n")}\n`

describe("parseCsv", () => {
  it("splits plain fields and rows on LF and CRLF", () => {
    expect(parseCsv("a,b\r\nc,d\ne,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ])
  })

  it("keeps commas inside quoted fields", () => {
    expect(parseCsv('"St Paul, MN",2\n')).toEqual([["St Paul, MN", "2"]])
  })

  it("unescapes doubled quotes inside quoted fields", () => {
    expect(parseCsv('"Sky ""Harbor"" Strip",,x')).toEqual([['Sky "Harbor" Strip', "", "x"]])
  })
})

describe("buildSnapshot", () => {
  const { web, server } = buildSnapshot({
    airportsCsv: AIRPORTS_CSV,
    navaidsCsv: NAVAIDS_CSV,
    snapshot: "2026-10-10",
  })

  it("keeps US airports of the three airport types, keyed and aliased", () => {
    expect(web.snapshot).toBe("2026-10-10")
    expect(web.airports).toEqual([
      ["00AA", null, "Aero B Ranch Airport", 38.704, -101.4739],
      ["KSTP", "STP", "St Paul Downtown, Holman Field", 44.9345, -93.06],
      ["US-0001", "1W2", 'Sky "Harbor" Strip', 45.1235, -92.9877],
    ])
  })

  it("keeps US navaids of the VOR and NDB types for the web", () => {
    expect(web.navaids).toEqual([
      ["FCM", "Flying Cloud, MN", "NDB", 44.825, -93.457, 254],
      ["FCM", "Flying Cloud", "VOR-DME", 44.82, -93.4569, 111800],
      ["ODI", "Nodine", "VORTAC", 43.9132, -91.4703, 117300],
    ])
  })

  it("adds magnetic variation to the server navaids", () => {
    expect(server).toEqual({
      snapshot: "2026-10-10",
      navaids: [
        ["FCM", "Flying Cloud, MN", "NDB", 44.825, -93.457, 254, 0],
        ["FCM", "Flying Cloud", "VOR-DME", 44.82, -93.4569, 111800, null],
        ["ODI", "Nodine", "VORTAC", 43.9132, -91.4703, 117300, -1.9],
      ],
    })
  })

  it("serializes one row per line in Biome's JSON layout", () => {
    expect(serializeSnapshot(server)).toBe(
      "{\n" +
        '  "snapshot": "2026-10-10",\n' +
        '  "navaids": [\n' +
        '    ["FCM", "Flying Cloud, MN", "NDB", 44.825, -93.457, 254, 0],\n' +
        '    ["FCM", "Flying Cloud", "VOR-DME", 44.82, -93.4569, 111800, null],\n' +
        '    ["ODI", "Nodine", "VORTAC", 43.9132, -91.4703, 117300, -1.9]\n' +
        "  ]\n" +
        "}\n",
    )
  })

  it("wraps a row past 100 columns one value per line", () => {
    const name = "N".repeat(90)
    expect(
      serializeSnapshot({
        snapshot: "2026-10-10",
        navaids: [["X", name, "NDB", 1, 2, null, null]],
      }),
    ).toBe(
      "{\n" +
        '  "snapshot": "2026-10-10",\n' +
        '  "navaids": [\n' +
        "    [\n" +
        '      "X",\n' +
        `      "${name}",\n` +
        '      "NDB",\n' +
        "      1,\n" +
        "      2,\n" +
        "      null,\n" +
        "      null\n" +
        "    ]\n" +
        "  ]\n" +
        "}\n",
    )
  })
})

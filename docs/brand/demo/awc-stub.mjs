import { createServer } from "node:http"
import { demoAwcData } from "./scenario.mjs"

/**
 * A loopback stand-in for the aviationweather.gov Data API, so the capture is
 * offline and its weather deterministic. The capture points the generated
 * server at it with `B4_AWC_BASE_URL` (template `server/src/lib/awc.ts`), and
 * the template's tools run unchanged against it.
 *
 * It answers the six products the scripted flow reaches, the way the tools ask
 * for them (`server/src/tools/*.ts`):
 *
 * - `airport`, `metar`, `taf`: `ids=<comma-separated ids>&format=json`, a JSON
 *   array of the known stations in the order asked, or 204 when none is known.
 * - `gairmet`, `airsigmet`: `format=json`, an empty JSON array (no advisory).
 * - `windtemp`: `region=chi&level=low&fcst=06|12|24`, the FB text product.
 *
 * Anything else is a 404 (an unknown product) or a 400 (a parameter the tools
 * never send), each with a plain-text body saying which. `hits` counts the
 * requests each product answered, so the capture can assert the run reached it.
 */
const JSON_PRODUCTS = new Set(["airport", "metar", "taf", "gairmet", "airsigmet"])
const ENDPOINTS = ["airport", "metar", "taf", "windtemp", "gairmet", "airsigmet"]
const FORECASTS = new Set(["06", "12", "24"])

function send(response, status, type, body) {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    ...(body === "" ? {} : { "content-length": Buffer.byteLength(body) }),
  })
  response.end(body)
}

const text = (response, status, body) => send(response, status, "text/plain; charset=utf-8", body)

function answer(data, product, params) {
  if (JSON_PRODUCTS.has(product)) {
    if (params.get("format") !== "json") {
      return { status: 400, text: `AWC stub: /${product} serves format=json only` }
    }
    if (product === "gairmet" || product === "airsigmet") return { json: data[product] }
    const ids = (params.get("ids") ?? "")
      .split(",")
      .map((id) => id.trim().toUpperCase())
      .filter((id) => id !== "")
    if (ids.length === 0) return { status: 400, text: `AWC stub: /${product} needs ids=` }
    const table = product === "airport" ? data.airports : product === "metar" ? data.metars : data.tafs
    const records = ids.flatMap((id) => (table[id] ? [table[id]] : []))
    return records.length === 0 ? { status: 204 } : { json: records }
  }
  // windtemp
  const region = params.get("region")
  if (region !== data.windsRegion) {
    return { status: 400, text: `AWC stub: /windtemp serves region=${data.windsRegion} only, got ${region}` }
  }
  if (params.get("level") !== "low") return { status: 400, text: "AWC stub: /windtemp serves level=low only" }
  const fcst = params.get("fcst") ?? ""
  if (!FORECASTS.has(fcst)) return { status: 400, text: `AWC stub: /windtemp fcst must be 06, 12 or 24, got ${fcst}` }
  return { text: data.windtemp(fcst) }
}

/**
 * Start the stub on 127.0.0.1. `getPort` (the capture's port allocator)
 * chooses the port; without it the OS assigns one. `now` fixes the clock the
 * weather is built for, and should be the one the scenario was built with.
 */
export async function startAwcStub({ getPort, now = Date.now() } = {}) {
  const data = demoAwcData(now)
  const hits = Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint, 0]))
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const product = url.pathname.replace(/^\/+|\/+$/g, "")
    if (!ENDPOINTS.includes(product)) {
      text(response, 404, `AWC stub: no endpoint ${url.pathname}; it serves /${ENDPOINTS.join(", /")}\n`)
      return
    }
    if (request.method !== "GET") {
      text(response, 405, `AWC stub: /${product} answers GET only\n`)
      return
    }
    const result = answer(data, product, url.searchParams)
    if (result.status === 400) {
      text(response, 400, `${result.text}\n`)
      return
    }
    hits[product] += 1
    if (result.status === 204) send(response, 204, "text/plain; charset=utf-8", "")
    else if (result.json !== undefined) send(response, 200, "application/json", JSON.stringify(result.json))
    else text(response, 200, result.text)
  })
  const port = typeof getPort === "function" ? await getPort() : 0
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new Error("AWC stub: node:http did not report a TCP port")
  }
  let closing
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hits,
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
      return closing
    },
  }
}

import { type AppFlavour, flavourForHost, hostFromHeaders } from "../../lib/app-host"

// Answers per request host (b4.run, test.b4.run, local.b4.run share one project).
export const dynamic = "force-dynamic"

const BUNDLE = "com.cacheplane.b4app"

// Bundle id suffixes per flavour, as the apps build them. Prod has none.
const SUFFIXES: Readonly<Record<AppFlavour, { mac: string; ios: string }>> = {
  prod: { mac: "", ios: "" },
  beta: { mac: ".beta", ios: "" },
  local: { mac: ".local", ios: ".local" },
}

// Apple team ids are ten uppercase letters and digits.
const TEAM_ID = /^[A-Z0-9]{10}$/

const notFound = () => new Response("Not found", { status: 404 })

export async function GET(request: Request): Promise<Response> {
  const flavour = flavourForHost(hostFromHeaders(request.headers))
  const team = process.env.APPLE_TEAM_ID
  if (flavour === null || team === undefined || !TEAM_ID.test(team)) return notFound()

  const suffix = SUFFIXES[flavour]
  const mac = `${team}.${BUNDLE}${suffix.mac}`
  const ios = `${team}.${BUNDLE}.ios${suffix.ios}`
  const body = {
    webcredentials: { apps: [mac, ios] },
    applinks: {
      details: [{ appIDs: [ios], components: [{ "/": "/pair", comment: "Pair an iPhone" }] }],
    },
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

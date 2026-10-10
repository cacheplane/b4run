import data from "../../../data/waypoints.json"
import { guardRequest } from "../../lib/guarded-request"
import { searchWaypoints, type WaypointData } from "../../lib/waypoint-search"

// Waypoint search for the route bar: `GET /api/waypoints?q=sns`. The snapshot
// is bundled with the app, so this never calls the B4.run server; it still
// passes the same guard the `/api/b4` proxy does (origin, visitor cookie, the
// loose "read" rate-limit bucket), because a public search endpoint is as easy
// to flood as a proxied read.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Longer queries are truncated silently, not refused: no id or useful name
// prefix is longer, and the cap only bounds the work one request can ask for.
const MAX_QUERY_LENGTH = 32

// JSON imports widen the row tuples to arrays, so the shape is asserted here;
// the snapshot builder (server/scripts/build-waypoints.mjs) is what guarantees it.
const snapshot = data as unknown as WaypointData

export async function GET(request: Request): Promise<Response> {
  const guarded = await guardRequest(request, "b4")
  if (guarded.rejection !== undefined) return guarded.rejection
  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, MAX_QUERY_LENGTH)
  return guarded.finish(
    Response.json(
      { results: searchWaypoints(snapshot, q), snapshot: snapshot.snapshot },
      { headers: { "cache-control": "no-store" } },
    ),
  )
}

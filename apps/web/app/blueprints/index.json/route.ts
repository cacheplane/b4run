import { NextResponse } from "next/server"
import { loadBlueprints } from "../../../lib/blueprints"

// Rendered once at build time and served from the CDN; rebuilt every deploy.
export const dynamic = "force-static"

export function GET() {
  return NextResponse.json(loadBlueprints().map((entry) => entry.meta))
}

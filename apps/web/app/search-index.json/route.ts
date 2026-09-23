import { NextResponse } from "next/server"
import { DOCS_INDEX } from "../components/docs/search-index"

// Prerendered at build time: the search dialog fetches this once, the first
// time it opens, instead of every docs page serializing the index inline.
export const dynamic = "force-static"

export function GET() {
  return NextResponse.json(DOCS_INDEX)
}

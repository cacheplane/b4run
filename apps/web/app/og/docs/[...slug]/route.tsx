import { docsImagePageFor, docsImageParams, renderDocsImage } from "../docs-image"

// Every registered docs page's card is rendered once at build and served from
// the CDN; any other slug is a 404 rather than an on-demand render.
export const dynamic = "force-static"
export const dynamicParams = false

export function generateStaticParams() {
  return docsImageParams()
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
): Promise<Response> {
  const { slug } = await params
  const page = docsImagePageFor(slug)
  if (!page) return new Response("Not found", { status: 404 })
  return renderDocsImage(page)
}

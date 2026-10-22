import {
  defaultFounderStopDeps,
  handleFounderStopGet,
  handleFounderStopPost,
} from "../../../lib/growth/routes/founder-stop"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = (request: Request) => handleFounderStopGet(request, defaultFounderStopDeps())
export const POST = (request: Request) => handleFounderStopPost(request, defaultFounderStopDeps())

import {
  defaultFounderUpdatesDeps,
  handleFounderUpdatesPost,
} from "../../../../lib/growth/routes/founder-updates"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = (request: Request) =>
  handleFounderUpdatesPost(request, defaultFounderUpdatesDeps())

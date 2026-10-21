import {
  defaultUnsubscribeDeps,
  handleUnsubscribeGet,
  handleUnsubscribePost,
} from "../../../lib/growth/routes/unsubscribe"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = (request: Request) => handleUnsubscribeGet(request, defaultUnsubscribeDeps())
export const POST = (request: Request) => handleUnsubscribePost(request, defaultUnsubscribeDeps())

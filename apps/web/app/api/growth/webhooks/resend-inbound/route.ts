import {
  defaultResendInboundDeps,
  handleResendInbound,
} from "../../../../lib/growth/routes/resend-inbound"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export const POST = (request: Request) => handleResendInbound(request, defaultResendInboundDeps())

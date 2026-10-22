import {
  defaultResendWebhookDeps,
  handleResendWebhook,
} from "../../../../lib/growth/routes/resend-webhook"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = (request: Request) => handleResendWebhook(request, defaultResendWebhookDeps())

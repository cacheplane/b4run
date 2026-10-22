import { defaultTickDeps, handleTick } from "../../../lib/growth/routes/tick"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = (request: Request) => handleTick(request, defaultTickDeps())

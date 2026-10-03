/**
 * Body ceilings for the two run endpoints that carry conversation content.
 * Larger than the other JSON endpoints' 1 MiB because an AG-UI client resends
 * the thread's entire message history on every run, and because inline media
 * parts (`source.type: "data"`, base64) ride inside it: 8 MiB leaves room for
 * a long conversation and a few images while keeping one request from
 * buffering without bound. Shared by `POST /agui/:routeId` and the Agent
 * Protocol `POST /threads/:id/runs/*` family, which now accept the same
 * content shapes. There is deliberately no per-part cap (spec §2.5).
 */
export const AGUI_BODY_MAX_BYTES = 8 * 1024 * 1024

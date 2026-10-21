import { z } from "zod"

const slug = z.string().regex(/^[a-z0-9-]+$/, "slug must be lowercase kebab-case")

export const DashboardLocal = z.object({
  slug,
  posthog_id: z.number().nullable(),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  tiles: z.array(z.object({ insight: z.string() })),
})
export type DashboardLocal = z.infer<typeof DashboardLocal>

const property = z
  .object({
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    operator: z.enum(["exact", "is_not", "icontains", "is_set", "is_not_set"]).default("exact"),
  })
  .refine(
    (p) => p.operator === "is_set" || p.operator === "is_not_set" || p.value !== undefined,
    "comparison filters require a value",
  )

export const InsightLocal = z
  .object({
    slug,
    posthog_id: z.number().nullable(),
    kind: z.enum(["trends", "funnel"]),
    name: z.string().min(1),
    description: z.string().optional(),
    // trends-specific
    events: z
      .array(
        z.object({
          event: z.string(),
          name: z.string().optional(),
          math: z.enum(["total", "dau", "unique_session"]).optional(),
          properties: z.array(property).optional(),
        }),
      )
      .optional(),
    breakdown: z.string().optional(),
    breakdown_limit: z.number().int().positive().optional(),
    interval: z.enum(["minute", "hour", "day", "week", "month"]).default("day"),
    // funnel-specific
    window_minutes: z.number().int().positive().optional(),
    steps: z.array(z.object({ event: z.string(), name: z.string().optional() })).optional(),
    date_from: z.string().default("-30d"),
  })
  .refine((v) => (v.kind === "funnel" ? Array.isArray(v.steps) && v.steps.length > 0 : true), {
    message: "funnel insights require non-empty steps",
    path: ["steps"],
  })
export type InsightLocal = z.infer<typeof InsightLocal>

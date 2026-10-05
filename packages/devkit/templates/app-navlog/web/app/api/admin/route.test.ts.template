import { afterEach, describe, expect, test, vi } from "vitest"
import { GET } from "./route"

afterEach(() => {
  vi.unstubAllEnvs()
})

const visit = (query: string) => GET(new Request(`https://navlog.test/api/admin${query}`))

describe("admin route", () => {
  test("does not exist without an admin token configured", () => {
    vi.stubEnv("B4_DEMO_ADMIN_TOKEN", "")
    expect(visit("?token=anything").status).toBe(404)
  })

  test("refuses a wrong or missing token and sets no cookie", () => {
    vi.stubEnv("B4_DEMO_ADMIN_TOKEN", "owner-secret")
    for (const query of ["?token=wrong", ""]) {
      const response = visit(query)
      expect(response.status).toBe(403)
      expect(response.headers.has("set-cookie")).toBe(false)
    }
  })

  test("sets the owner cookie and redirects home on the right token", () => {
    vi.stubEnv("B4_DEMO_ADMIN_TOKEN", "owner-secret")
    vi.stubEnv("B4_INTERNAL_TOKEN", "server-secret")
    const response = visit("?token=owner-secret")
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("https://navlog.test/")
    const cookie = response.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("b4_demo_owner=owner-secret")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
  })
})

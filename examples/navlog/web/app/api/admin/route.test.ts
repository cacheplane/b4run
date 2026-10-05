import { afterEach, describe, expect, test, vi } from "vitest"
import { ownerCookieValue } from "../../lib/proxy-guard"
import { GET } from "./route"

afterEach(() => {
  vi.unstubAllEnvs()
})

const OWNER = "owner-secret-0123456789abcdefghijklmnop"

const visit = (query: string) => GET(new Request(`https://navlog.test/api/admin${query}`))

describe("admin route", () => {
  test("does not exist without an admin token configured", () => {
    vi.stubEnv("B4_DEMO_ADMIN_TOKEN", "")
    expect(visit("?token=anything").status).toBe(404)
  })

  test("does not exist when the admin token is shorter than 32 characters", () => {
    vi.stubEnv("B4_DEMO_ADMIN_TOKEN", "short-owner-secret")
    expect(visit("?token=short-owner-secret").status).toBe(404)
  })

  test("refuses a wrong or missing token and sets no cookie", () => {
    vi.stubEnv("B4_DEMO_ADMIN_TOKEN", OWNER)
    for (const query of ["?token=wrong", ""]) {
      const response = visit(query)
      expect(response.status).toBe(403)
      expect(response.headers.has("set-cookie")).toBe(false)
    }
  })

  test("sets the owner cookie and redirects home on the right token", () => {
    vi.stubEnv("B4_DEMO_ADMIN_TOKEN", OWNER)
    vi.stubEnv("B4_INTERNAL_TOKEN", "server-secret")
    const response = visit(`?token=${OWNER}`)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("https://navlog.test/")
    const cookie = response.headers.get("set-cookie") ?? ""
    // The HMAC of the token under the `__Host-` name, never the token itself.
    expect(cookie).toContain(`__Host-b4_demo_owner=${ownerCookieValue(OWNER)}`)
    expect(cookie).not.toContain(OWNER)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
  })

  test("uses the plain cookie name and no Secure flag in development", () => {
    vi.stubEnv("B4_DEMO_ADMIN_TOKEN", OWNER)
    vi.stubEnv("B4_INTERNAL_TOKEN", "")
    const cookie = visit(`?token=${OWNER}`).headers.get("set-cookie") ?? ""
    expect(cookie.startsWith("b4_demo_owner=")).toBe(true)
    expect(cookie).not.toContain("Secure")
  })
})

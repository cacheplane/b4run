import { expect, test } from "@playwright/test"

const appOrigin = "http://127.0.0.1:3010"

type RuntimeRequest = {
  method: string
  pathname: string
}

test("selects the CopilotKit V2 multi-route transport", async ({ page }) => {
  const runtimeRequests: RuntimeRequest[] = []

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin === appOrigin && url.pathname.startsWith("/api/copilotkit")) {
      runtimeRequests.push({ method: request.method(), pathname: url.pathname })
    }
  })

  await page.route("**/api/b4/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ candidates: [] }),
    })
  })

  const infoResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      response.request().method() === "GET" &&
      url.origin === appOrigin &&
      url.pathname === "/api/copilotkit/info"
    )
  })

  // `CopilotChat` restores the active thread by connecting to it; the runtime
  // route replays the thread from B4.run's storage.
  const connectRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return (
      request.method() === "POST" &&
      url.origin === appOrigin &&
      url.pathname === "/api/copilotkit/agent/default/connect"
    )
  })

  await page.goto("/")

  const infoResponse = await infoResponsePromise
  expect(infoResponse.ok()).toBe(true)
  expect(await infoResponse.finished()).toBeNull()
  const connectRequest = await connectRequestPromise
  expect(typeof connectRequest.postDataJSON()?.threadId).toBe("string")
  await page.waitForLoadState("networkidle")
  expect(runtimeRequests[0]).toEqual({ method: "GET", pathname: "/api/copilotkit/info" })
  expect(runtimeRequests).toContainEqual({
    method: "POST",
    pathname: "/api/copilotkit/agent/default/connect",
  })
  expect(runtimeRequests).not.toContainEqual({ method: "POST", pathname: "/api/copilotkit" })
})

// Since @copilotkit/react-core 1.77.1 the `CopilotKit` wrapper leaves
// `useSingleEndpoint` unset, and the core then probes `GET /info` first too, so
// the test above passes with or without the prop. What `useSingleEndpoint={false}`
// still decides is the failure path: unset, a refused `/info` falls back to the
// single-endpoint `POST {"method":"info"}` at the base URL; pinned, it does not.
test("a refused /info does not fall back to the single-endpoint transport", async ({ page }) => {
  const runtimeRequests: RuntimeRequest[] = []

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin === appOrigin && url.pathname.startsWith("/api/copilotkit")) {
      runtimeRequests.push({ method: request.method(), pathname: url.pathname })
    }
  })
  await page.route("**/api/b4/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ candidates: [] }),
    })
  })
  await page.route("**/api/copilotkit/info", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
  })
  const refused = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/copilotkit/info",
  )

  await page.goto("/")

  expect((await refused).status()).toBe(503)
  await page.waitForLoadState("networkidle")
  expect(runtimeRequests).toContainEqual({ method: "GET", pathname: "/api/copilotkit/info" })
  expect(runtimeRequests).not.toContainEqual({ method: "POST", pathname: "/api/copilotkit" })
})

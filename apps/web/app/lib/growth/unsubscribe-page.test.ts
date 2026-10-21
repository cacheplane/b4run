import { describe, expect, it } from "vitest"
import { renderConfirmPage, renderDonePage, renderFailurePage } from "./unsubscribe-page"

describe("unsubscribe pages", () => {
  it("escapes the token and ships no script", () => {
    const html = renderConfirmPage({ token: `"><script>alert(1)</script>&'` })
    expect(html).not.toContain("<script")
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;")
    expect(html).toContain('<form method="post"')
    expect(html).toContain("Unsubscribe</button>")
  })

  it("renders the uniform failure text and a done page", () => {
    expect(renderFailurePage()).toContain("This link is not valid.")
    expect(renderDonePage()).toContain("unsubscribed")
    for (const page of [renderDonePage(), renderFailurePage()]) {
      expect(page).not.toContain("<script")
    }
  })
})

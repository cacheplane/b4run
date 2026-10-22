import { describe, expect, it } from "vitest"
import {
  FOUNDER_STOP_CONFIRM,
  FOUNDER_STOP_DONE,
  renderConfirmPage,
  renderDonePage,
  renderFailurePage,
  UNSUBSCRIBE_CONFIRM,
  UNSUBSCRIBE_DONE,
} from "./unsubscribe-page"

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

  it("renders the unsubscribe copy unchanged when its values are passed explicitly", () => {
    expect(renderConfirmPage({ token: "t", ...UNSUBSCRIBE_CONFIRM })).toBe(
      renderConfirmPage({ token: "t" }),
    )
    expect(renderDonePage(UNSUBSCRIBE_DONE)).toBe(renderDonePage())
    expect(renderConfirmPage({ token: "t" })).toContain('action="/api/growth/unsubscribe"')
  })

  it("renders the founder-stop form action, button label and done copy", () => {
    const html = renderConfirmPage({ token: "a&b", ...FOUNDER_STOP_CONFIRM })
    expect(html).toContain('<form method="post" action="/api/growth/founder-stop">')
    expect(html).toContain("Stop the sequence</button>")
    expect(html).toContain('value="a&amp;b"')
    expect(html).not.toContain("Unsubscribe")
    expect(html).not.toContain("<script")
    const done = renderDonePage(FOUNDER_STOP_DONE)
    expect(done).toContain("The sequence is stopped.")
    expect(done).not.toContain("<script")
  })

  it("escapes caller-supplied copy and action paths", () => {
    const html = renderConfirmPage({
      token: "t",
      title: "<t>",
      heading: "<h>",
      action: '/x"><script>',
      buttonLabel: "<b>",
    })
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<t>")
    expect(html).not.toContain("<b>")
  })
})

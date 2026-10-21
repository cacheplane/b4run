// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { classifyClick } from "./click-signals"

const ORIGIN = "http://localhost:3000"

function mount(html: string): Document {
  document.body.innerHTML = html
  return document
}

describe("classifyClick", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("counts a data-cta-id element once as a cta click, even when it is an external anchor", () => {
    mount(
      `<nav data-signal-surface="header"><a id="a" href="https://github.com/cacheplane/b4run" data-cta-id="header_github"><span id="inner">x</span></a></nav>`,
    )
    const signal = classifyClick(document.getElementById("inner"), ORIGIN)
    expect(signal).toMatchObject({
      event: "site:cta_click",
      cta_id: "header_github",
      surface: "header",
    })
  })

  it("derives the surface from the pathname when no surface ancestor exists", () => {
    mount(`<button id="b" data-cta-id="docs_prompt_copy">copy</button>`)
    window.history.pushState({}, "", "/docs/getting-started")
    expect(classifyClick(document.getElementById("b"), ORIGIN)).toMatchObject({ surface: "docs" })
    window.history.pushState({}, "", "/blog/post")
    expect(classifyClick(document.getElementById("b"), ORIGIN)).toMatchObject({ surface: "blog" })
    window.history.pushState({}, "", "/")
    expect(classifyClick(document.getElementById("b"), ORIGIN)).toMatchObject({ surface: "home" })
  })

  it("counts an off-site https anchor as an external link click with its host only", () => {
    mount(`<a id="a" href="https://example.com/secret/path?q=1">x</a>`)
    expect(classifyClick(document.getElementById("a"), ORIGIN)).toEqual({
      event: "site:external_link_click",
      destination_host: "example.com",
      surface: "home",
    })
  })

  it.each(["mailto:x@y.z", "/docs", "#top"])("ignores %s", (href) => {
    mount(`<a id="a" href="${href}">x</a>`)
    expect(classifyClick(document.getElementById("a"), ORIGIN)).toBeUndefined()
  })

  it("ignores non-anchor targets and null", () => {
    mount(`<p id="p">x</p>`)
    expect(classifyClick(document.getElementById("p"), ORIGIN)).toBeUndefined()
    expect(classifyClick(null, ORIGIN)).toBeUndefined()
    expect(classifyClick(document, ORIGIN)).toBeUndefined()
  })
})

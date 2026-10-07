import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { type DropNotice, DropNotices, dropNoticeText } from "./DropNotices"

describe("dropNoticeText", () => {
  test("one part names its type and the adapter's reason verbatim", () => {
    expect(dropNoticeText([{ index: 0, type: "image", reason: "unsupported_by_provider" }])).toBe(
      "1 content part was not sent to the model: image (unsupported_by_provider)",
    )
  })

  test("several parts are counted and listed in order", () => {
    expect(
      dropNoticeText([
        { index: 0, type: "image", reason: "too_large" },
        { index: 2, type: "audio", reason: "unsupported_by_provider" },
      ]),
    ).toBe(
      "2 content parts were not sent to the model: image (too_large), audio (unsupported_by_provider)",
    )
  })
})

describe("DropNotices", () => {
  test("renders nothing when there are no notices", () => {
    expect(renderToStaticMarkup(<DropNotices notices={[]} />)).toBe("")
  })

  test("each notice is a quiet disclosure with the reason codes inside", () => {
    const notices: DropNotice[] = [
      { toolCallId: "call_1", parts: [{ index: 0, type: "image", reason: "too_large" }] },
      {
        parts: [
          { index: 0, type: "image", reason: "too_large" },
          { index: 1, type: "video", reason: "unsupported_by_provider" },
        ],
      },
    ]
    const html = renderToStaticMarkup(<DropNotices notices={notices} />)
    expect(html.match(/<details/g)).toHaveLength(2)
    expect(html).toContain("The planner could not see this content")
    expect(html).toContain("The planner could not see 2 items")
    expect(html).toContain("1 content part was not sent to the model: image (too_large)")
    expect(html).toContain("video (unsupported_by_provider)")
  })
})

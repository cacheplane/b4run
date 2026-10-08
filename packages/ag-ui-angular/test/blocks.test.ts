import { ChangeDetectionStrategy, Component, signal } from "@angular/core"
import { TestBed } from "@angular/core/testing"
import { MAX_DETAIL_CHARS, type StepSource } from "@b4run/ag-ui/view"
import { TOOL_DISPLAY_ICONS } from "@b4run/sdk"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { DisclosureComponent } from "../src/lib/disclosure.component"
import { SourceChipsComponent } from "../src/lib/source-chips.component"
import { disclosure, elapsedSignal, liveSignal } from "../src/lib/state"
import { StepDetailComponent } from "../src/lib/step-detail.component"
import { StepIconComponent } from "../src/lib/step-icon.component"
import { click, mount, update } from "./render"

const html = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement

describe("b4-source-chips", () => {
  test("renders a labelled list of chips with +N overflow after the limit", () => {
    const sources: StepSource[] = [
      { title: "a.md" },
      { title: "b.md", href: "https://x.test/b" },
      { title: "c.md" },
      { title: "d.md" },
    ]
    const root = html(mount(SourceChipsComponent, { sources, limit: 3 }))
    const list = root.querySelector("ul.b4-step__sources")
    expect(list?.getAttribute("aria-label")).toBe("Sources")
    const link = root.querySelector("a.b4-chip")
    expect(link?.getAttribute("href")).toBe("https://x.test/b")
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toBe("noreferrer")
    expect(root.querySelector("span.b4-chip")?.textContent).toBe("a.md")
    expect(root.querySelector("li.b4-chip.b4-chip--more")?.textContent).toBe("+1")
    expect(root.textContent).not.toContain("d.md")
  })

  test("renders nothing for no sources", () => {
    expect(html(mount(SourceChipsComponent, { sources: [] })).innerHTML).not.toContain("<ul")
  })

  test("only web, mail and same-origin hrefs become links; anything else is a plain chip", () => {
    const root = html(
      mount(SourceChipsComponent, {
        sources: [
          { title: "evil", href: "javascript:alert(1)" },
          { title: "data", href: "data:text/html,hi" },
          { title: "mail", href: "mailto:a@b.test" },
          { title: "local", href: "/files/a.md" },
        ],
        limit: 4,
      }),
    )
    expect(root.innerHTML).not.toContain("javascript:")
    expect(root.innerHTML).not.toContain("data:")
    const hrefs = Array.from(root.querySelectorAll("a"), (a) => a.getAttribute("href"))
    expect(hrefs).toEqual(["mailto:a@b.test", "/files/a.md"])
  })
})

describe("b4-step-detail", () => {
  test("a flat input reads as rows and a text result as plain text; Show raw opens the rows' original", () => {
    const fixture = mount(StepDetailComponent, { args: '{"query":"a"}', result: "3 hits" })
    const root = html(fixture)
    const rows = Array.from(
      root.querySelectorAll("dl.b4-step__fields > div.b4-step__field"),
      (row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent],
    )
    expect(rows).toEqual([["query", "a"]])
    expect(root.querySelector("p.b4-step__value")?.textContent).toBe("3 hits")
    expect(
      Array.from(root.querySelectorAll("h4.b4-step__detail-label"), (h) => h.textContent),
    ).toEqual(["Result"])
    const toggle = root.querySelector("button.b4-step__raw")
    expect(toggle?.getAttribute("aria-expanded")).toBe("false")
    click(fixture, toggle)
    expect(toggle?.textContent).toBe("Hide raw")
    expect(Array.from(root.querySelectorAll("pre.b4-step__code"), (p) => p.textContent)).toEqual([
      '{\n  "query": "a"\n}',
    ])
  })

  test("a list of objects renders one group of rows per object", () => {
    const root = html(
      mount(StepDetailComponent, { args: "", result: '[{"id":"KSTP"},{"id":"KRST"}]' }),
    )
    const groups = Array.from(
      root.querySelectorAll("ol.b4-step__records > li > dl.b4-step__fields"),
      (dl) => Array.from(dl.querySelectorAll("dd"), (dd) => dd.textContent),
    )
    expect(groups).toEqual([["KSTP"], ["KRST"]])
  })

  test("deep JSON stays pretty JSON with no raw toggle", () => {
    const root = html(mount(StepDetailComponent, { args: '{"a":{"b":{"c":1}}}', result: '"ok"' }))
    expect(Array.from(root.querySelectorAll("pre.b4-step__code"), (p) => p.textContent)).toEqual([
      '{\n  "a": {\n    "b": {\n      "c": 1\n    }\n  }\n}',
    ])
    expect(root.querySelector("p.b4-step__value")?.textContent).toBe("ok")
    expect(root.querySelector("button.b4-step__raw")).toBeNull()
  })

  test("an empty detail says so", () => {
    const root = html(mount(StepDetailComponent, { args: "" }))
    const detail = root.querySelector(":scope > div.b4-step__detail")
    expect(detail?.children).toHaveLength(1)
    expect(detail?.querySelector(":scope > p.b4-step__detail-empty")?.textContent).toBe(
      "No details yet.",
    )
  })

  test("caps each value at 20 000 characters with a truncated line", () => {
    const long = "x".repeat(MAX_DETAIL_CHARS + 5)
    const root = html(mount(StepDetailComponent, { args: long, result: `${long}END` }))
    expect(root.textContent).not.toContain("END")
    expect(root.textContent?.match(/… \(truncated\)/g)).toHaveLength(2)
  })
})

describe("b4-step-icon", () => {
  test("renders an aria-hidden 16px SVG for every ToolDisplayIcon name and the extras", () => {
    for (const name of [...TOOL_DISPLAY_ICONS, "alert", "check"]) {
      const svg = html(mount(StepIconComponent, { name })).querySelector("svg")
      expect(svg?.getAttribute("class")).toBe("b4-step__icon")
      expect(svg?.getAttribute("aria-hidden")).toBe("true")
      expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16")
      expect(svg?.innerHTML).toContain('stroke="currentColor"')
    }
  })

  test("an unknown name falls back to the generic tool glyph, including Object.prototype keys", () => {
    const glyph = (name: string | undefined) =>
      html(mount(StepIconComponent, { name })).querySelector("svg")?.innerHTML
    const generic = glyph("tool")
    for (const name of ["nope", "constructor", "toString", undefined]) {
      expect(glyph(name)).toBe(generic)
    }
  })

  test("a new name redraws the glyph in place", () => {
    const fixture = mount(StepIconComponent, { name: "search" })
    const before = html(fixture).querySelector("svg")?.innerHTML
    update(fixture, { name: "alert" })
    const after = html(fixture).querySelector("svg")?.innerHTML
    expect(after).not.toBe(before)
    expect(after).toBe(
      html(mount(StepIconComponent, { name: "alert" })).querySelector("svg")?.innerHTML,
    )
  })
})

@Component({
  imports: [DisclosureComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<b4-disclosure className="x" [open]="open()" (toggle)="toggles = toggles + 1"><ng-container ngProjectAs="b4-summary"><span>sum</span></ng-container><p>panel</p></b4-disclosure><b4-disclosure className="y" panelClassName="b4-step__detail" [open]="true" (toggle)="toggles = toggles + 1"><ng-container ngProjectAs="b4-summary"><span>two</span></ng-container><p>second</p></b4-disclosure>`,
})
class DisclosureHost {
  readonly open = signal(false)
  toggles = 0
}

describe("b4-disclosure", () => {
  test("renders a controlled button with aria-expanded and the panel only while open", () => {
    const fixture = mount(DisclosureHost, {})
    const root = html(fixture)
    const button = root.querySelector("button.x") as HTMLButtonElement
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(button.querySelector(":scope > svg.b4-chevron")).not.toBeNull()
    expect(button.textContent).toBe("sum")
    expect(root.textContent).not.toContain("panel")
    click(fixture, button)
    expect(fixture.componentInstance.toggles).toBe(1)
    expect(button.getAttribute("aria-expanded")).toBe("false") // controlled
    fixture.componentInstance.open.set(true)
    fixture.detectChanges()
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(root.textContent).toContain("panel")
    expect(root.querySelector("div.b4-step__detail > p")?.textContent).toBe("second")
  })
})

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" [attr.aria-expanded]="state.open()" (click)="state.toggle()">t</button>`,
})
class DisclosureProbe {
  readonly autoOpen = signal(true)
  readonly live = signal(true)
  readonly key = signal<unknown>(undefined)
  readonly state = disclosure(this.autoOpen, this.live, this.key)
}

describe("disclosure()", () => {
  /** A probe whose first render (the rule's first observation) sees these values. */
  function probe(autoOpen: boolean, live: boolean, key?: unknown) {
    const fixture = TestBed.createComponent(DisclosureProbe)
    const set = (a: boolean, l: boolean, k?: unknown) => {
      fixture.componentInstance.autoOpen.set(a)
      fixture.componentInstance.live.set(l)
      fixture.componentInstance.key.set(k)
      fixture.detectChanges()
    }
    set(autoOpen, live, key)
    const expanded = () => html(fixture).querySelector("button")?.getAttribute("aria-expanded")
    const toggle = () => click(fixture, html(fixture).querySelector("button"))
    return { set, expanded, toggle }
  }

  test("automation decides until the user toggles; without a key the choice clears when the item becomes live again", () => {
    const p = probe(true, true)
    expect(p.expanded()).toBe("true")
    p.toggle()
    expect(p.expanded()).toBe("false")
    p.set(false, false)
    expect(p.expanded()).toBe("false")
    p.set(true, true)
    expect(p.expanded()).toBe("true")
  })

  test("mounting live does not clear a choice made after mount", () => {
    const p = probe(false, true, 100)
    p.toggle()
    expect(p.expanded()).toBe("true")
    p.set(false, true, 100)
    expect(p.expanded()).toBe("true")
  })

  test("with a key, live rising under the same key keeps the user's choice; a new key hands back to automation", () => {
    const p = probe(false, false, 100)
    p.toggle()
    expect(p.expanded()).toBe("true")
    p.set(false, true, 100) // awaiting → running, same call
    expect(p.expanded()).toBe("true")
    p.set(false, true, 200) // restarted call
    expect(p.expanded()).toBe("false")
    p.toggle()
    p.set(false, false, 300) // key changes while settled: nothing yet
    expect(p.expanded()).toBe("true")
    p.set(false, true, 300) // …until it is live under the new key
    expect(p.expanded()).toBe("false")
  })
})

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<output>{{ live() }}:{{ elapsed() }}</output>`,
})
class ClockProbe {
  readonly step = signal({ status: "running", startedAt: 1000 })
  readonly now = signal<() => number>(() => 1000)
  readonly live = liveSignal(this.step, () => this.now()())
  readonly elapsed = elapsedSignal(
    () => this.step().status === "running",
    () => this.now()(),
  )
}

describe("liveSignal / elapsedSignal", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function clock(step: { status: string; startedAt: number }, now: () => number) {
    const fixture = TestBed.createComponent(ClockProbe)
    fixture.componentInstance.step.set(step)
    fixture.componentInstance.now.set(now)
    fixture.detectChanges()
    const text = () => html(fixture).querySelector("output")?.textContent
    const tick = (ms: number) => {
      vi.advanceTimersByTime(ms)
      fixture.detectChanges()
    }
    return { fixture, text, tick }
  }

  test("a running step is not live for its first 300 ms, then is", () => {
    let time = 1000
    const c = clock({ status: "running", startedAt: 1000 }, () => time)
    expect(c.text()).toBe("false:1000")
    time = 1400
    c.tick(300)
    expect(c.text()?.startsWith("true:")).toBe(true)
  })

  test("a step that starts old is live immediately; done is never live", () => {
    expect(clock({ status: "running", startedAt: 0 }, () => 5000).text()).toBe("true:5000")
    expect(clock({ status: "done", startedAt: 0 }, () => 5000).text()).toBe("false:5000")
  })

  test("elapsed re-samples the clock every second while active", () => {
    let time = 0
    const c = clock({ status: "running", startedAt: 0 }, () => time)
    time = 2500
    c.tick(1000)
    expect(c.text()?.endsWith(":2500")).toBe(true)
  })

  test("a new now identity neither recreates the interval nor re-arms the no-flash timer", () => {
    let time = 1000
    const c = clock({ status: "running", startedAt: 1000 }, () => time)
    const setInterval = vi.spyOn(globalThis, "setInterval")
    const setTimeout = vi.spyOn(globalThis, "setTimeout")
    c.fixture.componentInstance.now.set(() => time)
    c.fixture.detectChanges()
    c.fixture.componentInstance.now.set(() => time)
    c.fixture.detectChanges()
    expect(setInterval).not.toHaveBeenCalled()
    expect(setTimeout.mock.calls.filter(([, ms]) => ms === 300)).toHaveLength(0)
    time = 3000
    c.tick(1000)
    expect(c.text()).toBe("true:3000") // the interval reads the latest clock
  })
})

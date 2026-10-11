import type { ReactNode } from "react"
import styles from "./diagrams.module.css"

/**
 * The navlog announcement's architecture diagrams, as inline SVG so they take
 * the site's tokens and fonts. Every coordinate sits on an 8px grid inside a
 * 664-unit-wide viewBox, the reading column's width, so a diagram renders at
 * 1:1 on a desktop: boxes are 40, 56, 64 or 80 tall, gutters are 16, and a
 * box's text starts 16 in from its left edge.
 *
 * Boxes say what a part is: app code (paper), a B4.run package (relay tint
 * with a relay bar), an open-source library (sunk), an external service
 * (dashed), or a person's approval (warn).
 */

type Kind = "app" | "b4" | "lib" | "ext" | "gate"

interface BoxProps {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly kind: Kind
  readonly title: string
  readonly lines?: readonly string[]
  /** Monospace title, for identifiers. */
  readonly mono?: boolean
}

/** A box: the title's baseline 24 below the top, each line 16 more after a 20 gap. */
function Box({ x, y, w, h, kind, title, lines = [], mono = false }: BoxProps) {
  const titleY = lines.length === 0 ? y + h / 2 + 5 : y + 24
  return (
    <g>
      {/* Half-pixel inset so a 1px stroke lands on whole pixels. */}
      <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} className={styles[kind]} />
      {kind === "b4" ? <rect x={x} y={y} width={4} height={h} className={styles.accent} /> : null}
      <text x={x + 16} y={titleY} className={mono ? styles.code : styles.title}>
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={x + 16} y={y + 44 + i * 16} className={styles.line}>
          {line}
        </text>
      ))}
    </g>
  )
}

/** A zone: one tier of the system, labelled top left with the relay dot. */
function Zone({
  x,
  y,
  w,
  h,
  label,
}: {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly label: string
}) {
  return (
    <g>
      <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} className={styles.zone} />
      <rect x={x + 16} y={y + 16} width={8} height={8} className={styles.zoneDot} />
      <text x={x + 32} y={y + 24} className={styles.zoneLabel}>
        {label}
      </text>
    </g>
  )
}

/** One full-width strip inside a zone: a rule every part of the tier shares. */
function Strip({
  x,
  y,
  w,
  kind,
  text,
}: {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly kind: Kind
  readonly text: string
}) {
  return (
    <g>
      <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={23} className={styles[kind]} />
      {kind === "b4" ? <rect x={x} y={y} width={4} height={24} className={styles.accent} /> : null}
      <text
        x={x + 16}
        y={y + 16}
        className={kind === "gate" ? styles.warnText : kind === "b4" ? styles.note : styles.line}
      >
        {text}
      </text>
    </g>
  )
}

/** The arrowhead marker; ids are per diagram so several diagrams share a page. */
function Head({ id }: { readonly id: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 8 8"
      refX={7}
      refY={4}
      markerWidth={8}
      markerHeight={8}
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      <path d="M0 0 L8 4 L0 8 Z" className={styles.head} />
    </marker>
  )
}

function Arrow({
  d,
  head,
  both = false,
  dashed = false,
}: {
  readonly d: string
  readonly head: string
  readonly both?: boolean
  readonly dashed?: boolean
}) {
  return (
    <path
      d={d}
      className={dashed ? styles.arrowDashed : styles.arrow}
      markerEnd={`url(#${head})`}
      {...(both ? { markerStart: `url(#${head})` } : {})}
    />
  )
}

/** A label on an arrow, on a surface-coloured plate so the line never runs through it. */
function ArrowLabel({
  x,
  y,
  text,
}: {
  readonly x: number
  readonly y: number
  readonly text: string
}) {
  // JetBrains Mono at 11px advances 6.6px a character.
  const width = Math.ceil(text.length * 6.6) + 8
  return (
    <g>
      <rect x={x - 4} y={y - 12} width={width} height={16} className={styles.arrowLabelBg} />
      <text x={x} y={y} className={styles.arrowLabel}>
        {text}
      </text>
    </g>
  )
}

const LEGEND: readonly { readonly kind: Kind; readonly label: string }[] = [
  { kind: "app", label: "navlog's code" },
  { kind: "b4", label: "B4.run" },
  { kind: "lib", label: "open-source library" },
  { kind: "ext", label: "external service" },
]

function Legend({ y, kinds }: { readonly y: number; readonly kinds: readonly Kind[] }) {
  const items = LEGEND.filter((item) => kinds.includes(item.kind))
  return (
    <g>
      {items.map((item, i) => {
        const x = 16 + i * 160
        return (
          <g key={item.kind}>
            <rect x={x + 0.5} y={y + 0.5} width={15} height={15} className={styles[item.kind]} />
            {item.kind === "b4" ? (
              <rect x={x} y={y} width={4} height={16} className={styles.accent} />
            ) : null}
            <text x={x + 24} y={y + 12} className={styles.legendText}>
              {item.label}
            </text>
          </g>
        )
      })}
    </g>
  )
}

function Figure({
  id,
  height,
  title,
  desc,
  caption,
  children,
}: {
  readonly id: string
  readonly height: number
  readonly title: string
  readonly desc: string
  readonly caption: ReactNode
  readonly children: ReactNode
}) {
  return (
    <figure className={styles.figure}>
      <div className={styles.scroll}>
        <svg
          viewBox={`0 0 664 ${height}`}
          className={styles.svg}
          role="img"
          aria-labelledby={`${id}-title ${id}-desc`}
        >
          <title id={`${id}-title`}>{title}</title>
          <desc id={`${id}-desc`}>{desc}</desc>
          <defs>
            <Head id={`${id}-head`} />
          </defs>
          {children}
        </svg>
      </div>
      <figcaption className={styles.caption}>{caption}</figcaption>
    </figure>
  )
}

// Four columns inside a 632-wide zone: 138 wide with 16 gutters, from x = 32.
const COL = [32, 186, 340, 494] as const
const COL_W = 138
const SPAN2_W = 292

/** The whole system: browser, route handlers, the B4.run server and what it calls. */
export function NavlogStackDiagram() {
  const head = "nl-stack-head"
  return (
    <Figure
      id="nl-stack"
      height={984}
      title="Navlog architecture"
      desc="Three tiers. The browser runs the workbench: a CopilotKit chat, a hashbrown brief, a Leaflet map and a pretable navlog sheet, all reading one run through the B4Activity context. Route handlers forward chat runs to the B4.run server over AG-UI. The server on Railway runs the navlog coordinator route, its weather and performance subagents, twelve tools and pure TypeScript math, on the B4.run runtime. It calls OpenAI, aviationweather.gov and Postgres with pgvector."
      caption={
        <>
          <strong>The stack.</strong> The browser never talks to the B4.run server or OpenAI
          directly. Chat runs go through the CopilotKit route, which adds the brief's response
          schema on the way.
        </>
      }
    >
      {/* Tier 1: the browser. */}
      <Zone x={16} y={16} w={632} h={176} label="Browser · Vercel" />
      <Strip
        x={32}
        y={56}
        w={600}
        kind="b4"
        text="one run, four views · useB4ActivityContext() → pure selectors"
      />
      <Box
        x={COL[0]}
        y={96}
        w={COL_W}
        h={80}
        kind="lib"
        title="Chat"
        lines={["CopilotKit v2", "B4Activity steps"]}
      />
      <Box
        x={COL[1]}
        y={96}
        w={COL_W}
        h={80}
        kind="lib"
        title="Brief"
        lines={["hashbrown", "structured UI"]}
      />
      <Box
        x={COL[2]}
        y={96}
        w={COL_W}
        h={80}
        kind="lib"
        title="Map"
        lines={["Leaflet · OSM", "route bar search"]}
      />
      <Box
        x={COL[3]}
        y={96}
        w={COL_W}
        h={80}
        kind="lib"
        title="Navlog sheet"
        lines={["pretable grid", "Legs · Weather"]}
      />

      {/* Chat → the CopilotKit route, entering right of the zone label. */}
      <Arrow d="M101 176 V216 H272 V288" head={head} />
      <ArrowLabel x={116} y={236} text="AG-UI events, streamed" />
      <Arrow d="M409 176 V288" head={head} />

      {/* Tier 2: same-origin route handlers. */}
      <Zone x={16} y={248} w={632} h={136} label="Route handlers" />
      <Box
        x={COL[0]}
        y={288}
        w={SPAN2_W}
        h={80}
        kind="app"
        title="/api/copilotkit"
        lines={["CopilotRuntime + B4HttpAgent", "responseSchema = the brief kit"]}
      />
      <Box
        x={COL[2]}
        y={288}
        w={COL_W}
        h={80}
        kind="app"
        title="/api/waypoints"
        lines={["OurAirports", "snapshot search"]}
      />
      <Box
        x={COL[3]}
        y={288}
        w={COL_W}
        h={80}
        kind="app"
        title="/api/b4/*"
        lines={["memory review", "candidates"]}
      />

      {/* Route handlers → the server. */}
      <Arrow d="M272 368 V480" head={head} />
      <ArrowLabel x={284} y={416} text="POST /agui/%2Fnavlog%23agent" />
      <Arrow d="M563 368 V480" head={head} />
      <ArrowLabel x={575} y={416} text="memory" />

      {/* Tier 3: the B4.run server. */}
      <Zone x={16} y={440} w={632} h={344} label="B4.run server · Railway" />
      <Box
        x={COL[0]}
        y={480}
        w={SPAN2_W}
        h={80}
        kind="app"
        title="/navlog coordinator route"
        lines={['agent({ model: "gpt-5-mini" })', "plan.md · memory.ts · skills/"]}
      />
      <Box
        x={COL[2]}
        y={480}
        w={SPAN2_W}
        h={80}
        kind="app"
        title="src/tools · 12 tools"
        lines={["lookupAirport · getMetar · getTaf …", "computeNavlog · fileFlightPlan"]}
      />
      <Arrow d="M101 560 V592" head={head} />
      <Arrow d="M255 560 V592" head={head} />
      <ArrowLabel x={116} y={580} text="task() ×2" />
      <Arrow d="M486 560 V592" head={head} />
      <ArrowLabel x={498} y={580} text="calls" />
      <Box
        x={COL[0]}
        y={592}
        w={COL_W}
        h={80}
        kind="app"
        title="weather"
        lines={["METAR · TAF", "winds · advisories"]}
      />
      <Box
        x={COL[1]}
        y={592}
        w={COL_W}
        h={80}
        kind="app"
        title="performance"
        lines={["POH tables", "readDoc · cite"]}
      />
      <Box
        x={COL[2]}
        y={592}
        w={SPAN2_W}
        h={80}
        kind="app"
        title="src/lib · pure TypeScript"
        lines={["wind triangle · great circle", "POH interpolation · ICAO FPL"]}
      />
      <Box
        x={COL[0]}
        y={688}
        w={SPAN2_W}
        h={80}
        kind="b4"
        title="B4.run runtime"
        lines={["@b4run/cli · @b4run/langchain", "LangChain createAgent · LangGraph"]}
      />
      <Box
        x={COL[2]}
        y={688}
        w={SPAN2_W}
        h={80}
        kind="app"
        title="workspace/"
        lines={["poh/ · regs/ · aircraft/  read-only", "reports/ · flight-plans/"]}
      />

      {/* What the server calls. */}
      <Arrow d="M101 768 V840" head={head} />
      <Arrow d="M332 784 V840" head={head} />
      <Arrow d="M563 784 V840" head={head} />
      <Box
        x={COL[0]}
        y={840}
        w={COL_W}
        h={80}
        kind="ext"
        title="OpenAI"
        lines={["gpt-5-mini", "key on the server"]}
      />
      <Box
        x={COL[1]}
        y={840}
        w={SPAN2_W}
        h={80}
        kind="ext"
        title="aviationweather.gov"
        lines={["METAR · TAF · FB winds · G-AIRMET", "no key · 5-minute cache"]}
      />
      <Box
        x={COL[3]}
        y={840}
        w={COL_W}
        h={80}
        kind="ext"
        title="Postgres"
        lines={["+ pgvector", "threads · memory"]}
      />

      <Legend y={952} kinds={["app", "b4", "lib", "ext"]} />
    </Figure>
  )
}

// Four lanes, 158 wide from x = 16; a box sits 8 inside its lane.
const LANE = [16, 174, 332, 490] as const
const LX = LANE.map((x) => x + 8)
const LW = 142
const ROW = (n: number): number => 72 + n * 72

/** One planning run, from the pilot's request to the approved filing. */
export function NavlogRunDiagram() {
  const head = "nl-run-head"
  const lanes = ["Pilot · workbench", "Coordinator", "Subagents", "Tools · code"]
  return (
    <Figure
      id="nl-run"
      height={808}
      title="One planning run"
      desc="Four lanes: the pilot, the coordinator agent, the subagents, and the tools. The pilot asks for a plan. The coordinator reads the aircraft baseline and recalls memory, resolves the departure time in code, looks up the route, dispatches the weather and performance subagents in parallel, computes the navlog in code, and answers with a structured brief. When the pilot asks to file, fileFlightPlan interrupts the run for a person's approval before it writes the flight plan."
      caption={
        <>
          <strong>One planning run.</strong> Each arrow is a call, and the result flows back the way
          it came. The model decides what to call next. Every number the pilot reads comes from the
          right-hand lane.
        </>
      }
    >
      {lanes.map((label, i) => (
        <g key={label}>
          <rect x={(LANE[i] ?? 0) + 8} y={24} width={8} height={8} className={styles.zoneDot} />
          <text x={(LANE[i] ?? 0) + 24} y={32} className={styles.zoneLabel}>
            {label}
          </text>
          {i > 0 ? <path d={`M${(LANE[i] ?? 0) + 0.5} 16 V792`} className={styles.leader} /> : null}
        </g>
      ))}

      {/* The request. */}
      <Box
        x={LX[0] ?? 0}
        y={ROW(0)}
        w={LW}
        h={56}
        kind="app"
        title="Plan KSTP KRST"
        lines={["4500 ft · 1400Z"]}
      />
      <Arrow d={`M158 ${ROW(0) + 28} H182`} head={head} />
      <Box
        x={LX[1] ?? 0}
        y={ROW(0)}
        w={LW}
        h={56}
        kind="app"
        title="/navlog"
        lines={["plan.md → todos"]}
      />

      {/* Baseline and memory. */}
      <Box
        x={LX[1] ?? 0}
        y={ROW(1)}
        w={LW}
        h={56}
        kind="app"
        title="Who's flying?"
        lines={["baseline + recall"]}
      />
      <Arrow d={`M324 ${ROW(1) + 28} H498`} head={head} />
      <Box
        x={LX[3] ?? 0}
        y={ROW(1)}
        w={LW}
        h={56}
        kind="app"
        title="readDoc · recall"
        lines={["aircraft/c172n.md"]}
      />

      {/* Pin the time. */}
      <Box
        x={LX[1] ?? 0}
        y={ROW(2)}
        w={LW}
        h={56}
        kind="app"
        title="When?"
        lines={['"tomorrow 1400Z"']}
      />
      <Arrow d={`M324 ${ROW(2) + 28} H498`} head={head} />
      <Box
        x={LX[3] ?? 0}
        y={ROW(2)}
        w={LW}
        h={56}
        kind="app"
        title="resolveDeparture"
        lines={["→ ISO instant"]}
      />

      {/* The route. */}
      <Box
        x={LX[1] ?? 0}
        y={ROW(3)}
        w={LW}
        h={56}
        kind="app"
        title="Where?"
        lines={["airports · navaids"]}
      />
      <Arrow d={`M324 ${ROW(3) + 28} H498`} head={head} />
      <Box
        x={LX[3] ?? 0}
        y={ROW(3)}
        w={LW}
        h={56}
        kind="app"
        title="lookupAirport …"
        lines={["findRouteStations"]}
      />

      {/* Fan out. */}
      <Box
        x={LX[1] ?? 0}
        y={ROW(4)}
        w={LW}
        h={56}
        kind="app"
        title="Dispatch"
        lines={["task() × 2"]}
      />
      <Arrow d={`M324 ${ROW(4) + 28} H340`} head={head} />
      <Arrow d={`M324 ${ROW(4) + 44} H332 V${ROW(5) + 28} H340`} head={head} />
      <Box
        x={LX[2] ?? 0}
        y={ROW(4)}
        w={LW}
        h={56}
        kind="app"
        title="weather"
        lines={["→ verdict + brief"]}
      />
      <Box
        x={LX[2] ?? 0}
        y={ROW(5)}
        w={LW}
        h={56}
        kind="app"
        title="performance"
        lines={["→ POH figures"]}
      />
      <Arrow d={`M482 ${ROW(4) + 28} H498`} head={head} />
      <Arrow d={`M482 ${ROW(5) + 28} H498`} head={head} />
      <Box
        x={LX[3] ?? 0}
        y={ROW(4)}
        w={LW}
        h={56}
        kind="app"
        title="getMetar · getTaf"
        lines={["winds · advisories"]}
      />
      <Box
        x={LX[3] ?? 0}
        y={ROW(5)}
        w={LW}
        h={56}
        kind="app"
        title="readDoc"
        lines={["poh/*.md tables"]}
      />

      {/* Back to the coordinator, then the math. */}
      <Arrow d={`M403 ${ROW(5) + 56} V${ROW(6) + 16} H324`} head={head} />
      <Box
        x={LX[1] ?? 0}
        y={ROW(6)}
        w={LW}
        h={56}
        kind="app"
        title="Do the math"
        lines={["one wind per leg"]}
      />
      <Arrow d={`M324 ${ROW(6) + 40} H498`} head={head} />
      <Box
        x={LX[3] ?? 0}
        y={ROW(6)}
        w={LW}
        h={56}
        kind="app"
        title="computeNavlog"
        lines={["wind △ · POH · FPL"]}
      />

      {/* The answer. */}
      <Box
        x={LX[1] ?? 0}
        y={ROW(7)}
        w={LW}
        h={56}
        kind="app"
        title="Answer"
        lines={["brief kit JSON"]}
      />
      <Arrow d={`M182 ${ROW(7) + 28} H158`} head={head} />
      <Box
        x={LX[0] ?? 0}
        y={ROW(7)}
        w={LW}
        h={56}
        kind="app"
        title="Brief · map · sheet"
        lines={["GO · KeyNumbers"]}
      />

      {/* Filing, behind a person. */}
      <Box
        x={LX[0] ?? 0}
        y={ROW(8)}
        w={LW}
        h={56}
        kind="app"
        title={"“File it.”"}
        lines={["a new turn"]}
      />
      <Arrow d={`M158 ${ROW(8) + 28} H182`} head={head} />
      <Box
        x={LX[1] ?? 0}
        y={ROW(8)}
        w={LW}
        h={56}
        kind="app"
        title="fileFlightPlan"
        lines={["the latest navlog"]}
      />
      <Arrow d={`M324 ${ROW(8) + 28} H498`} head={head} />
      <Box
        x={LX[3] ?? 0}
        y={ROW(8)}
        w={LW}
        h={56}
        kind="gate"
        title="Interrupt"
        lines={["waits for a person"]}
      />
      <Arrow d={`M498 ${ROW(8) + 44} H412 V${ROW(9) + 28} H158`} head={head} dashed />
      <Box
        x={LX[0] ?? 0}
        y={ROW(9)}
        w={LW}
        h={56}
        kind="gate"
        title="Approve once"
        lines={["or deny"]}
      />
      <Arrow d={`M158 ${ROW(9) + 40} H498`} head={head} />
      <Box
        x={LX[3] ?? 0}
        y={ROW(9)}
        w={LW}
        h={56}
        kind="app"
        title="Write the FPL"
        lines={["flight-plans/*.txt"]}
      />
    </Figure>
  )
}

interface FileRow {
  readonly path: string
  readonly depth: number
  readonly kind?: Kind
  readonly becomes?: string
}

const FILES: readonly FileRow[] = [
  { path: "server/", depth: 0 },
  {
    path: "b4.config.ts",
    depth: 1,
    kind: "b4",
    becomes: "config: stores, memory, read-only corpus",
  },
  { path: "src/", depth: 1 },
  { path: "app/navlog/", depth: 2, kind: "b4", becomes: "the /navlog route" },
  { path: "index.ts", depth: 3, kind: "b4", becomes: "the agent: model, prompt, tool rules" },
  { path: "plan.md", depth: 3, kind: "b4", becomes: "planning: the seeded todos" },
  { path: "memory.ts", depth: 3, kind: "b4", becomes: "typed remember() and recall() tools" },
  { path: "skills/*/SKILL.md", depth: 3, kind: "b4", becomes: "skills the agent can load" },
  { path: "subagents/weather/", depth: 3, kind: "b4", becomes: "a subagent, reached with task()" },
  {
    path: "subagents/performance/",
    depth: 3,
    kind: "b4",
    becomes: "a subagent, reached with task()",
  },
  { path: "evals/", depth: 3, kind: "b4", becomes: "b4 eval: scripted and live runs" },
  { path: "tools/*.ts", depth: 2, kind: "b4", becomes: "one tool per file, typed from its input" },
  { path: "lib/*.ts", depth: 2, kind: "app", becomes: "plain TypeScript the tools call" },
  { path: "workspace/", depth: 1, kind: "b4", becomes: "files the agent reads and writes" },
  { path: "AGENTS.md", depth: 2, kind: "b4", becomes: "guidance injected into the prompt" },
]

/** The server's tree, and what B4.run makes of each file. */
export function NavlogFilesDiagram() {
  const top = 56
  const pitch = 32
  const height = top + FILES.length * pitch + 56
  return (
    <Figure
      id="nl-files"
      height={height}
      title="The navlog server's files"
      desc="The navlog server's file tree beside what B4.run makes of each file: b4.config.ts is the app's configuration; src/app/navlog is the route, with index.ts as the agent, plan.md as its todos, memory.ts as typed memory tools, skills, two subagents and evals; each file in src/tools is a tool; src/lib is plain TypeScript; workspace is the agent's files, with AGENTS.md injected into the prompt."
      caption={
        <>
          <strong>The filesystem is the app.</strong> Highlighted rows are B4.run conventions: put a
          file there and the framework wires it up. <code>src/lib</code> is just TypeScript, and
          that's on purpose.
        </>
      }
    >
      <rect x={16} y={24} width={8} height={8} className={styles.zoneDot} />
      <text x={32} y={32} className={styles.zoneLabel}>
        File
      </text>
      <rect x={368} y={24} width={8} height={8} className={styles.zoneDot} />
      <text x={384} y={32} className={styles.zoneLabel}>
        What B4.run makes of it
      </text>
      {FILES.map((row, i) => {
        const y = top + i * pitch
        const x = 32 + row.depth * 16
        // JetBrains Mono at 12px advances 7.2px a character.
        const textEnd = x + Math.ceil(row.path.length * 7.2)
        return (
          <g key={row.path}>
            <text x={x} y={y + 20} className={styles.code}>
              {row.path}
            </text>
            {row.becomes !== undefined && row.kind !== undefined ? (
              <>
                <path d={`M${textEnd + 8} ${y + 16.5} H${360}`} className={styles.leader} />
                <rect x={368.5} y={y + 4.5} width={279} height={23} className={styles[row.kind]} />
                {row.kind === "b4" ? (
                  <rect x={368} y={y + 4} width={4} height={24} className={styles.accent} />
                ) : null}
                <text x={384} y={y + 20} className={styles.label}>
                  {row.becomes}
                </text>
              </>
            ) : null}
          </g>
        )
      })}
      <Legend y={height - 32} kinds={["b4", "app"]} />
    </Figure>
  )
}

const SELECTORS: readonly {
  readonly name: string
  readonly reads: string
  readonly view: string
}[] = [
  { name: "latestNavlogResult", reads: "computeNavlog's result", view: "Map + Legs" },
  { name: "latestWeatherBriefText", reads: "the weather subagent", view: "Weather tab" },
  { name: "latestRouteStations", reads: "findRouteStations", view: "Station pins" },
  { name: "navlogAnswerText", reads: "that turn's answer", view: "Brief tab" },
]

/** How one AG-UI stream becomes the chat, the map, the sheet and the brief. */
export function NavlogViewsDiagram() {
  const head = "nl-views-head"
  const rowY = (i: number): number => 56 + i * 72
  return (
    <Figure
      id="nl-views"
      height={400}
      title="From events to instruments"
      desc="AG-UI events stream into the B4Activity kit, which reduces them into turns, steps and nested subagent turns. Four pure selectors read the turns: latestNavlogResult feeds the map and the legs, latestWeatherBriefText the weather tab, latestRouteStations the station pins, and navlogAnswerText the brief tab. Each parse is memoized on the result text."
      caption={
        <>
          <strong>One stream, many instruments.</strong> Nothing on the map or the sheet asks the
          server for data. It's all read out of the same run the chat is rendering.
        </>
      }
    >
      {["AG-UI events", "B4Activity", "Pure selectors", "Views"].map((label, i) => {
        const x = [16, 176, 312, 528][i] ?? 0
        return (
          <g key={label}>
            <rect x={x} y={24} width={8} height={8} className={styles.zoneDot} />
            <text x={x + 16} y={32} className={styles.zoneLabel}>
              {label}
            </text>
          </g>
        )
      })}
      <Box
        x={16}
        y={56}
        w={144}
        h={272}
        kind="lib"
        title="@ag-ui/client"
        lines={["RUN_STARTED", "TEXT_MESSAGE_*", "TOOL_CALL_*", "CUSTOM b4.step", "RUN_FINISHED"]}
      />
      <Arrow d="M160 192 H176" head={head} />
      <Box
        x={176}
        y={56}
        w={120}
        h={272}
        kind="b4"
        title="reduceTurns()"
        lines={["turns[]", "└ steps[]", "  └ subagent", "", "useB4Activity", "Context()"]}
      />
      {SELECTORS.map((selector, i) => (
        <g key={selector.name}>
          <Arrow d={`M296 ${rowY(i) + 28} H312`} head={head} />
          <Box
            x={312}
            y={rowY(i)}
            w={200}
            h={56}
            kind="app"
            mono
            title={selector.name}
            lines={[selector.reads]}
          />
          <Arrow d={`M512 ${rowY(i) + 28} H528`} head={head} />
          <Box x={528} y={rowY(i)} w={120} h={56} kind="app" title={selector.view} />
        </g>
      ))}
      <Strip
        x={16}
        y={352}
        w={632}
        kind="b4"
        text="memoized on the result's text → one Navlog object per computation, not per token"
      />
    </Figure>
  )
}

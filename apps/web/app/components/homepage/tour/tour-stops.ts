/**
 * The folder tour's seven stops: the hello agent `npm create b4-app` scaffolds,
 * plus four files you can add to it. Each panel shows a real file (`origin`);
 * tour-stops.test.ts pins the text and checks every docs anchor.
 */
export type TourStopId = "index" | "greet" | "plan" | "memory" | "skill" | "subagent" | "eval"

export interface TourStop {
  readonly id: TourStopId
  /** Path under TOUR_ROOT, as the tree shows it. */
  readonly file: string
  /** Whether the scaffold creates the file or you add it. */
  readonly state: "scaffolded" | "added"
  readonly title: string
  /** Two sentences. */
  readonly copy: string
  /** A docs page and one of its heading anchors. */
  readonly docsHref: string
  readonly docsLabel: string
  readonly language: "typescript" | "markdown"
  /** The file the panel shows, relative to the repository root. */
  readonly origin: string
}

/** What the client island needs to draw the tree and the chip bar. */
export type TourTab = Pick<TourStop, "id" | "file" | "state">

export const TOUR_ROOT = "src/app/hello/"
const TEMPLATE = "packages/devkit/templates/app-basic/src/app/hello/"
const FIXTURES = "apps/web/app/components/homepage/tour/fixtures/hello/"

export const tourStops: readonly TourStop[] = [
  {
    id: "index",
    file: "index.ts",
    state: "scaffolded",
    title: "One export is the agent.",
    copy: "index.ts picks the model and writes the system prompt. Every TypeScript file in tools/ becomes one of its tools.",
    docsHref: "/docs/agents#a-minimal-agent",
    docsLabel: "Agents",
    language: "typescript",
    origin: `${TEMPLATE}index.ts`,
  },
  {
    id: "greet",
    file: "tools/greet.ts",
    state: "scaffolded",
    title: "Your types are the tool schema.",
    copy: "The file name is the tool's name, and the JSDoc above it is the description. B4 reads the input type and writes the JSON schema the model sees.",
    docsHref: "/docs/tools#tool-descriptions",
    docsLabel: "Tool descriptions",
    language: "typescript",
    origin: `${TEMPLATE}tools/greet.ts`,
  },
  {
    id: "plan",
    file: "plan.md",
    state: "added",
    title: "Add plan.md and it plans.",
    copy: "A markdown checklist next to index.ts turns planning on and seeds the todo list. The agent gets a writeTodos tool to keep the list current.",
    docsHref: "/docs/planning#quick-start",
    docsLabel: "Planning",
    language: "markdown",
    origin: `${FIXTURES}plan.md`,
  },
  {
    id: "memory",
    file: "memory.ts",
    state: "added",
    title: "Add memory.ts and it remembers.",
    copy: "defineMemory declares the shape of the records and where they are scoped. The agent gets remember and recall tools typed from your schema.",
    docsHref: "/docs/memory/long-term#generated-recall-and-remember-tools",
    docsLabel: "Long-term memory",
    language: "typescript",
    origin: `${FIXTURES}memory.ts`,
  },
  {
    id: "skill",
    file: "skills/greetings/SKILL.md",
    state: "added",
    title: "Add a skill for long instructions.",
    copy: "The model sees each skill's description, not its body. It loads the full text only when it needs it, with readSkill.",
    docsHref: "/docs/skills#quick-start",
    docsLabel: "Skills",
    language: "markdown",
    origin: `${FIXTURES}skills/greetings/SKILL.md`,
  },
  {
    id: "subagent",
    file: "subagents/translator/index.ts",
    state: "added",
    title: "Add a subagent to hand work off.",
    copy: "A folder under subagents/ is a full agent with its own prompt and tools. The parent gets a task tool and uses each description to decide when to delegate.",
    docsHref: "/docs/subagents#quick-start",
    docsLabel: "Subagents",
    language: "typescript",
    origin: `${FIXTURES}subagents/translator/index.ts`,
  },
  {
    id: "eval",
    file: "evals/smoke.eval.ts",
    state: "scaffolded",
    title: "The scaffold ships an eval.",
    copy: "smoke.eval.ts replays a scripted reply and scores it, so npm run eval needs no API key. Add --live to try the real model.",
    docsHref: "/docs/evals#your-scaffolded-app-already-has-an-eval",
    docsLabel: "Evals",
    language: "typescript",
    // The scaffold drops the .template suffix when it copies the file.
    origin: `${TEMPLATE}evals/smoke.eval.ts.template`,
  },
]

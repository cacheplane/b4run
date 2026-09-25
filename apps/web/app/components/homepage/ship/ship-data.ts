import type { BuildTargetName } from "@b4run/core"
import builds from "./build-outputs.json"
import replay from "./test-replay.json"

/**
 * "Test and ship". Both halves show recordings of real commands, which
 * `scripts/export-homepage-demos.mjs --record-tests --record-builds` makes by
 * scaffolding the basic app and running them; ship.test.ts pins what they
 * claim to the template, the CLI and the docs.
 */
export type ReplayId = "test" | "eval"

export interface ReplayRun {
  readonly id: ReplayId
  readonly command: string
  readonly lines: readonly string[]
}

export const testReplay = replay as {
  readonly app: string
  readonly runs: readonly ReplayRun[]
}

/** The line a run ends on, for the announcement: vitest's test count, or the eval verdict. */
export function replaySummary(run: ReplayRun): string {
  const summary =
    run.id === "test"
      ? [...run.lines].reverse().find((line) => /^\s*Tests\s/.test(line))
      : run.lines.at(-1)
  return (summary ?? "").trim().replace(/\s+/g, " ")
}

/**
 * What the live region says when a run is replayed. The transcript is final
 * the moment the button is pressed; only its lines fade in. Replaying the
 * same run again changes the wording, so the region's text always changes.
 */
export function describeReplay(run: ReplayRun, again: boolean): string {
  return `Replayed ${run.command}${again ? " again" : ""}. ${replaySummary(run)}.`
}

export type BuildId = "default" | BuildTargetName

export interface BuildRecording {
  readonly id: BuildId
  /** The b4.config.ts the build ran with. */
  readonly config: string
  readonly lines: readonly string[]
}

export const buildOutputs = builds as {
  readonly app: string
  readonly command: string
  readonly builds: readonly BuildRecording[]
}

export type TargetId = BuildTargetName | "kubernetes"

export interface DeployTarget {
  readonly id: TargetId
  /** The recorded build this tab shows. Kubernetes runs the node build. */
  readonly build: BuildTargetName
  /** One sentence under the output. */
  readonly summary: string
  /** Commands after `b4 build`, verbatim from the docs page. */
  readonly after: readonly string[]
  readonly docsHref: string
  readonly docsLabel: string
}

export const SHIP_FIXTURES = "apps/web/app/components/homepage/ship/fixtures/targets/"

export const deployTargets: readonly DeployTarget[] = [
  {
    id: "node",
    build: "node",
    summary: "The full B4 HTTP runtime as a Node server, with a Dockerfile.",
    after: [],
    docsHref: "/docs/deployment/node#emitted-files",
    docsLabel: "Node and Docker",
  },
  {
    id: "langsmith",
    build: "langsmith",
    summary: "A langgraph.json and one graph entry per route, for LangSmith to run.",
    after: [],
    docsHref: "/docs/deployment/langsmith#build-output",
    docsLabel: "LangSmith",
  },
  {
    id: "hono",
    build: "hono",
    summary:
      "A Hono app over the web-standard runtime. It serves the edge subset of B4. The app must also depend on @b4run/postgres-storage, @neondatabase/serverless, hono and its model provider, here @langchain/openai.",
    after: [],
    docsHref: "/docs/deployment/edge#emitted-artifacts",
    docsLabel: "Edge and Hono",
  },
  {
    id: "vercel",
    build: "vercel",
    summary:
      "A Build Output API tree with one streaming function. It serves the edge subset of B4. The app must also depend on @b4run/postgres-storage, @neondatabase/serverless, hono and its model provider, here @langchain/openai.",
    after: [],
    docsHref: "/docs/deployment/vercel#emitted-artifacts",
    docsLabel: "Vercel",
  },
  {
    id: "kubernetes",
    build: "node",
    summary:
      "The Node build in an image, pushed to a registry and installed with the b4-app Helm chart.",
    after: [
      "docker build -t ghcr.io/you/my-b4-app:2026-08-10 .",
      "docker push ghcr.io/you/my-b4-app:2026-08-10",
      [
        "helm install b4-app oci://ghcr.io/cacheplane/charts/b4-app \\",
        "  --namespace b4-app \\",
        "  --set image.repository=ghcr.io/you/my-b4-app \\",
        "  --set image.tag=2026-08-10",
      ].join("\n"),
    ],
    docsHref: "/docs/deployment/kubernetes#install-or-upgrade-the-application",
    docsLabel: "Kubernetes",
  },
]

export function buildFor(id: BuildId): BuildRecording {
  const recording = buildOutputs.builds.find((candidate) => candidate.id === id)
  if (!recording) throw new Error(`No recorded build for ${id}`)
  return recording
}

/** The files a build wrote, from its `wrote …` lines. */
export function writtenFiles(recording: BuildRecording): readonly string[] {
  return recording.lines.flatMap((line) => {
    const match = /^\s*wrote (.+)$/.exec(line)
    return match?.[1] ? [match[1]] : []
  })
}

/** What the live region says after the visitor picks a target. */
export function describeTarget(target: DeployTarget): string {
  const files = writtenFiles(buildFor(target.build))
  return `Deploy target ${target.id}. ${target.summary} b4 build writes ${files.join(", ")}.`
}

/** The section's own links, below both halves. */
export const shipLinks = [
  { href: "/docs/testing-agents#your-scaffolded-app-already-has-a-test", label: "Testing agents" },
  { href: "/docs/evals#execution-replay-vs-live", label: "Evals" },
  { href: "/docs/deployment#choose-a-target", label: "Deployment" },
] as const

import "server-only"
import { type BundledLanguage, createHighlighter } from "shiki"
import { COLOR } from "../../../lib/design-tokens"
import { PAPER_RELAY_THEME } from "../../../lib/shiki-theme"
import { curatedEvidenceUrl, evidence, type SourceKey } from "./evidence"
import type { DisplayCode, WalkthroughProps } from "./types"

const highlighter = createHighlighter({
  langs: ["typescript", "markdown", "diff", "json"],
  themes: [PAPER_RELAY_THEME],
})
const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

export async function highlightCode(
  raw: string,
  lang: BundledLanguage,
  path: string,
  url: string,
  firstLine = 1,
): Promise<DisplayCode> {
  const tokens = (await highlighter).codeToTokens(raw.trimEnd(), {
    lang,
    theme: "paper-relay",
  }).tokens
  return {
    raw,
    path,
    url,
    firstLine,
    lines: tokens.map(
      (line) =>
        line
          .map(
            (token) =>
              `<span style="color:${token.color ?? COLOR["panel-ink"]}">${escapeHtml(token.content)}</span>`,
          )
          .join("") || " ",
    ),
  }
}

function recordedDiff(): string {
  const before = evidence.patch.original.trimEnd().split("\n")
  const after = evidence.patch.repaired.trimEnd().split("\n")
  let prefix = 0,
    suffix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++
  const start = Math.max(0, prefix - 2),
    context = Math.min(2, suffix)
  return [
    "--- a/src/cli.ts",
    "+++ b/src/cli.ts",
    `@@ -${start + 1},${before.length - suffix - start + context} +${start + 1},${after.length - suffix - start + context} @@`,
    ...before.slice(start, prefix).map((line) => ` ${line}`),
    ...before.slice(prefix, before.length - suffix).map((line) => `-${line}`),
    ...after.slice(prefix, after.length - suffix).map((line) => `+${line}`),
    ...after
      .slice(after.length - suffix, after.length - suffix + context)
      .map((line) => ` ${line}`),
  ].join("\n")
}

export async function prepareHomepage(): Promise<{ walkthrough: WalkthroughProps }> {
  // The recorded source equals the example at the pinned revision (the exporter
  // and evidence tests enforce it), so each panel links to that revision.
  const prepare = async (key: SourceKey, tab: string) => {
    const source = evidence.sources[key]
    const code = await highlightCode(
      source.text,
      key === "plan" ? "markdown" : "typescript",
      source.path,
      `https://github.com/cacheplane/b4run/blob/${evidence.sourceCommit}/examples/code-fixer/server/${source.path}`,
    )
    // The narrative shows the same paths, so name these regions by their tab.
    return { ...code, label: `Recorded run · ${tab}` }
  }
  const [agent, config, plan, patch] = await Promise.all([
    prepare("agent", "index.ts"),
    prepare("config", "b4.config.ts"),
    prepare("plan", "plan.md"),
    highlightCode(recordedDiff(), "diff", "Recorded patch · src/cli.ts", curatedEvidenceUrl),
  ])
  return {
    walkthrough: {
      files: { agent: { ...agent, fold: { start: 8, end: 21 } }, config, plan },
      patch: { ...patch, linkLabel: "Run data" },
      command: evidence.command,
      failure: evidence.failure,
      visible: evidence.visible,
      independent: evidence.independent,
    },
  }
}

import "server-only"
import { type BundledLanguage, createHighlighter } from "shiki"
import { curatedEvidenceUrl, evidence, type SourceKey } from "./evidence"
import type { DisplayCode, WalkthroughProps } from "./types"

const highlighter = createHighlighter({
  langs: ["typescript", "markdown", "diff", "json"],
  themes: [
    {
      name: "paper-relay",
      type: "dark",
      colors: { "editor.background": "#17181b", "editor.foreground": "#f5f4f0" },
      settings: [
        { scope: ["keyword", "storage"], settings: { foreground: "#c5d985" } },
        { scope: ["string"], settings: { foreground: "#e5cb9b" } },
        { scope: ["comment"], settings: { foreground: "#a3aa99" } },
        { scope: ["markup.inserted"], settings: { foreground: "#c5d985" } },
        { scope: ["markup.deleted"], settings: { foreground: "#f0ae95" } },
      ],
    },
  ],
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
              `<span style="color:${token.color ?? "#f5f4f0"}">${escapeHtml(token.content)}</span>`,
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
  // The recording ran an earlier revision of the example, so these panels show
  // the recorded source without linking to a different revision on GitHub.
  const prepare = (key: SourceKey) => {
    const source = evidence.sources[key]
    return highlightCode(
      source.text,
      key === "plan" ? "markdown" : "typescript",
      `${source.path} · recorded`,
      "",
    )
  }
  const [agent, config, plan, patch] = await Promise.all([
    prepare("agent"),
    prepare("config"),
    prepare("plan"),
    highlightCode(recordedDiff(), "diff", "Recorded patch · src/cli.ts", curatedEvidenceUrl),
  ])
  return {
    walkthrough: {
      files: { agent: { ...agent, fold: { start: 8, end: 19 } }, config, plan },
      patch: { ...patch, linkLabel: "Run data" },
      command: evidence.command,
      failure: evidence.failure,
      visible: evidence.visible,
      independent: evidence.independent,
    },
  }
}

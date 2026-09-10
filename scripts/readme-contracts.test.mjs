import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  assertDisjointPackageTiers,
  resolvePublicPackageTiers,
  validatePackageDiscoveryMetadata,
  validatePackageReadme,
  validateRootReadme,
} from "./lib/readme-contracts.mjs"

const entryManifest = {
  name: "@b4run/sdk",
  private: false,
  description: "Author-facing TypeScript SDK for defining B4.run agents.",
  keywords: ["b4", "typescript", "langgraph"],
}

const entryReadme = `# @b4run/sdk

Author-facing TypeScript SDK.

**Use this when:** You are authoring a B4.run route.

## Install

## Example

## Runtime and stability

## Related

## Maturity and support

## License

![B4.run product loop](https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif)`

const rootReadme = `# B4.run

## Quickstart

\`npm create b4-app@latest my-agent\`

## Why B4.run

## How B4.run fits

[Migrate from LangGraph](/docs/migrating-from-langgraph)

## What B4.run writes for you

## What are you building?

## When B4.run fits

## Build with a coding agent

## Run it live

![B4.run product loop](docs/brand/product-loop.gif)

[Read the demo transcript](docs/brand/demo/transcript.md)

## Maturity and support`

const actualRootReadme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
const actualEntryPackages = [
  {
    directory: "create-b4-app",
    description: "Scaffold a B4.run TypeScript agent application with supported starter templates.",
    keywords: ["b4", "typescript", "langgraph", "ai-agents", "scaffolding", "create-app"],
  },
  {
    directory: "sdk",
    description:
      "Author-facing TypeScript SDK for defining B4.run agents, tools, middleware, memory, and routes.",
    keywords: ["b4", "typescript", "langgraph", "ai-agents", "sdk", "agent-framework"],
  },
  {
    directory: "cli",
    description:
      "Command-line development, testing, build, and runtime tools for B4.run applications.",
    keywords: ["b4", "typescript", "langgraph", "cli", "ai-agents", "developer-tools"],
  },
].map(({ directory, description, keywords }) => {
  const packageRoot = new URL(`../packages/${directory}/`, import.meta.url)
  const actualManifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"))

  return {
    manifest: actualManifest,
    expectedDiscoveryMetadata: { description, keywords },
    readme: readFileSync(new URL("README.md", packageRoot), "utf8"),
  }
})
const actualCapabilityPackages = [
  {
    directory: "ag-ui",
    description: "AG-UI protocol adapters for streaming B4.run agent runs to compatible clients.",
    keywords: ["b4", "typescript", "langgraph", "ag-ui", "ai-agents", "streaming"],
  },
  {
    directory: "evals",
    description: "Evaluation definitions, scorers, datasets, and runners for B4.run agents.",
    keywords: ["b4", "typescript", "ai-agents", "evals", "testing", "llm"],
  },
  {
    directory: "inspector",
    description:
      "Browser inspector for reviewing memory and runtime state in a B4.run application.",
    keywords: ["b4", "typescript", "ai-agents", "inspector", "memory", "developer-tools"],
  },
  {
    directory: "memory",
    description:
      "Long-term memory storage, ranking, recall, and distillation primitives for B4.run agents.",
    keywords: ["b4", "typescript", "ai-agents", "memory", "retrieval", "llm"],
  },
  {
    directory: "memory-pgvector",
    description:
      "Postgres and pgvector storage for shared B4.run agent memory and vector retrieval.",
    keywords: ["b4", "typescript", "ai-agents", "memory", "postgres", "pgvector"],
  },
  {
    directory: "permissions",
    description:
      "Permission matching, approval gates, and access-control stores for B4.run agents.",
    keywords: [
      "b4",
      "typescript",
      "ai-agents",
      "permissions",
      "access-control",
      "human-in-the-loop",
    ],
  },
  {
    directory: "postgres-storage",
    description: "Postgres persistence for B4.run checkpoints, threads, and permission decisions.",
    keywords: ["b4", "typescript", "langgraph", "postgres", "persistence", "ai-agents"],
  },
  {
    directory: "sandbox",
    description: "Docker and Kubernetes sandbox providers for isolated B4.run workspace execution.",
    keywords: ["b4", "typescript", "ai-agents", "sandbox", "docker", "kubernetes"],
  },
  {
    directory: "sqlite-storage",
    description:
      "SQLite persistence for B4.run checkpoints, Agent Protocol threads, and local state.",
    keywords: ["b4", "typescript", "langgraph", "sqlite", "persistence", "ai-agents"],
  },
  {
    directory: "testing",
    description:
      "Deterministic harnesses, fixtures, and matchers for testing B4.run agent applications.",
    keywords: ["b4", "typescript", "ai-agents", "testing", "fixtures", "llm"],
  },
  {
    directory: "workspace",
    description:
      "Filesystem and shell workspace contracts and tools for B4.run agent applications.",
    keywords: ["b4", "typescript", "ai-agents", "filesystem", "shell", "developer-tools"],
  },
].map(({ directory, description, keywords }) => {
  const packageRoot = new URL(`../packages/${directory}/`, import.meta.url)
  const actualManifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"))

  return {
    manifest: actualManifest,
    expectedDiscoveryMetadata: { description, keywords },
    readme: readFileSync(new URL("README.md", packageRoot), "utf8"),
  }
})
const actualToolingPackages = [
  {
    directory: "core",
    description:
      "Low-level B4.run APIs for route discovery, configuration, state resolution, and type generation.",
    keywords: ["b4", "typescript", "langgraph", "ai-agents", "routing", "type-generation"],
  },
  {
    directory: "langchain",
    description:
      "LangChain adapters for B4.run agents, chains, tools, streaming, embeddings, and retry.",
    keywords: ["b4", "typescript", "langchain", "langgraph", "ai-agents", "streaming"],
  },
  {
    directory: "langgraph",
    description:
      "LangGraph.js adapters and route contracts for B4.run agents, workflows, and graphs.",
    keywords: ["b4", "typescript", "langgraph", "langgraphjs", "ai-agents", "workflows"],
  },
  {
    directory: "vite-plugin",
    description: "Vite integration for B4.run route discovery and generated TypeScript types.",
    keywords: ["b4", "typescript", "vite", "langgraph", "type-generation", "developer-tools"],
  },
  {
    directory: "devkit",
    description: "Scaffold templates and development utilities shared by B4.run tooling.",
    keywords: ["b4", "typescript", "scaffolding", "templates", "developer-tools"],
  },
  {
    directory: "config-biome",
    description: "Shared Biome configuration for B4.run TypeScript workspace packages.",
    keywords: ["b4", "biome", "linting", "formatting", "typescript", "configuration"],
  },
  {
    directory: "config-typescript",
    description: "Shared TypeScript compiler configurations for B4.run packages and applications.",
    keywords: ["b4", "typescript", "tsconfig", "configuration", "nodejs", "nextjs"],
  },
].map(({ directory, description, keywords }) => {
  const packageRoot = new URL(`../packages/${directory}/`, import.meta.url)
  const actualManifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"))

  return {
    manifest: actualManifest,
    expectedDiscoveryMetadata: { description, keywords },
    readme: readFileSync(new URL("README.md", packageRoot), "utf8"),
  }
})

const actualPublicPackageManifests = [
  ...actualEntryPackages,
  ...actualCapabilityPackages,
  ...actualToolingPackages,
].map(({ manifest }) => manifest)
const capabilityExampleAnchors = new Map([
  ["@b4run/ag-ui", ["fromRunAgentInput", "toAguiEvents", "@b4run/ag-ui/sse"]],
  ["@b4run/evals", ["contains", "defineEval", "gate", "runEval"]],
  ["@b4run/inspector", ["pnpm exec b4 inspect"]],
  [
    "@b4run/memory",
    [
      "sqliteMemoryStore",
      "@b4run/memory/browse",
      "@b4run/memory/namespace",
      "@b4run/memory/reconcile",
    ],
  ],
  ["@b4run/memory-pgvector", ["pgvectorMemoryStore", "await store.close()"]],
  ["@b4run/permissions", ["matchPermission"]],
  ["@b4run/postgres-storage", ["createPostgresThreadsStore"]],
  ["@b4run/sandbox", ["dockerSandbox", "fakeSandbox"]],
  ["@b4run/sqlite-storage", ["createThreadsStore", "sqliteCheckpointer"]],
  ["@b4run/testing", ["createAgentHarness", "script", "expectFinalMessage"]],
  ["@b4run/workspace", ["compose", "FilesystemBackend", "localFilesystem"]],
])
const toolingReadmeAnchors = new Map([
  ["@b4run/core", ["config", "renderB4Types", "@b4run/sdk"]],
  ["@b4run/langchain", ["chainAdapter", "openaiEmbedder", "edge-safe"]],
  [
    "@b4run/langgraph",
    [
      "defineEntry",
      "graphAdapter",
      "@b4run/langgraph/define-entry",
      "@b4run/langgraph/route-module",
    ],
  ],
  ["@b4run/vite-plugin", ["b4ToolSchemaPlugin as b4", "plugins: [b4()]", "Node-only"]],
  ["@b4run/devkit", ["resolveTemplateDir", "Node-only"]],
  ["@b4run/config-biome", ["extends", "--config-path", "dev dependency"]],
  ["@b4run/config-typescript", ["extends", "@b4run/config-typescript/node", "dev dependency"]],
])
const capabilityCaveatContracts = new Map([
  [
    "@b4run/ag-ui",
    [
      [
        "React renderer entry",
        /## React renderers/u,
        (readme) => readme.replace("## React renderers", "## Client rendering"),
      ],
      [
        "drop-in renderers",
        /\bb4ActivityRenderers\b/u,
        (readme) => readme.replaceAll("b4ActivityRenderers", "customRenderers"),
      ],
      [
        "tokens rung",
        /^\*\*Rung 1\s+—\s+tokens\.\*\*/mu,
        (readme) => readme.replace("**Rung 1 — tokens.**", "**Rung 1 — templates.**"),
      ],
      [
        "classNames rung",
        /^\*\*Rung 2\s+—\s+`classNames`\.\*\*/mu,
        (readme) => readme.replace("**Rung 2 — `classNames`.**", "**Rung 2 — themes.**"),
      ],
      [
        "components rung",
        /^\*\*Rung 3\s+—\s+`components`\.\*\*/mu,
        (readme) => readme.replace("**Rung 3 — `components`.**", "**Rung 3 — hooks.**"),
      ],
      [
        "eject rung",
        /^\*\*Rung 4\s+—\s+eject\.\*\*/mu,
        (readme) => readme.replace("**Rung 4 — eject.**", "**Rung 4 — presets.**"),
      ],
    ],
  ],
  [
    "@b4run/memory",
    [
      [
        "plaintext storage warning",
        /SQLite rows contain plaintext (?:content|data)/iu,
        (readme) =>
          readme.replace(
            "SQLite rows contain plaintext content",
            "SQLite rows do not contain plaintext content",
          ),
      ],
      [
        "tenant-scope warning",
        /^(?![^\n]*(?:do not|don't|never|automatic))[^\n]*enforce tenant scope[^\n]*caller boundary[^\n]*$/imu,
        (readme) =>
          readme.replace(
            "enforce tenant scope at the caller boundary",
            "do not enforce tenant scope at the caller boundary",
          ),
      ],
    ],
  ],
  [
    "@b4run/memory-pgvector",
    [
      [
        "store-created pool shutdown",
        /`?close\(\)`? ends? (?:a|the) store-created pool/iu,
        (readme) =>
          readme.replace(
            "Calling `close()` ends a store-created pool",
            "Calling `close()` does not end a store-created pool",
          ),
      ],
      [
        "injected caller-owned pool no-op",
        /^(?![^\n]*not a no-op)(?=[^\n]*injected caller-owned pool)(?=[^\n]*`?close\(\)`? is a no-op)[^\n]+$/imu,
        (readme) =>
          readme.replace(
            "For an injected caller-owned pool, `close()` is a no-op",
            "For an injected caller-owned pool, `close()` is not a no-op",
          ),
      ],
    ],
  ],
  [
    "@b4run/postgres-storage",
    [
      [
        "injected pool ownership",
        /injected pool (?:remains|is) caller-owned (?:unless|except when)[^\n]*`ownsPool: true`/iu,
        (readme) =>
          readme.replace(
            "An injected pool remains caller-owned unless `ownsPool: true`",
            "An injected pool is caller-owned when `ownsPool: true`",
          ),
      ],
      [
        "caller-owned pool shutdown",
        /Close stores and caller-owned pools during application shutdown\./u,
        (readme) =>
          readme.replace(
            "Close stores and caller-owned pools during application shutdown",
            "Close stores; caller-owned pools may remain open during application shutdown",
          ),
      ],
    ],
  ],
  [
    "@b4run/testing",
    [
      [
        "single-process concurrency warning",
        /do not run concurrent harnesses in one process/iu,
        (readme) =>
          readme.replace(
            "do not run concurrent harnesses in one process",
            "concurrent harnesses are safe in one process",
          ),
      ],
    ],
  ],
])
const relatedPackageDestinations = new Map([
  [
    "create-b4-app",
    ["https://www.npmjs.com/package/@b4run/cli", "https://www.npmjs.com/package/@b4run/sdk"],
  ],
  [
    "@b4run/sdk",
    ["https://www.npmjs.com/package/@b4run/cli", "https://www.npmjs.com/package/@b4run/testing"],
  ],
  [
    "@b4run/cli",
    ["https://www.npmjs.com/package/@b4run/sdk", "https://www.npmjs.com/package/@b4run/core"],
  ],
])
const entryReadmeAssets = new Map([
  [
    "logo",
    "https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png",
  ],
  [
    "product loop",
    "https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif",
  ],
])
const entryReadmeBlocks = new Map([
  [
    "logo",
    `<p align="center">
  <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="180">
</p>`,
  ],
  [
    "product loop",
    `<p align="center">
  <a href="https://b4.run/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif" alt="B4.run product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>`,
  ],
])
const entryReadmeBlockMutations = new Map([
  [
    "logo",
    [
      ["centered wrapper", (block) => block.replace('<p align="center">', "<p>")],
      ["alt text", (block) => block.replace('alt="B4.run"', 'alt="B4.run logo"')],
      ["width", (block) => block.replace('width="180"', 'width="181"')],
    ],
  ],
  [
    "product loop",
    [
      ["centered wrapper", (block) => block.replace('<p align="center">', "<p>")],
      ["anchor", (block) => block.replace("https://b4.run/#product-loop", "https://b4.run/docs")],
      [
        "alt text",
        (block) =>
          block.replace(
            "B4.run product loop: route, deterministic test, and Workbench",
            "B4.run product loop",
          ),
      ],
      ["width", (block) => block.replace('width="720"', 'width="721"')],
    ],
  ],
])
const canonicalHeroCommandBlock = `\`\`\`bash
npm create b4-app@latest my-agent
\`\`\``
const canonicalProductLoopBlock = `<p align="center">
  <a href="https://b4.run/#product-loop">
    <img src="docs/brand/product-loop.gif" alt="Animation showing an existing generated research workspace, a deterministic test, and the B4.run Workbench" width="900">
  </a>
</p>`
const canonicalQualifiedCredentials = `Credentials are provider-specific: the published research starter's OpenAI live
path requires \`OPENAI_API_KEY\`, while a local Ollama route requires no provider
key.`
const canonicalFinalCta = `Ready to start?

\`\`\`bash
npm create b4-app@latest my-agent
\`\`\``

function assertFailure(failures, expected) {
  assert.ok(
    failures.some((failure) => expected.test(failure)),
    `Expected a failure matching ${expected}, received:\n${failures.join("\n")}`,
  )
}

function literalPattern(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
}

it("treats regex metacharacters literally in assertion patterns", () => {
  for (const metacharacter of [
    ".",
    "*",
    "+",
    "?",
    "^",
    "$",
    "{",
    "}",
    "(",
    ")",
    "|",
    "[",
    "]",
    "\\",
  ]) {
    const literal = `before${metacharacter}after`
    assert.match(literal, literalPattern(literal))
    assert.doesNotMatch("beforeXafter", literalPattern(literal))
  }
})

function assertExactEntryBranding(packageName, readme) {
  for (const [blockName, block] of entryReadmeBlocks) {
    assert.ok(
      readme.includes(block),
      `${packageName} must use the exact canonical ${blockName} block`,
    )
  }
}

function relatedSection(readme) {
  const relatedStart = readme.indexOf("## Related")
  const relatedEnd = readme.indexOf("\n## ", relatedStart + 1)
  return readme.slice(relatedStart, relatedEnd === -1 ? undefined : relatedEnd)
}

function assertRelatedPackageDestinations(packageName, readme) {
  const expectedDestinations = relatedPackageDestinations.get(packageName) ?? []
  const related = relatedSection(readme)

  for (const destination of expectedDestinations) {
    assert.ok(
      related.includes(`](${destination})`),
      `${packageName} Related must link to ${destination}`,
    )
  }
}

function actualCapabilityReadme(packageName) {
  const readme = actualCapabilityPackages.find(
    ({ manifest }) => manifest.name === packageName,
  )?.readme
  assert.ok(readme, `Missing actual capability README for ${packageName}`)
  return readme
}

function assertCapabilityExampleAnchors(packageName, readme) {
  const example = readmeSection(readme, "Example")
  for (const anchor of capabilityExampleAnchors.get(packageName) ?? []) {
    assert.ok(example.includes(anchor), `${packageName} Example must include ${anchor}`)
  }
}

function assertCapabilityAnchorCoverage(packages, anchors) {
  assert.deepEqual([...anchors.keys()].sort(), packages.map(({ manifest }) => manifest.name).sort())
}

function assertCapabilityCaveats(packageName, readme) {
  for (const [label, pattern] of capabilityCaveatContracts.get(packageName) ?? []) {
    assert.match(readme, pattern, `${packageName} README must retain its ${label}`)
  }
}

function readmeSection(readme, heading) {
  const start = readme.indexOf(`## ${heading}`)
  assert.notEqual(start, -1, `README must include ## ${heading}`)
  const end = readme.indexOf("\n## ", start + heading.length + 3)
  return readme.slice(start, end === -1 ? undefined : end)
}

function assertNoCapabilityCampaignGif(packageName, readme) {
  assert.doesNotMatch(
    readme,
    /product-loop\.gif/iu,
    `${packageName} capability README must not include the campaign product-loop GIF`,
  )
}

function assertToolingReadmeAnchors(packageName, readme) {
  for (const anchor of toolingReadmeAnchors.get(packageName) ?? []) {
    assert.ok(readme.includes(anchor), `${packageName} README must include ${anchor}`)
  }
}

function assertNoToolingCampaignGif(packageName, readme) {
  assert.doesNotMatch(
    readme,
    /product-loop\.gif/iu,
    `${packageName} tooling README must not include the campaign product-loop GIF`,
  )
}

function assertConfigTypescriptPrerequisites(readme) {
  const install = readmeSection(readme, "Install")
  assert.match(
    install,
    /^# \/node\npnpm add -D @b4run\/config-typescript typescript @types\/node$/mu,
    "@b4run/config-typescript must document the Node profile's consumer type prerequisite",
  )
  assert.match(
    install,
    /^# \/nextjs\npnpm add -D @b4run\/config-typescript typescript @types\/node @types\/react @types\/react-dom$/mu,
    "@b4run/config-typescript must document the Next.js profile's consumer type prerequisites",
  )
  assert.doesNotMatch(
    readme,
    /\bcarr(?:y|ies)[^\n]*(?:React|Node)[^\n]*types?\b/iu,
    "@b4run/config-typescript must not imply its published package carries consumer types",
  )
}

describe("validatePackageReadme", () => {
  it("accepts a complete entry-package README and manifest", () => {
    assert.deepEqual(
      validatePackageReadme({
        tier: "entry",
        manifest: entryManifest,
        readme: entryReadme,
      }),
      [],
    )
  })

  it("accepts the planned raw HTML product-loop thumbnail", () => {
    const readme = entryReadme.replace(
      "![B4.run product loop](https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif)",
      `<p align="center">
  <a href="https://b4.run/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif" alt="B4.run product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>`,
    )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  it("accepts an inline raw-text tag before the planned HTML thumbnail", () => {
    const readme = entryReadme
      .replace(
        "Author-facing TypeScript SDK.",
        "Author-facing TypeScript SDK. Inline `<script>` is documentation text.",
      )
      .replace(
        "![B4.run product loop](https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif)",
        `<p align="center">
  <a href="https://b4.run/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif" alt="B4.run product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>`,
      )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  for (const [name, literal] of [
    ["inline code", "`<!--`"],
    ["a fenced block", "```md\n<!--\n```"],
  ]) {
    it(`accepts an unmatched comment opener inside ${name} before package requirements`, () => {
      const readme = entryReadme.replace(
        "Author-facing TypeScript SDK.\n",
        `Author-facing TypeScript SDK.\n\n${literal}\n`,
      )
      assert.deepEqual(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        [],
      )
    })
  }

  it("accepts an escaped raw-text opener before the genuine thumbnail", () => {
    const readme = entryReadme
      .replace(
        "Author-facing TypeScript SDK.",
        "Author-facing TypeScript SDK. Escaped \\<script> is prose.",
      )
      .replace(
        "![B4.run product loop](https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif)",
        `<p align="center">
  <a href="https://b4.run/#product-loop">
    <img src="https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif" alt="B4.run product loop: route, deterministic test, and Workbench" width="720">
  </a>
</p>`,
      )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  it("does not accept Markdown image syntax inside a raw HTML block", () => {
    const readme = entryReadme.replace(
      /!\[B4.run product loop\].*$/u,
      "<p>\n    ![Loop](docs/brand/product-loop.gif)\n</p>",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("accepts visible purpose prose inside a raw HTML block", () => {
    const readme = entryReadme.replace(
      "Author-facing TypeScript SDK.",
      "<div>\nAuthor-facing TypeScript SDK.\n</div>",
    )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  for (const tag of ["script", "style", "textarea"]) {
    it(`does not accept a Markdown image inside a <${tag}> raw-text block`, () => {
      const readme = entryReadme.replace(
        /!\[B4.run product loop\].*$/u,
        `<${tag}>\n![Loop](docs/brand/product-loop.gif)\n</${tag}>`,
      )
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        /product-loop\.gif/,
      )
    })
  }

  it("does not accept a Markdown image inside a generic HTML block", () => {
    const readme = entryReadme.replace(
      /!\[B4.run product loop\].*$/u,
      "<span>\n![Loop](docs/brand/product-loop.gif)\n</span>",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("does not accept an HTML image inside a raw-text block", () => {
    const readme = entryReadme.replace(
      /!\[B4.run product loop\].*$/u,
      '<script>\n<img src="docs/brand/product-loop.gif" alt="Decoy">\n</script>',
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("accepts an HTML image inside a rendered generic HTML block", () => {
    const readme = entryReadme.replace(
      /!\[B4.run product loop\].*$/u,
      '<span>\n<img src="docs/brand/product-loop.gif" alt="B4.run product loop">\n</span>',
    )
    assert.deepEqual(validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }), [])
  })

  it("does not count raw-text block content as purpose prose", () => {
    const readme = entryReadme.replace(
      "Author-facing TypeScript SDK.",
      "<textarea>\nAuthor-facing TypeScript SDK.\n</textarea>",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /purpose statement/,
    )
  })

  for (const tag of ["script", "style", "textarea"]) {
    it(`does not accept an HTML image nested in <div><${tag}>`, () => {
      const readme = entryReadme.replace(
        /!\[B4.run product loop\].*$/u,
        `<div>\n<${tag}>\n<img src="docs/brand/product-loop.gif" alt="Decoy">\n</${tag}>\n</div>`,
      )
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        /product-loop\.gif/,
      )
    })

    it(`does not count purpose prose nested in <div><${tag}>`, () => {
      const readme = entryReadme.replace(
        "Author-facing TypeScript SDK.",
        `<div>\n<${tag}>\nAuthor-facing TypeScript SDK.\n</${tag}>\n</div>`,
      )
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        /purpose statement/,
      )
    })
  }

  for (const [name, source, expected] of [
    [
      "Use this when guidance",
      entryReadme.replace("**Use this when:** You are authoring a B4.run route.\n\n", ""),
      /Use this when/,
    ],
    [
      "install or invocation heading",
      entryReadme.replace("## Install", "## Setup"),
      /Install.*Invocation/i,
    ],
    ["example heading", entryReadme.replace("## Example", "## API"), /Example/],
    [
      "runtime boundary",
      entryReadme.replace("## Runtime and stability", "## Architecture"),
      /Runtime and stability/,
    ],
    ["related links", entryReadme.replace("## Related", "## Elsewhere"), /Related/],
    [
      "maturity guidance",
      entryReadme.replace("## Maturity and support", "## Status"),
      /Maturity and support/,
    ],
    ["license heading", entryReadme.replace("## License", "## Legal"), /License/],
    [
      "entry-tier product-loop image",
      entryReadme.replace("docs/brand/product-loop.gif", "docs/brand/other.gif"),
      /product-loop\.gif/,
    ],
    ["package-name H1", entryReadme.replace("# @b4run/sdk", "# B4.run SDK"), /H1.*@b4run\/sdk/i],
    ["purpose statement", entryReadme.replace("Author-facing TypeScript SDK.\n\n", ""), /purpose/i],
  ]) {
    it(`rejects a README missing its ${name}`, () => {
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme: source,
        }),
        expected,
      )
    })
  }

  it("does not accept a package H1 hidden in a fenced code block", () => {
    const readme = entryReadme.replace(
      "# @b4run/sdk",
      "```md\n# @b4run/sdk\n```\n\n# Different package",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /H1.*@b4run\/sdk/i,
    )
  })

  it("does not accept an entry image hidden in a fenced code block", () => {
    const readme = entryReadme.replace(
      "![B4.run product loop](https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif)",
      "```md\n![B4.run product loop](docs/brand/product-loop.gif)\n```",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("does not accept an entry image written as inline code", () => {
    const readme = entryReadme.replace(
      "![B4.run product loop](https://raw.githubusercontent.com/cacheplane/b4run/main/docs/brand/product-loop.gif)",
      "`![B4.run product loop](docs/brand/product-loop.gif)`",
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  it("ignores package contract decoys inside a list-nested fence", () => {
    const readme = entryReadme
      .replace("# @b4run/sdk\n\n", "")
      .replace(/!\[B4.run product loop\].*$/u, "")
      .concat("\n- ```md\n  # @b4run/sdk\n  ![Loop](docs/brand/product-loop.gif)\n  ```")
    const failures = validatePackageReadme({
      tier: "entry",
      manifest: entryManifest,
      readme,
    })
    assertFailure(failures, /H1.*@b4run\/sdk/i)
    assertFailure(failures, /product-loop\.gif/)
  })

  it("ignores package contract decoys inside a three-space-indented fence", () => {
    const readme = entryReadme
      .replace("# @b4run/sdk\n\n", "")
      .replace(/!\[B4.run product loop\].*$/u, "")
      .concat("\n   ```md\n# @b4run/sdk\n![Loop](docs/brand/product-loop.gif)\n   ```")
    const failures = validatePackageReadme({
      tier: "entry",
      manifest: entryManifest,
      readme,
    })
    assertFailure(failures, /H1.*@b4run\/sdk/i)
    assertFailure(failures, /product-loop\.gif/)
  })

  it("ignores package contract decoys inside indented code", () => {
    const readme = entryReadme
      .replace("# @b4run/sdk\n\n", "")
      .replace(/!\[B4.run product loop\].*$/u, "")
      .concat("\n    # @b4run/sdk\n    ![Loop](docs/brand/product-loop.gif)")
    const failures = validatePackageReadme({
      tier: "entry",
      manifest: entryManifest,
      readme,
    })
    assertFailure(failures, /H1.*@b4run\/sdk/i)
    assertFailure(failures, /product-loop\.gif/)
  })

  it("does not accept an HTML product-loop image inside indented code", () => {
    const readme = entryReadme.replace(
      /!\[B4.run product loop\].*$/u,
      '    <img src="docs/brand/product-loop.gif" alt="Decoy">',
    )
    assertFailure(
      validatePackageReadme({ tier: "entry", manifest: entryManifest, readme }),
      /product-loop\.gif/,
    )
  })

  for (const structuralLine of [
    "---",
    "-",
    "1. First list entry",
    "[ci]: https://example.com/ci.svg",
    "![CI](https://example.com/ci.svg)",
    "`pnpm add @b4run/sdk`",
    "`B4.run SDK`",
    "| Package | Purpose |",
  ]) {
    it(`does not count ${JSON.stringify(structuralLine)} as purpose prose`, () => {
      const readme = entryReadme.replace("Author-facing TypeScript SDK.", structuralLine)
      assertFailure(
        validatePackageReadme({
          tier: "entry",
          manifest: entryManifest,
          readme,
        }),
        /purpose/i,
      )
    })
  }

  it("requires examples for capability packages", () => {
    const failures = validatePackageReadme({
      tier: "capability",
      manifest: { ...entryManifest, name: "@b4run/memory" },
      readme: entryReadme
        .replaceAll("@b4run/sdk", "@b4run/memory")
        .replace("## Example", "## Configuration"),
    })
    assertFailure(failures, /Example/)
  })

  it("allows tooling packages to use Configuration instead of Example", () => {
    assert.deepEqual(
      validatePackageReadme({
        tier: "tooling",
        manifest: { ...entryManifest, name: "@b4run/core" },
        readme: entryReadme
          .replaceAll("@b4run/sdk", "@b4run/core")
          .replace("## Example", "## Configuration")
          .replace(/\n!\[B4.run product loop\].*$/u, ""),
      }),
      [],
    )
  })

  it("rejects unknown package tiers", () => {
    assert.throws(
      () =>
        validatePackageReadme({
          tier: "unknown",
          manifest: entryManifest,
          readme: entryReadme,
        }),
      /Unknown README tier/,
    )
  })
})

describe("entry-package README contracts", () => {
  // Actual discovery metadata is intentionally deferred to the later actual-manifest tests.
  for (const { manifest, readme } of actualEntryPackages) {
    it(`accepts the actual ${manifest.name} README`, () => {
      assert.deepEqual(validatePackageReadme({ tier: "entry", manifest, readme }), [])
    })

    it(`uses npm-safe absolute assets in the actual ${manifest.name} README`, () => {
      assertExactEntryBranding(manifest.name, readme)
    })

    for (const [assetName, destination] of entryReadmeAssets) {
      it(`rejects a repository-relative ${assetName} in the actual ${manifest.name} README`, () => {
        const mutated = readme.replace(destination, destination.slice(destination.indexOf("docs/")))
        assert.notEqual(mutated, readme)
        assert.throws(() => assertExactEntryBranding(manifest.name, mutated))
      })
    }

    for (const [blockName, mutations] of entryReadmeBlockMutations) {
      it(`rejects noncanonical ${blockName} block fields in the actual ${manifest.name} README`, () => {
        const canonicalBlock = entryReadmeBlocks.get(blockName) ?? ""
        for (const [mutationName, mutate] of mutations) {
          const mutated = readme.replace(canonicalBlock, mutate(canonicalBlock))
          assert.notEqual(mutated, readme, `${manifest.name} ${mutationName} mutation must apply`)
          assert.throws(
            () => assertExactEntryBranding(manifest.name, mutated),
            `${manifest.name} ${mutationName} mutation must fail the asset contract`,
          )
        }
      })
    }

    it(`links the actual ${manifest.name} README to every intended B4.run package`, () => {
      assertRelatedPackageDestinations(manifest.name, readme)
    })

    for (const destination of relatedPackageDestinations.get(manifest.name) ?? []) {
      it(`rejects removing ${destination} from the actual ${manifest.name} Related section`, () => {
        const mutated = readme.replace(`](${destination})`, "](https://example.invalid)")
        assert.notEqual(mutated, readme)
        assert.throws(() => assertRelatedPackageDestinations(manifest.name, mutated))
      })
    }
  }

  it("keeps the actual create-b4-app release history valid after later publishes", () => {
    const createReadme = actualEntryPackages.find(
      ({ manifest }) => manifest.name === "create-b4-app",
    )?.readme

    assert.match(
      createReadme ?? "",
      /0\.8\.21[^\n]*single-package[^\n]*0\.8\.22[^\n]*`server`[^\n]*`web`/u,
    )
    assert.match(createReadme ?? "", /`npm view create-b4-app@latest version`/u)
    for (const selfInvalidatingPhrase of [
      "published `@latest` version was verified as 0.8.21",
      "current 0.8.22 repository source",
      "until that version is published",
    ]) {
      assert.equal(createReadme?.includes(selfInvalidatingPhrase), false)
    }
  })

  it("labels the actual @b4run/cli/testing subpath as deprecated compatibility", () => {
    const cliReadme = actualEntryPackages.find(
      ({ manifest }) => manifest.name === "@b4run/cli",
    )?.readme

    assert.doesNotMatch(cliReadme ?? "", /`@b4run\/cli\/testing`[ \t]+is[ \t]+a[ \t]+supported\b/iu)
    assert.match(
      cliReadme ?? "",
      /`@b4run\/cli\/testing`[^\n]*\bdeprecated\b[^\n]*`@b4run\/sdk\/testing`/iu,
    )
  })
})

describe("capability-package README contracts", () => {
  it("defines example anchors for every capability package", () => {
    assertCapabilityAnchorCoverage(actualCapabilityPackages, capabilityExampleAnchors)
  })

  it("rejects omitting a capability package from the example-anchor map", () => {
    const mutated = new Map(capabilityExampleAnchors)
    mutated.delete("@b4run/workspace")
    assert.throws(() => assertCapabilityAnchorCoverage(actualCapabilityPackages, mutated))
  })

  for (const { manifest, readme } of actualCapabilityPackages) {
    it(`accepts the actual ${manifest.name} README`, () => {
      assert.deepEqual(validatePackageReadme({ tier: "capability", manifest, readme }), [])
    })

    it(`keeps the actual ${manifest.name} example anchors`, () => {
      assertCapabilityExampleAnchors(manifest.name, readme)
    })

    it(`rejects removing an example anchor from the actual ${manifest.name} README`, () => {
      for (const anchor of capabilityExampleAnchors.get(manifest.name) ?? []) {
        const mutated = readme.replaceAll(anchor, "")
        assert.notEqual(mutated, readme, `${manifest.name} ${anchor} mutation must apply`)
        assert.throws(() => assertCapabilityExampleAnchors(manifest.name, mutated))
      }
    })

    it(`keeps the campaign GIF out of the actual ${manifest.name} README`, () => {
      assertNoCapabilityCampaignGif(manifest.name, readme)
    })

    it(`rejects adding the campaign GIF to the actual ${manifest.name} README`, () => {
      const mutated = `${readme}\n![B4.run product loop](docs/brand/product-loop.gif)\n`
      assert.throws(() => assertNoCapabilityCampaignGif(manifest.name, mutated))
    })
  }

  for (const [packageName, contracts] of capabilityCaveatContracts) {
    it(`keeps the actual ${packageName} high-risk caveats`, () => {
      assertCapabilityCaveats(packageName, actualCapabilityReadme(packageName))
    })

    it(`rejects contradicting high-risk caveats in the actual ${packageName} README`, () => {
      const readme = actualCapabilityReadme(packageName)
      for (const [label, , mutate] of contracts) {
        const mutated = mutate(readme)
        assert.notEqual(mutated, readme, `${packageName} ${label} mutation must apply`)
        assert.throws(() => assertCapabilityCaveats(packageName, mutated))
      }
    })
  }

  it("rejects direct negations of the Postgres caller-owned pool shutdown guidance", () => {
    const readme = actualCapabilityReadme("@b4run/postgres-storage")
    const guidance = "Close stores and caller-owned pools during application shutdown."

    for (const contradiction of [
      "Do not close stores and caller-owned pools during application shutdown.",
      "Never close stores and caller-owned pools during application shutdown.",
    ]) {
      const mutated = readme.replace(guidance, contradiction)
      assert.notEqual(mutated, readme, `${contradiction} mutation must apply`)
      assert.throws(() => assertCapabilityCaveats("@b4run/postgres-storage", mutated))
    }
  })
})

describe("tooling-package README contracts", () => {
  for (const { manifest, readme } of actualToolingPackages) {
    it(`accepts the actual ${manifest.name} README`, () => {
      assert.deepEqual(validatePackageReadme({ tier: "tooling", manifest, readme }), [])
    })

    it(`keeps the actual ${manifest.name} package-specific anchors`, () => {
      assertToolingReadmeAnchors(manifest.name, readme)
    })

    it(`keeps the campaign GIF out of the actual ${manifest.name} README`, () => {
      assertNoToolingCampaignGif(manifest.name, readme)
    })
  }

  it("documents the vite plugin through its real named export", () => {
    const vitePluginReadme = actualToolingPackages.find(
      ({ manifest }) => manifest.name === "@b4run/vite-plugin",
    )?.readme

    assert.match(vitePluginReadme ?? "", /import \{ b4ToolSchemaPlugin as b4 \}/u)
    assert.doesNotMatch(vitePluginReadme ?? "", /import b4 from/u)
  })

  it("documents consumer-owned type prerequisites for config profiles", () => {
    const configTypescriptReadme = actualToolingPackages.find(
      ({ manifest }) => manifest.name === "@b4run/config-typescript",
    )?.readme

    assertConfigTypescriptPrerequisites(configTypescriptReadme ?? "")
  })

  it("rejects omitting a config profile's consumer type prerequisites", () => {
    const configTypescriptReadme = actualToolingPackages.find(
      ({ manifest }) => manifest.name === "@b4run/config-typescript",
    )?.readme
    assert.ok(configTypescriptReadme)

    for (const command of [
      "pnpm add -D @b4run/config-typescript typescript @types/node",
      "pnpm add -D @b4run/config-typescript typescript @types/node @types/react @types/react-dom",
    ]) {
      const mutated = configTypescriptReadme.replace(command, "")
      assert.notEqual(mutated, configTypescriptReadme, `${command} mutation must apply`)
      assert.throws(() => assertConfigTypescriptPrerequisites(mutated))
    }
  })

  it("rejects claiming the config package carries consumer types", () => {
    const configTypescriptReadme = actualToolingPackages.find(
      ({ manifest }) => manifest.name === "@b4run/config-typescript",
    )?.readme
    assert.ok(configTypescriptReadme)

    const accurate = "Consumer projects install these ambient type packages directly"
    const mutated = configTypescriptReadme.replace(
      accurate,
      "The Next.js configuration carries React and Node types",
    )
    assert.notEqual(mutated, configTypescriptReadme, "consumer-ownership mutation must apply")
    assert.throws(() => assertConfigTypescriptPrerequisites(mutated))
  })
})

describe("validatePackageDiscoveryMetadata", () => {
  it("accepts discovery metadata from every actual public package manifest", () => {
    assert.equal(actualPublicPackageManifests.length, 21)
    assert.deepEqual(
      actualPublicPackageManifests.flatMap((manifest) =>
        validatePackageDiscoveryMetadata(manifest),
      ),
      [],
    )
  })

  it("keeps every public package manifest on the approved discovery copy", () => {
    for (const { manifest, expectedDiscoveryMetadata } of [
      ...actualEntryPackages,
      ...actualCapabilityPackages,
      ...actualToolingPackages,
    ]) {
      assert.deepEqual(
        {
          description: manifest.description,
          keywords: manifest.keywords,
        },
        expectedDiscoveryMetadata,
        manifest.name,
      )
    }
  })

  it("accepts a trimmed 30-180 character description and 3-8 discovery keywords", () => {
    assert.deepEqual(validatePackageDiscoveryMetadata(entryManifest), [])
    assert.deepEqual(
      validatePackageDiscoveryMetadata({
        ...entryManifest,
        description: "x".repeat(30),
        keywords: Array.from({ length: 8 }, (_, index) => `keyword-${index}`),
      }),
      [],
    )
    assert.deepEqual(
      validatePackageDiscoveryMetadata({
        ...entryManifest,
        description: "x".repeat(180),
      }),
      [],
    )
  })

  for (const [name, patch, expected] of [
    ["missing description", { description: undefined }, /description.*30.*180/i],
    ["untrimmed description", { description: ` ${"x".repeat(30)}` }, /description.*trimmed/i],
    ["short description", { description: "Too short" }, /description.*30.*180/i],
    ["long description", { description: "x".repeat(181) }, /description.*30.*180/i],
    ["empty keywords", { keywords: [] }, /keywords.*3.*8/i],
    ["too few keywords", { keywords: ["b4", "typescript"] }, /keywords.*3.*8/i],
    [
      "too many keywords",
      { keywords: Array.from({ length: 9 }, (_, index) => `keyword-${index}`) },
      /keywords.*3.*8/i,
    ],
    ["duplicate keywords", { keywords: ["b4", "b4", "typescript"] }, /unique/i],
    ["uppercase keywords", { keywords: ["B4.run", "typescript", "langgraph"] }, /lowercase/i],
    ["invalid keywords", { keywords: ["b4", "type_script", "langgraph"] }, /lowercase/i],
    ["empty keyword values", { keywords: ["b4", "", "langgraph"] }, /lowercase/i],
  ]) {
    it(`rejects ${name}`, () => {
      assertFailure(validatePackageDiscoveryMetadata({ ...entryManifest, ...patch }), expected)
    })
  }

  it("includes discovery metadata failures in the package README contract", () => {
    assertFailure(
      validatePackageReadme({
        tier: "entry",
        manifest: { ...entryManifest, description: "Too short" },
        readme: entryReadme,
      }),
      /description.*30.*180/i,
    )
  })
})

describe("validateRootReadme", () => {
  it("accepts the actual root README", () => {
    assert.deepEqual(validateRootReadme(actualRootReadme, { canonical: true }), [])
  })

  it("documents the working published latest run path before current-source commands", () => {
    const publishedStart = actualRootReadme.indexOf("### Published `@latest` (0.8.21)")
    const currentSourceStart = actualRootReadme.indexOf("### Current source (unreleased 0.8.22)")
    assert.ok(publishedStart !== -1 && publishedStart < currentSourceStart)
    const published = actualRootReadme.slice(publishedStart, currentSourceStart)
    assert.match(published, /OPENAI_API_KEY/)
    assert.match(published, /npm run dev(?:\s|$)/)
    assert.match(published, /npm run build/)
    assert.match(published, /\/docs\/dev-server\/agent-protocol/)
    assert.match(published, /\/docs\/recipes\/research-web-ui/)
    assert.doesNotMatch(published, /^npm (?:run dev:(?:server|web)|start)$/mu)
  })

  it("labels unreleased current-source server, Workbench, build, and start commands", () => {
    const currentSourceStart = actualRootReadme.indexOf("### Current source (unreleased 0.8.22)")
    const maturityStart = actualRootReadme.indexOf("## Maturity and support")
    assert.ok(currentSourceStart !== -1 && currentSourceStart < maturityStart)
    const currentSource = actualRootReadme.slice(currentSourceStart, maturityStart)
    for (const command of ["npm run dev:server", "npm run dev:web", "npm run build", "npm start"]) {
      assert.match(currentSource, new RegExp(command.replaceAll(" ", "\\s+")))
    }
    for (const deployment of ["node", "langsmith", "edge", "kubernetes"]) {
      assert.match(currentSource, new RegExp(`/docs/deployment/${deployment}`))
    }
  })

  it("accepts the required root README structure and references", () => {
    assert.deepEqual(validateRootReadme(rootReadme), [])
  })

  it("requires the exact canonical hero", () => {
    const source = actualRootReadme.replace(
      "# Build LangGraph agents like Next.js apps.",
      "# Build LangGraph agents with fewer conventions.",
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exact canonical hero/i)
  })

  it("rejects a sixth hero badge", () => {
    const source = actualRootReadme.replace(
      '</p>\n\n<p align="center">\n  <a href="https://b4.run/docs/getting-started">',
      '  <a href="https://example.com"><img src="https://example.com/sixth.svg" alt="Sixth badge"></a>\n</p>\n\n<p align="center">\n  <a href="https://b4.run/docs/getting-started">',
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  it("rejects a sixth hero badge in an adjacent first-scroll block", () => {
    const source = actualRootReadme.replace(
      '<p align="center">\n  <a href="https://b4.run/docs/getting-started">',
      '<p align="center">\n  <a href="https://example.com"><img src="https://example.com/sixth.svg" alt="Sixth badge"></a>\n</p>\n\n<p align="center">\n  <a href="https://b4.run/docs/getting-started">',
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  it("rejects a sixth Markdown hero badge before Quickstart", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `[![Sixth](https://example.com/sixth.svg)](https://example.com)\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  it("rejects a sixth reference-style linked GFM badge before Quickstart", () => {
    const source = actualRootReadme
      .replace(
        canonicalHeroCommandBlock,
        `[![Sixth][sixth-image]][sixth-link]\n\n${canonicalHeroCommandBlock}`,
      )
      .replace(
        "## License",
        "[sixth-image]: https://example.com/sixth.svg\n[sixth-link]: https://example.com\n\n## License",
      )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  it("rejects a sixth raw HTML badge with unquoted attributes before Quickstart", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `<a href=https://example.com><img src=https://example.com/sixth.svg alt=Sixth></a>\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(validateRootReadme(source, { canonical: true }), /exactly five approved badges/i)
  })

  for (const [name, source] of [
    [
      "missing hero navigation link",
      actualRootReadme.replace('  <a href="https://b4.run/docs">Documentation</a> ·\n', ""),
    ],
    [
      "extra hero navigation link",
      actualRootReadme.replace(
        '  <a href="https://b4.run/docs">Documentation</a> ·\n',
        '  <a href="https://b4.run/docs">Documentation</a> ·\n  <a href="https://example.com">Extra</a> ·\n',
      ),
    ],
  ]) {
    it(`rejects a ${name}`, () => {
      assertFailure(
        validateRootReadme(source, { canonical: true }),
        /exactly four canonical hero navigation links/i,
      )
    })
  }

  it("rejects a fifth hero navigation link in an adjacent first-scroll block", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `<p align="center"><a href="https://example.com">Fifth link</a></p>\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /exactly four canonical hero navigation links/i,
    )
  })

  it("rejects a fifth Markdown hero navigation link before Quickstart", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `[Fifth link](https://example.com)\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /exactly four canonical hero navigation links/i,
    )
  })

  it("rejects a fifth reference-style GFM navigation link before Quickstart", () => {
    const source = actualRootReadme
      .replace(
        canonicalHeroCommandBlock,
        `[Fifth link][fifth-link]\n\n${canonicalHeroCommandBlock}`,
      )
      .replace("## License", "[fifth-link]: https://example.com\n\n## License")
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /exactly four canonical hero navigation links/i,
    )
  })

  it("rejects a fifth GFM autolink before Quickstart", () => {
    const source = actualRootReadme.replace(
      canonicalHeroCommandBlock,
      `<https://example.com>\n\n${canonicalHeroCommandBlock}`,
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /exactly four canonical hero navigation links/i,
    )
  })

  for (const [name, autolink] of [
    ["bare URL", "https://example.com"],
    ["bare www URL", "www.example.com"],
    ["bare email", "extra@example.com"],
    ["angle-bracket email autolink", "<extra@example.com>"],
  ]) {
    it(`rejects a fifth ${name} GFM link before Quickstart`, () => {
      const source = actualRootReadme.replace(
        canonicalHeroCommandBlock,
        `${autolink}\n\n${canonicalHeroCommandBlock}`,
      )
      assertFailure(
        validateRootReadme(source, { canonical: true }),
        /exactly four canonical hero navigation links/i,
      )
    })
  }

  it("does not count body-only GFM bare and angle-bracket autolinks", () => {
    const source = actualRootReadme.replace(
      "## Why B4.run",
      "## Why B4.run\n\nhttps://example.com\n\nwww.example.com\n\nextra@example.com\n\n<extra@example.com>",
    )
    assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
  })

  for (const [name, hiddenLinks] of [
    [
      "fenced code",
      "```text\nhttps://example.com\nwww.example.com\nextra@example.com\n<extra@example.com>\n```",
    ],
    [
      "HTML comment",
      "<!-- https://example.com www.example.com extra@example.com <extra@example.com> -->",
    ],
    [
      "raw-text HTML",
      "<script>const links = 'https://example.com www.example.com extra@example.com <extra@example.com>'</script>",
    ],
  ]) {
    it(`does not count GFM autolinks inside ${name}`, () => {
      const source = actualRootReadme.replace(
        canonicalHeroCommandBlock,
        `${hiddenLinks}\n\n${canonicalHeroCommandBlock}`,
      )
      assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
    })
  }

  it("does not count body-only reference-style GFM badges and links", () => {
    const source = actualRootReadme
      .replace(
        "## Why B4.run",
        "## Why B4.run\n\n[![Body badge][body-image]][body-link]\n\n[Body link][body-nav]",
      )
      .replace(
        "## License",
        "[body-image]: https://example.com/body.svg\n[body-link]: https://example.com/badge\n[body-nav]: https://example.com/nav\n\n## License",
      )
    assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
  })

  it("requires the first scaffold command before the product-loop GIF", () => {
    const source = actualRootReadme
      .replace(`${canonicalHeroCommandBlock}\n\n`, "")
      .replace(
        "[Read the product-loop transcript]",
        `${canonicalHeroCommandBlock}\n\n[Read the product-loop transcript]`,
      )
    assertFailure(validateRootReadme(source, { canonical: true }), /before the product-loop GIF/i)
  })

  for (const [name, source] of [
    [
      "unlinked product-loop GIF",
      actualRootReadme.replace(
        canonicalProductLoopBlock,
        '<p align="center">\n  <img src="docs/brand/product-loop.gif" alt="Animation showing an existing generated research workspace, a deterministic test, and the B4.run Workbench" width="900">\n</p>',
      ),
    ],
    [
      "wrong product-loop anchor",
      actualRootReadme.replace("https://b4.run/#product-loop", "https://b4.run/docs"),
    ],
    [
      "wrong product-loop alt text",
      actualRootReadme.replace(
        "Animation showing an existing generated research workspace, a deterministic test, and the B4.run Workbench",
        "B4.run product loop",
      ),
    ],
  ]) {
    it(`rejects a ${name}`, () => {
      assertFailure(
        validateRootReadme(source, { canonical: true }),
        /linked product-loop GIF with canonical anchor and alt text/i,
      )
    })
  }

  it("requires the complete no-key Quickstart sequence", () => {
    const source = actualRootReadme.replace(
      "cd my-agent\nnpm install\nnpm test",
      "cd my-agent\nnpm install",
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /complete no-key Quickstart sequence/i,
    )
  })

  it("requires the canonical transcript link in the actual README", () => {
    const source = actualRootReadme.replace(
      "[Read the product-loop transcript](docs/brand/demo/transcript.md).",
      "",
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /canonical product-loop transcript link/i,
    )
  })

  it("requires a final scaffold CTA", () => {
    const source = actualRootReadme.replace(canonicalFinalCta, "Ready to start?")
    assertFailure(validateRootReadme(source, { canonical: true }), /final scaffold CTA/i)
  })

  it("requires the canonical License section", () => {
    const source = actualRootReadme.replace("## License\n\nMIT. See [LICENSE](./LICENSE).", "")
    assertFailure(validateRootReadme(source, { canonical: true }), /canonical License section/i)
  })

  it("requires canonical provider-specific credential guidance", () => {
    assertFailure(
      validateRootReadme(actualRootReadme.replace(canonicalQualifiedCredentials, ""), {
        canonical: true,
      }),
      /canonical provider-specific credential guidance/i,
    )
  })

  for (const universal of [
    "Every live model call needs an API key.",
    "All live model calls require credentials.",
    "Live provider runs always need credentials.",
  ]) {
    it(`rejects the universal credentials paraphrase ${JSON.stringify(universal)}`, () => {
      const source = actualRootReadme.replace(
        "## Run it live\n\n",
        `## Run it live\n\n${universal}\n\n`,
      )
      assertFailure(
        validateRootReadme(source, { canonical: true }),
        /not every live model call requires credentials/i,
      )
    })
  }

  it("does not reject explicit negation of the universal credentials claim", () => {
    const source = actualRootReadme.replace(
      "## Run it live\n\n",
      "## Run it live\n\nNot all live model calls require credentials.\n\n",
    )
    assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
  })

  it("accepts a negated universal live-provider credentials claim", () => {
    const source = actualRootReadme.replace(
      "## Run it live\n\n",
      "## Run it live\n\nNot all live provider runs always need credentials.\n\n",
    )
    assert.deepEqual(validateRootReadme(source, { canonical: true }), [])
  })

  it("rejects an each-quantified singular credential claim", () => {
    const source = actualRootReadme.replace(
      "## Run it live\n\n",
      "## Run it live\n\nEach live model call requires a credential.\n\n",
    )
    assertFailure(
      validateRootReadme(source, { canonical: true }),
      /not every live model call requires credentials/i,
    )
  })

  for (const [name, literal] of [
    ["inline code", "`<!--`"],
    ["a fenced block", "```md\n<!--\n```"],
  ]) {
    it(`accepts an unmatched comment opener inside ${name} before root requirements`, () => {
      const source = rootReadme.replace("# B4.run\n", `# B4.run\n\n${literal}\n`)
      assert.deepEqual(validateRootReadme(source), [])
    })
  }

  it("accepts the product-loop GIF as an HTML image", () => {
    const htmlImage = rootReadme.replace(
      "![B4.run product loop](docs/brand/product-loop.gif)",
      '<img src="docs/brand/product-loop.gif" alt="B4.run product loop" />',
    )
    assert.deepEqual(validateRootReadme(htmlImage), [])
  })

  it("accepts the canonical scaffold command in a fenced shell example", () => {
    const fencedCommand = rootReadme.replace(
      "`npm create b4-app@latest my-agent`",
      "```bash\nnpm create b4-app@latest my-agent\n```",
    )
    assert.deepEqual(validateRootReadme(fencedCommand), [])
  })

  it("allows unrelated headings between required root sections", () => {
    assert.deepEqual(
      validateRootReadme(rootReadme.replace("## Why B4.run", "## Note\n\n## Why B4.run")),
      [],
    )
  })

  for (const heading of [
    "Quickstart",
    "Why B4.run",
    "How B4.run fits",
    "What B4.run writes for you",
    "What are you building?",
    "When B4.run fits",
    "Build with a coding agent",
    "Run it live",
    "Maturity and support",
  ]) {
    it(`requires the ${heading} heading`, () => {
      assertFailure(
        validateRootReadme(rootReadme.replace(`## ${heading}`, `## Other ${heading}`)),
        literalPattern(heading),
      )
    })
  }

  it("requires the headings in canonical order", () => {
    const outOfOrder = rootReadme
      .replace("## Quickstart", "## TEMP")
      .replace("## Why B4.run", "## Quickstart")
      .replace("## TEMP", "## Why B4.run")
    assertFailure(validateRootReadme(outOfOrder), /order/i)
  })

  it("reports order failures among present headings when another heading is missing", () => {
    const missingAndOutOfOrder = rootReadme
      .replace("## Why B4.run\n\n", "")
      .replace("## Quickstart", "## TEMP")
      .replace("## How B4.run fits", "## Quickstart")
      .replace("## TEMP", "## How B4.run fits")
    const failures = validateRootReadme(missingAndOutOfOrder)
    assertFailure(failures, /Why B4.run/)
    assertFailure(failures, /order/i)
  })

  it("ignores headings inside fenced code blocks when checking order", () => {
    const misleading = rootReadme
      .replace("## Quickstart\n", "")
      .replace("# B4.run\n", "# B4.run\n\n```md\n## Quickstart\n```\n")
    assertFailure(validateRootReadme(misleading), /Quickstart/)
  })

  it("ignores Markdown headings inside raw HTML blocks", () => {
    const misleading = rootReadme
      .replace("## Quickstart\n", "")
      .concat("\n\n<div>\n  ## Quickstart\n</div>")
    assertFailure(validateRootReadme(misleading), /Quickstart/)
  })

  it("ignores Markdown headings inside raw-text HTML blocks", () => {
    const misleading = rootReadme
      .replace("## Quickstart\n", "")
      .concat("\n\n<style>\n## Quickstart\n</style>")
    assertFailure(validateRootReadme(misleading), /Quickstart/)
  })

  it("requires exact H2 spelling for root section headings", () => {
    assertFailure(
      validateRootReadme(rootReadme.replace("## Quickstart", "### quickstart")),
      /Quickstart/,
    )
  })

  it("rejects duplicate required root headings", () => {
    assertFailure(
      validateRootReadme(rootReadme.replace("## Why B4.run", "## Quickstart\n\n## Why B4.run")),
      /Quickstart/,
    )
  })

  it("does not accept root assets and links hidden in fenced examples", () => {
    const hiddenReferences = rootReadme
      .replace("![B4.run product loop](docs/brand/product-loop.gif)", "")
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n```md\n![Loop](docs/brand/product-loop.gif)\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n```",
      )
    const failures = validateRootReadme(hiddenReferences)
    assertFailure(failures, /product-loop\.gif/)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("does not accept root references hidden in HTML comments", () => {
    const hiddenReferences = rootReadme
      .replace("![B4.run product loop](docs/brand/product-loop.gif)", "")
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n<!-- ![Loop](docs/brand/product-loop.gif) [Migration](/docs/migrating-from-langgraph) [Transcript](docs/brand/demo/transcript.md) -->",
      )
    const failures = validateRootReadme(hiddenReferences)
    assertFailure(failures, /product-loop\.gif/)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  for (const [name, reference, decoy, expected] of [
    [
      "migration",
      "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
      "[Migration](/docs/migrating-from-langgraph)",
      /migrating-from-langgraph/,
    ],
    [
      "transcript",
      "[Read the demo transcript](docs/brand/demo/transcript.md)",
      "[Transcript](docs/brand/demo/transcript.md)",
      /transcript\.md/,
    ],
  ]) {
    it(`does not accept a Markdown ${name} link inside a raw HTML block`, () => {
      const source = rootReadme.replace(reference, "").concat(`\n\n<div>\n    ${decoy}\n</div>`)
      assertFailure(validateRootReadme(source), expected)
    })
  }

  for (const tag of ["script", "style", "textarea", "span"]) {
    it(`does not accept Markdown links inside a <${tag}> HTML block`, () => {
      const source = rootReadme
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
        .concat(
          `\n\n<${tag}>\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n</${tag}>`,
        )
      const failures = validateRootReadme(source)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  for (const [name, block] of [
    [
      "processing-instruction",
      "<?b4\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n?>",
    ],
    [
      "declaration",
      "<!DECLARATION b4\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n>",
    ],
    [
      "CDATA",
      "<![CDATA[\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n]]>",
    ],
    [
      "pre block containing a blank line",
      "<pre>\ncode\n\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n</pre>",
    ],
  ]) {
    it(`does not accept Markdown links inside a ${name}`, () => {
      const source = rootReadme
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
        .concat(`\n\n${block}`)
      const failures = validateRootReadme(source)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  it("does not accept root assets and links written as inline code", () => {
    const inlineReferences = rootReadme
      .replace(
        "![B4.run product loop](docs/brand/product-loop.gif)",
        "`![B4.run product loop](docs/brand/product-loop.gif)`",
      )
      .replace(
        "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
        "`[Migrate from LangGraph](/docs/migrating-from-langgraph)`",
      )
      .replace(
        "[Read the demo transcript](docs/brand/demo/transcript.md)",
        "`[Read the demo transcript](docs/brand/demo/transcript.md)`",
      )
    const failures = validateRootReadme(inlineReferences)
    assertFailure(failures, /product-loop\.gif/)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  for (const [name, decoy] of [
    [
      "a list-nested fence",
      "- ```md\n  ## Quickstart\n  ![Loop](docs/brand/product-loop.gif)\n  [Migration](/docs/migrating-from-langgraph)\n  [Transcript](docs/brand/demo/transcript.md)\n  ```",
    ],
    [
      "indented code",
      "    ## Quickstart\n    ![Loop](docs/brand/product-loop.gif)\n    [Migration](/docs/migrating-from-langgraph)\n    [Transcript](docs/brand/demo/transcript.md)",
    ],
  ]) {
    it(`ignores root contract decoys inside ${name}`, () => {
      const source = rootReadme
        .replace("## Quickstart\n", "")
        .replace("![B4.run product loop](docs/brand/product-loop.gif)", "")
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
        .concat(`\n\n${decoy}`)
      const failures = validateRootReadme(source)
      assertFailure(failures, /Quickstart/)
      assertFailure(failures, /product-loop\.gif/)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  it("does not close a top-level fence on a list-prefixed fence marker", () => {
    const deceptiveClose = rootReadme
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n```md\n- ```\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)\n```",
      )
    const failures = validateRootReadme(deceptiveClose)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  for (const [name, prefix] of [
    ["tab-expanded indented code", " \t"],
    ["blockquote-contained indented code", ">     "],
  ]) {
    it(`ignores root links inside ${name}`, () => {
      const source = rootReadme
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
        .concat(
          `\n\n${prefix}[Migration](/docs/migrating-from-langgraph)\n${prefix}[Transcript](docs/brand/demo/transcript.md)`,
        )
      const failures = validateRootReadme(source)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  it("ignores links inside list-container indented code", () => {
    const source = rootReadme
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n-     [Migration](/docs/migrating-from-langgraph)\n1.     [Transcript](docs/brand/demo/transcript.md)",
      )
    const failures = validateRootReadme(source)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("ignores links inside tab-expanded list indented code", () => {
    const source = rootReadme
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n-\t  [Migration](/docs/migrating-from-langgraph)\n1.\t   [Transcript](docs/brand/demo/transcript.md)",
      )
    const failures = validateRootReadme(source)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("ends an unclosed list fence when the list container ends", () => {
    const source = rootReadme
      .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", "")
      .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", "")
      .concat(
        "\n\n- ```md\n  code\n[Migration](/docs/migrating-from-langgraph)\n[Transcript](docs/brand/demo/transcript.md)",
      )
    assert.deepEqual(validateRootReadme(source), [])
  })

  it("does not count a Markdown image as the required migration link", () => {
    const imageOnly = rootReadme.replace(
      "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
      "![Migration diagram](/docs/migrating-from-langgraph)",
    )
    assertFailure(validateRootReadme(imageOnly), /migrating-from-langgraph/)
  })

  it("requires exact relative link destinations", () => {
    const prefixedLinks = rootReadme
      .replace("/docs/migrating-from-langgraph", "PREFIX/docs/migrating-from-langgraph")
      .replace("docs/brand/demo/transcript.md", "PREFIXdocs/brand/demo/transcript.md")
    const failures = validateRootReadme(prefixedLinks)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("accepts canonical absolute documentation links", () => {
    const absoluteLinks = rootReadme
      .replace("/docs/migrating-from-langgraph", "https://b4.run/docs/migrating-from-langgraph")
      .replace(
        "docs/brand/demo/transcript.md",
        "https://github.com/cacheplane/b4run/blob/main/docs/brand/demo/transcript.md",
      )
    assert.deepEqual(validateRootReadme(absoluteLinks), [])
  })

  it("rejects arbitrary origins that copy canonical link paths", () => {
    const evilOrigins = rootReadme
      .replace(
        "/docs/migrating-from-langgraph",
        "https://evil.example/docs/migrating-from-langgraph",
      )
      .replace(
        "docs/brand/demo/transcript.md",
        "https://evil.example/docs/brand/demo/transcript.md",
      )
    const failures = validateRootReadme(evilOrigins)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("does not treat linked-image destinations as enclosing documentation links", () => {
    const linkedImages = rootReadme
      .replace(
        "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
        "[![Migration](/docs/migrating-from-langgraph)](https://evil.example)",
      )
      .replace(
        "[Read the demo transcript](docs/brand/demo/transcript.md)",
        "[![Transcript](docs/brand/demo/transcript.md)](https://evil.example)",
      )
    const failures = validateRootReadme(linkedImages)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  it("does not treat outer destinations of nested ordinary links as rendered links", () => {
    const nestedLinks = rootReadme
      .replace(
        "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
        "[Outer [inner](https://evil.example)](/docs/migrating-from-langgraph)",
      )
      .replace(
        "[Read the demo transcript](docs/brand/demo/transcript.md)",
        "[Outer [inner](https://evil.example)](docs/brand/demo/transcript.md)",
      )
    const failures = validateRootReadme(nestedLinks)
    assertFailure(failures, /migrating-from-langgraph/)
    assertFailure(failures, /transcript\.md/)
  })

  for (const [name, migration, transcript] of [
    [
      "escaped link openers",
      "\\[Migration](/docs/migrating-from-langgraph)",
      "\\[Transcript](docs/brand/demo/transcript.md)",
    ],
    [
      "garbage after angle-bracket destinations",
      "[Migration](</docs/migrating-from-langgraph>evil)",
      "[Transcript](<docs/brand/demo/transcript.md>evil)",
    ],
    [
      "unquoted garbage after destinations",
      "[Migration](/docs/migrating-from-langgraph nope)",
      "[Transcript](docs/brand/demo/transcript.md nope)",
    ],
    [
      "titles without separating whitespace",
      '[Migration](</docs/migrating-from-langgraph>"title")',
      '[Transcript](<docs/brand/demo/transcript.md>"title")',
    ],
  ]) {
    it(`rejects ${name} as documentation links`, () => {
      const source = rootReadme
        .replace("[Migrate from LangGraph](/docs/migrating-from-langgraph)", migration)
        .replace("[Read the demo transcript](docs/brand/demo/transcript.md)", transcript)
      const failures = validateRootReadme(source)
      assertFailure(failures, /migrating-from-langgraph/)
      assertFailure(failures, /transcript\.md/)
    })
  }

  it("accepts real links after escaped image markers", () => {
    const escapedImageMarkers = rootReadme
      .replace(
        "[Migrate from LangGraph](/docs/migrating-from-langgraph)",
        "\\![Migration](/docs/migrating-from-langgraph)",
      )
      .replace(
        "[Read the demo transcript](docs/brand/demo/transcript.md)",
        "\\![Transcript](docs/brand/demo/transcript.md)",
      )
    assert.deepEqual(validateRootReadme(escapedImageMarkers), [])
  })

  it("requires a boundary after the canonical scaffold command", () => {
    assertFailure(
      validateRootReadme(
        rootReadme.replace(
          "npm create b4-app@latest my-agent",
          "npm create b4-app@latest my-agent-extra",
        ),
      ),
      /npm create b4-app@latest my-agent/,
    )
  })

  for (const [name, source, expected] of [
    [
      "canonical scaffold command",
      rootReadme.replace("npm create b4-app@latest my-agent", "pnpm create b4-app my-app"),
      /npm create b4-app@latest my-agent/,
    ],
    [
      "product-loop GIF",
      rootReadme.replace("docs/brand/product-loop.gif", "docs/brand/quickstart.gif"),
      /docs\/brand\/product-loop\.gif/,
    ],
    [
      "migration link",
      rootReadme.replace("/docs/migrating-from-langgraph", "/docs/getting-started"),
      /migrating-from-langgraph/,
    ],
    [
      "transcript link",
      rootReadme.replace("docs/brand/demo/transcript.md", "docs/brand/demo/notes.md"),
      /docs\/brand\/demo\/transcript\.md/,
    ],
  ]) {
    it(`requires the ${name}`, () => {
      assertFailure(validateRootReadme(source), expected)
    })
  }

  it("rejects the retired quickstart GIF caption", () => {
    assertFailure(
      validateRootReadme(
        `${rootReadme}\n\nB4.run quickstart — scaffold a route and invoke it in under a minute`,
      ),
      /old GIF caption/i,
    )
  })
})

describe("resolvePublicPackageTiers", () => {
  const entry = ["create-b4-app", "@b4run/sdk", "@b4run/cli"]
  const capability = [
    "@b4run/ag-ui",
    "@b4run/evals",
    "@b4run/inspector",
    "@b4run/memory",
    "@b4run/memory-pgvector",
    "@b4run/permissions",
    "@b4run/postgres-storage",
    "@b4run/sandbox",
    "@b4run/sqlite-storage",
    "@b4run/testing",
    "@b4run/workspace",
  ]
  const tooling = [
    "@b4run/core",
    "@b4run/langchain",
    "@b4run/langgraph",
    "@b4run/vite-plugin",
    "@b4run/devkit",
    "@b4run/config-biome",
    "@b4run/config-typescript",
  ]
  const publicPackages = [...entry, ...capability, ...tooling]

  it("accepts disjoint package tier definitions", () => {
    assert.doesNotThrow(() =>
      assertDisjointPackageTiers({
        entry: ["entry-package"],
        capability: ["capability-package"],
        tooling: ["tooling-package"],
      }),
    )
  })

  it("rejects a package classified in multiple tiers", () => {
    assert.throws(
      () =>
        assertDisjointPackageTiers({
          entry: ["shared-package"],
          capability: ["shared-package"],
          tooling: [],
        }),
      /Multiple classifications.*shared-package/,
    )
  })

  it("classifies the complete public release inventory", () => {
    assert.deepEqual(
      resolvePublicPackageTiers(publicPackages),
      Object.fromEntries([
        ...entry.map((name) => [name, "entry"]),
        ...capability.map((name) => [name, "capability"]),
        ...tooling.map((name) => [name, "tooling"]),
      ]),
    )
  })

  it("rejects unknown public packages", () => {
    assert.throws(
      () => resolvePublicPackageTiers([...publicPackages, "@b4run/unknown"]),
      /Unknown public package.*@b4run\/unknown/,
    )
  })

  it("rejects duplicate public packages", () => {
    assert.throws(
      () => resolvePublicPackageTiers([...publicPackages, "@b4run/sdk"]),
      /Duplicate public package.*@b4run\/sdk/,
    )
  })

  it("rejects an incomplete public release inventory", () => {
    assert.throws(
      () => resolvePublicPackageTiers(publicPackages.filter((name) => name !== "@b4run/sdk")),
      /Missing known public package.*@b4run\/sdk/,
    )
  })

  it("does not let caller-supplied tiers disguise an unknown package", () => {
    const alteredDefinitions = {
      entry: [...entry, "@b4run/unknown"],
      capability,
      tooling,
    }
    assert.throws(
      () => resolvePublicPackageTiers([...publicPackages, "@b4run/unknown"], alteredDefinitions),
      /Unknown public package.*@b4run\/unknown/,
    )
  })

  it("does not let caller-supplied tiers swap known package classifications", () => {
    const swappedDefinitions = {
      entry: entry.map((name) => (name === "@b4run/sdk" ? "@b4run/core" : name)),
      capability,
      tooling: tooling.map((name) => (name === "@b4run/core" ? "@b4run/sdk" : name)),
    }
    const tiers = resolvePublicPackageTiers(publicPackages, swappedDefinitions)
    assert.equal(tiers["@b4run/sdk"], "entry")
    assert.equal(tiers["@b4run/core"], "tooling")
  })
})

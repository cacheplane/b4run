import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import type { TemplateName } from "../templates.js"
import { resolveTemplateDir } from "../templates.js"
import { writeTemplate } from "../write-template.js"

export interface GeneratedAppSpecifiers {
  readonly b4AgUi: string
  readonly b4Cli: string
  readonly b4ConfigTypescript: string
  readonly b4Core: string
  readonly b4Evals: string
  readonly b4Inspector: string
  readonly b4Langchain: string
  readonly b4Sandbox: string
  readonly b4Sdk: string
  readonly b4Testing: string
}

export interface CreateGeneratedAppOptions {
  readonly appName: string
  readonly artifactRoot: string
  readonly specifiers?: Partial<GeneratedAppSpecifiers>
  readonly targetDir?: string
  readonly template: TemplateName
}

export interface GeneratedApp {
  readonly appName: string
  readonly appRoot: string
  readonly artifactRoot: string
  readonly template: TemplateName
  readonly templateDir: string
  readonly transcriptPath: string
}

export async function createGeneratedApp(
  options: CreateGeneratedAppOptions,
): Promise<GeneratedApp> {
  const templateDir = await resolveTemplateDir(options.template)
  const appRoot = resolve(options.targetDir ?? resolve(options.artifactRoot, "app"))
  const transcriptPath = resolve(options.artifactRoot, "transcripts", "generated-app.log")
  const specifiers = normalizeSpecifiers(options.specifiers)

  await mkdir(resolve(options.artifactRoot, "transcripts"), { recursive: true })
  await writeTemplate({
    replacements: {
      appName: options.appName,
      b4AgUiSpecifier: specifiers.b4AgUi,
      b4CliSpecifier: specifiers.b4Cli,
      b4ConfigTypescriptSpecifier: specifiers.b4ConfigTypescript,
      b4CoreSpecifier: specifiers.b4Core,
      b4EvalsSpecifier: specifiers.b4Evals,
      b4InspectorSpecifier: specifiers.b4Inspector,
      b4LangchainSpecifier: specifiers.b4Langchain,
      b4SandboxSpecifier: specifiers.b4Sandbox,
      b4SdkSpecifier: specifiers.b4Sdk,
      b4TestingSpecifier: specifiers.b4Testing,
    },
    targetDir: appRoot,
    templateDir,
  })

  return {
    appName: options.appName,
    appRoot,
    artifactRoot: options.artifactRoot,
    template: options.template,
    templateDir,
    transcriptPath,
  }
}

function normalizeSpecifiers(
  specifiers: Partial<GeneratedAppSpecifiers> | undefined,
): GeneratedAppSpecifiers {
  return {
    b4AgUi: specifiers?.b4AgUi ?? "workspace:*",
    b4Cli: specifiers?.b4Cli ?? "workspace:*",
    b4ConfigTypescript: specifiers?.b4ConfigTypescript ?? "workspace:*",
    b4Core: specifiers?.b4Core ?? "workspace:*",
    b4Evals: specifiers?.b4Evals ?? "workspace:*",
    b4Inspector: specifiers?.b4Inspector ?? "workspace:*",
    b4Langchain: specifiers?.b4Langchain ?? "workspace:*",
    b4Sandbox: specifiers?.b4Sandbox ?? "workspace:*",
    b4Sdk: specifiers?.b4Sdk ?? "workspace:*",
    b4Testing: specifiers?.b4Testing ?? "workspace:*",
  }
}

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, test } from "vitest"
import { writeTemplate } from "../src/write-template.ts"

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function makeTemplate(templateDir: string): Promise<void> {
  await writeFile(join(templateDir, "package.json.template"), '{"name":"{{appName}}"}', "utf8")
}

test("A1: writeTemplate writes replacement values containing $$ exactly as given (no collapse to a single $)", async () => {
  const target = await mkdtemp(join(tmpdir(), "check-"))
  const template = await mkdtemp(join(tmpdir(), "template-"))
  dirs.push(target, template)

  await makeTemplate(template)

  await writeTemplate({
    templateDir: template,
    targetDir: target,
    replacements: { appName: "my$$app" },
  })

  const content = await readFile(join(target, "package.json"), "utf8")
  assert.equal(content, '{"name":"my$$app"}')
})

test("A2: writeTemplate writes replacement values containing $& and similar patterns exactly as given (no interpretation)", async () => {
  const target = await mkdtemp(join(tmpdir(), "check-"))
  const template = await mkdtemp(join(tmpdir(), "template-"))
  dirs.push(target, template)

  await makeTemplate(template)

  await writeTemplate({
    templateDir: template,
    targetDir: target,
    replacements: { appName: "x$&y$`z$'w" },
  })

  const content = await readFile(join(target, "package.json"), "utf8")
  assert.equal(content, '{"name":"x$&y$`z$\'w"}')
})

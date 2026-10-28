import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import * as data from "../historical-publication-data.mjs"

test("historical data inventory permits only an entirely absent incident family", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "historical-data-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  assert.deepEqual(await data.discoverHistoricalPublicationData({ root }), [])
  await fs.mkdir(path.join(root, "scripts/release/historical-publications"), { recursive: true })

  await assert.rejects(data.discoverHistoricalPublicationData({ root }))
})

test("binary fixture reads preserve actual non-UTF8 ZIP bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "historical-bytes-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, "archive.zip")
  const bytes = Buffer.from([0x50, 0x4b, 0xff, 0xfe])
  await fs.writeFile(file, bytes)
  const { readBoundedFixtureBytes } = await import("../fixture-io.mjs")

  assert.deepEqual(await readBoundedFixtureBytes(file, { root }), bytes)
})

import { historicalFamilyFixture as familyFixture } from "./fixtures/historical-family.mjs"

test("optional authenticated historical data can be admitted through record-only bytes without source changes", async (t) => {
  const { root, files } = await familyFixture(t)

  const inventory = await data.discoverHistoricalPublicationData({ root })

  assert.deepEqual(inventory, [...files.keys()].sort())
})

for (const kind of [
  "malformed record",
  "manifest digest",
  "missing support",
  "unknown file",
  "symlink",
  "hardlink",
  "executable",
  "digest drift",
  "unknown directory",
]) {
  test(`historical admission rejects ${kind} without treating the family as absent`, async (t) => {
    const input = await familyFixture(t)
    const support = path.join(input.root, `${input.prefix}sweep-first.json`)
    if (kind === "malformed record") await fs.writeFile(input.recordPath, "{}\n")
    if (kind === "manifest digest")
      await fs.writeFile(path.join(input.root, data.HISTORICAL_PUBLICATION_MANIFEST_PATH), "{}\n")
    if (kind === "missing support") await fs.unlink(support)
    if (kind === "unknown file")
      await fs.writeFile(path.join(input.root, `${input.prefix}unknown.json`), "{}\n")
    if (kind === "symlink") {
      await fs.unlink(support)
      await fs.symlink(input.recordPath, support)
    }
    if (kind === "hardlink") await fs.link(support, path.join(input.root, "alias"))
    if (kind === "executable") await fs.chmod(support, 0o755)
    if (kind === "digest drift") await fs.writeFile(support, "changed\n")
    if (kind === "unknown directory") await fs.mkdir(path.join(input.root, `${input.prefix}nested`))

    await assert.rejects(data.discoverHistoricalPublicationData({ root: input.root }))
  })
}

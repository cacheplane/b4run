import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { parse } from "yaml"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const WORKFLOW = parse(await readFile(join(ROOT, ".github/workflows/release.yml"), "utf8"))
const ROUTE = WORKFLOW.jobs.tag.steps.find(
  (step) => step.name === "Continue at the exact tag or relay once",
)
const run = promisify(execFile)

// A stub curl that answers the tag's workflow-run listing from $RUNS_FIXTURE and
// records every dispatch POST in $DISPATCH_LOG.
const CURL_STUB = `#!/usr/bin/env bash
out=""; url=""; method=GET
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --request) method="$2"; shift 2 ;;
    --write-out|--header|--data) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$method" == POST ]]; then
  echo "$url" >> "$DISPATCH_LOG"
  : > "$out"
  printf '%s' "\${DISPATCH_STATUS:-200}"
else
  echo "$url" >> "$LIST_LOG"
  cp "$RUNS_FIXTURE" "$out"
  printf '%s' "\${LIST_STATUS:-200}"
fi
`

async function routeFromMain({ runs, listStatus = "200" }) {
  const dir = await mkdtemp(join(tmpdir(), "b4-route-"))
  try {
    await writeFile(join(dir, "curl"), CURL_STUB)
    await chmod(join(dir, "curl"), 0o755)
    await writeFile(join(dir, "runs.json"), JSON.stringify(runs))
    for (const name of ["out", "dispatch.log", "list.log"]) await writeFile(join(dir, name), "")
    const env = {
      PATH: `${dir}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: join(dir, "out"),
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "1".repeat(40),
      GITHUB_REPOSITORY: "cacheplane/b4run",
      GITHUB_TOKEN: "token",
      VERSION: "0.13.0",
      COMMIT_SHA: "4".repeat(40),
      EXECUTOR_SHA: "",
      NPM_BOOTSTRAP: "false",
      RUNS_FIXTURE: join(dir, "runs.json"),
      DISPATCH_LOG: join(dir, "dispatch.log"),
      LIST_LOG: join(dir, "list.log"),
      LIST_STATUS: listStatus,
    }
    let exitCode = 0
    try {
      await run("bash", ["-e", "-c", ROUTE.run], { env })
    } catch (error) {
      exitCode = error.code
    }
    const read = async (name) => (await readFile(join(dir, name), "utf8")).trim()
    return {
      exitCode,
      output: await read("out"),
      dispatches: (await read("dispatch.log")).split("\n").filter(Boolean),
      listings: (await read("list.log")).split("\n").filter(Boolean),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const tagRun = (status) => ({ id: 7, head_branch: "v0.13.0", event: "workflow_dispatch", status })

test("main does not relay while a run for the tag is still waiting", async () => {
  for (const status of ["queued", "pending", "waiting", "requested", "in_progress"]) {
    const result = await routeFromMain({
      runs: { total_count: 1, workflow_runs: [tagRun(status)] },
    })
    assert.equal(result.exitCode, 0, status)
    assert.deepEqual(result.dispatches, [], status)
    assert.equal(result.output, "continue=false", status)
  }
})

test("main relays once when every run for the tag has completed", async () => {
  const result = await routeFromMain({
    runs: { total_count: 1, workflow_runs: [tagRun("completed")] },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.dispatches.length, 1)
  assert.match(result.dispatches[0], /\/actions\/workflows\/.+\/dispatches$/u)
  assert.equal(result.output, "continue=false")
})

test("main relays once when the tag has no runs", async () => {
  const result = await routeFromMain({ runs: { total_count: 0, workflow_runs: [] } })
  assert.equal(result.exitCode, 0)
  assert.equal(result.dispatches.length, 1)
})

test("the waiting-run check lists only the release workflow's runs for the tag", async () => {
  const result = await routeFromMain({ runs: { total_count: 0, workflow_runs: [] } })
  assert.equal(result.listings.length, 1)
  const url = new URL(result.listings[0])
  assert.equal(
    url.pathname,
    "/repos/cacheplane/b4run/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs",
  )
  assert.equal(url.searchParams.get("branch"), "v0.13.0")
})

test("main fails instead of relaying when the tag's runs cannot be listed exactly", async () => {
  for (const [listStatus, runs] of [
    ["500", { total_count: 0, workflow_runs: [] }],
    ["200", { workflow_runs: [] }],
    ["200", { total_count: 2, workflow_runs: [tagRun("completed")] }],
    ["200", { total_count: 1, workflow_runs: [{ ...tagRun("completed"), head_branch: "main" }] }],
  ]) {
    const result = await routeFromMain({ runs, listStatus })
    assert.notEqual(result.exitCode, 0, JSON.stringify({ listStatus, runs }))
    assert.deepEqual(result.dispatches, [])
    assert.equal(result.output, "")
  }
})

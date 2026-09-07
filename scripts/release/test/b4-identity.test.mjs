import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { authorizeAuditExecutor } from "../audit-executor.mjs"
import { parseRecoveryPolicy } from "../recovery/policy.mjs"
import { auditExecutorFixture } from "./support/audit-executor-fixture.mjs"

test("B4.run recovery starts dormant without inherited contracts or verifier authorization", async () => {
  const policy = parseRecoveryPolicy(
    await readFile(new URL("../recovery/policy.json", import.meta.url)),
  )
  assert.equal(policy.status, "DORMANT")
  assert.equal(policy.verifierClosure.sha256, null)
  assert.deepEqual(policy.fence.contracts, [])
  assert.equal(policy.fence.concurrencyGroup, "b4-release-controller")
})

test("B4.run audit executor rejects the original repository even with otherwise valid evidence", async () => {
  const fixture = auditExecutorFixture()
  fixture.run.repository = { id: 1210070282, full_name: "cacheplane/dawnai" }
  await assert.rejects(authorizeAuditExecutor(fixture), /invalid main run identity/)
})

test("B4.run cannot use the historical v0.8.26 audit authorization", async () => {
  const fixture = auditExecutorFixture()
  fixture.run.repository = { id: 1360603908, full_name: "cacheplane/b4-run" }
  const historical = await readFile(
    new URL("../audit-executor-authorizations/v0.8.26.json", import.meta.url),
    "utf8",
  )
  fixture.files.set("scripts/release/audit-executor-authorizations/v0.8.26.json", historical)
  await assert.rejects(authorizeAuditExecutor(fixture), /invalid source authorization/)
})

test("historical release evidence and incident tools retain their exact original bytes", async () => {
  const { execFileSync } = await import("node:child_process")
  const { readHistoricalReleaseFile, HISTORICAL_RELEASE_REF } = await import(
    "./support/frozen-history.mjs"
  )
  const paths = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", HISTORICAL_RELEASE_REF, "scripts"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
  const preserved = paths.filter(
    (path) =>
      path.startsWith("scripts/security/") ||
      path === "scripts/deprecate-legacy-dawn-versions.sh" ||
      path === "scripts/release/terminal-recovery-adapters.mjs" ||
      /^scripts\/release\/(?:terminal-records|smoke-adjudications|recovery-adoptions|recovery-verifier-repairs|audit-executor-authorizations|recovery-fence-contracts|recovery-fence-evidence|recovery-platform-reviews)\//.test(
        path,
      ) ||
      /^scripts\/release\/(?:duplicate-draft|abandon-v0\.8\.22|recover-v0\.8\.22)/.test(path) ||
      /^scripts\/release\/test\/fixtures\/(?:incidents|recovery-legacy)\//.test(path) ||
      /^scripts\/release\/test\/fixtures\/(?:release-workflow-(?:disabled|protected)|recovery-contract-workflow(?:-current)?)\.yml$/.test(
        path,
      ),
  )
  assert.ok(preserved.length > 30)
  for (const path of preserved) {
    assert.deepEqual(await readFile(path), readHistoricalReleaseFile(path), path)
  }
})

// GET-only legacy exclusion proof. Production disable/enable remains an activation operation.

import { validateRecoveryVerifier } from "./authority.mjs"
import {
  FENCE_API_VERSION,
  FENCE_FIXTURES,
  fenceCanonical,
  fenceDigest,
  fenceExact,
  fenceParse,
  fenceRequire,
  fenceSame,
  fenceTerminalRuns,
  validateRecoveryFenceEvidence,
} from "./fence-evidence.mjs"
import {
  recoveryId,
  recoveryReadBudget,
  recoverySleep,
  runRecoveryAdapterRead,
} from "./invocation.mjs"
import {
  canonicalPolicyBytes,
  parseRecoveryPolicy,
  RECOVERY_POLICY_PATH,
  recoveryMethods,
} from "./policy.mjs"
import { parseRecovery, snapshotRecoveryData } from "./schema.mjs"

const CONTRACT_ROOT = "scripts/release/recovery-fence-contracts"
const EVIDENCE_ROOT = "scripts/release/recovery-fence-evidence"
const PLATFORM_REVIEW_ROOT = "scripts/release/recovery-platform-reviews"
const PLATFORM_SERVICES = Object.freeze({
  "dynamic/agents/copilot-pull-request-reviewer": "copilot-pull-request-reviewer",
  "dynamic/dependabot/dependabot-updates": "dependabot-updates",
})
const OWNER = ".github/workflows/release-postpublication.yml"
const AUDIT = ".github/workflows/release-postpublication-audit.yml"
const REQUIRED_WRITERS = [
  ".github/workflows/published-artifact-verify.yml",
  ".github/workflows/release.yml",
]
// Finite version-one graph: service probe plus witness projector and every local import.
// Task12 must update this reviewed list atomically if its source graph grows.
export const RECOVERY_FENCE_PROBE_INPUTS = Object.freeze([
  "scripts/release/adapter-normalize.mjs",
  "scripts/release/adapters/conditional-json.mjs",
  "scripts/release/adapters/github.mjs",
  "scripts/release/adapters/http.mjs",
  "scripts/release/adapters/npm.mjs",
  "scripts/release/limits.mjs",
  "scripts/release/recovery/fence-evidence.mjs",
  "scripts/release/recovery/invocation.mjs",
  "scripts/release/recovery/policy.mjs",
  "scripts/release/recovery/schema.mjs",
  "scripts/release/semver.mjs",
  "scripts/release/test/recovery-github.integration.mjs",
  "scripts/release/test/support/recovery-github-fence.mjs",
  "scripts/release/test/support/recovery-github-probe.mjs",
])
const PROBE_PATHS = new Set(RECOVERY_FENCE_PROBE_INPUTS)
const READ_ERROR_CODES = new Set([
  "ABORTED",
  "FORBIDDEN",
  "INCOMPLETE_INVENTORY",
  "MALFORMED_SCHEMA",
  "NETWORK_ERROR",
  "NOT_FOUND_OR_HIDDEN",
  "PAGINATION_LOOP",
  "RATE_LIMITED",
  "READ_TIMEOUT_UNSETTLED",
  "RECOVERY_DEADLINE",
  "RESPONSE_TOO_LARGE",
  "SERVER_ERROR",
  "TIMEOUT",
  "UNAUTHORIZED",
  "UNEXPECTED_STATUS",
])
const SHA = /^[a-f0-9]{40}$/u,
  HASH = /^[a-f0-9]{64}$/u
function path(value) {
  fenceRequire(
    typeof value === "string" &&
      value.length <= 512 &&
      /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) &&
      !value.split("/").some((part) => part === "." || part === ".."),
    "safe manifest path required",
  )
  fenceRequire(
    value !== RECOVERY_POLICY_PATH &&
      !value.startsWith(`${CONTRACT_ROOT}/`) &&
      !value.startsWith(`${EVIDENCE_ROOT}/`) &&
      !value.startsWith(`${PLATFORM_REVIEW_ROOT}/`) &&
      !value.startsWith("scripts/release/recovery-adoptions/") &&
      value !== "scripts/release/test/fixtures/release-script-hashes.json",
    "cyclic authority/pin manifest input forbidden",
  )
}
function manifest(entries, { probe = false } = {}) {
  fenceRequire(
    Array.isArray(entries) && entries.length <= 512 && (!probe || entries.length > 0),
    "bounded explicit manifest required",
  )
  let previous = ""
  for (const entry of entries) {
    fenceExact(entry, "path sha256")
    path(entry.path)
    fenceRequire(
      HASH.test(entry.sha256) && entry.path > previous && (!probe || PROBE_PATHS.has(entry.path)),
      "sorted unique supported manifest required",
    )
    previous = entry.path
  }
}
export function parseRecoveryFenceContract(raw) {
  const c = fenceParse(raw, 128 * 1024)
  fenceExact(
    c,
    "schemaVersion kind repository repositoryId candidateSourceSha mechanism apiVersion evidenceSha256 probeClosure fixtures topology",
  )
  fenceRequire(
    c.schemaVersion === 1 &&
      c.kind === "recovery-legacy-fence-contract" &&
      c.mechanism === "github-workflow-disable-v1" &&
      c.apiVersion === FENCE_API_VERSION,
    "supported reviewed fence contract required",
  )
  fenceRequire(
    typeof c.repository === "string" &&
      /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(c.repository) &&
      typeof c.repositoryId === "string" &&
      recoveryId(c.repositoryId) === c.repositoryId &&
      SHA.test(c.candidateSourceSha) &&
      HASH.test(c.evidenceSha256),
    "contract candidate identity required",
  )
  manifest(c.probeClosure, { probe: true })
  fenceSame(
    c.probeClosure.map((input) => input.path),
    RECOVERY_FENCE_PROBE_INPUTS,
    "complete supported probe/projector closure required",
  )
  fenceRequire(
    Array.isArray(c.fixtures) && c.fixtures.length === 2,
    "two reviewed fixture revisions required",
  )
  for (const [index, revision] of ["current", "historical"].entries()) {
    const fixture = c.fixtures[index]
    fenceExact(fixture, "revision path sha256")
    fenceRequire(
      fixture.revision === revision &&
        fixture.path === FENCE_FIXTURES[revision].path &&
        fixture.sha256 === FENCE_FIXTURES[revision].sha256,
      "fixed fixture contract required",
    )
  }
  fenceRequire(
    Array.isArray(c.topology) && c.topology.length >= 4 && c.topology.length <= 64,
    "complete bounded workflow topology required",
  )
  const ids = new Set()
  let previous = ""
  for (const entry of c.topology) {
    const platform = entry.disposition === "platform-nonwriter"
    fenceExact(
      entry,
      platform
        ? "workflowId workflow disposition service reviewSha256"
        : "workflowId workflow disposition sources",
    )
    fenceRequire(
      typeof entry.workflowId === "string" &&
        recoveryId(entry.workflowId) === entry.workflowId &&
        !ids.has(entry.workflowId),
      "unique canonical workflow ID required",
    )
    ids.add(entry.workflowId)
    fenceRequire(
      typeof entry.workflow === "string" &&
        (platform
          ? Object.hasOwn(PLATFORM_SERVICES, entry.workflow)
          : /^\.github\/workflows\/[a-z0-9][a-z0-9_-]*\.ya?ml$/u.test(entry.workflow)) &&
        entry.workflow > previous,
      "sorted unique workflow paths required",
    )
    previous = entry.workflow
    if (platform) {
      fenceRequire(
        entry.service === PLATFORM_SERVICES[entry.workflow] && HASH.test(entry.reviewSha256),
        "supported platform service and digest-addressed review required",
      )
      continue
    }
    fenceRequire(
      ["fenced-legacy", "nonwriter", "recovery-owner", "recovery-audit"].includes(
        entry.disposition,
      ) &&
        Array.isArray(entry.sources) &&
        entry.sources.length <= 64,
      "finite reviewed disposition/sources required",
    )
    if (["recovery-owner", "recovery-audit"].includes(entry.disposition)) {
      fenceRequire(
        entry.sources.length === 0 &&
          entry.workflow === (entry.disposition === "recovery-owner" ? OWNER : AUDIT),
        "separately admitted recovery identity required",
      )
      continue
    }
    fenceRequire(
      entry.workflow !== OWNER && entry.workflow !== AUDIT && entry.sources.length > 0,
      "reviewed source bindings required",
    )
    let last = ""
    let current = false
    let candidate = false
    let historical = false
    for (const source of entry.sources) {
      fenceExact(source, "source workflowSha256 executionInputs")
      fenceRequire(
        source.source && ["commit", "current-default"].includes(source.source.kind),
        "supported source selector required",
      )
      const key =
        source.source.kind === "commit" ? `commit:${source.source.sha}` : "current-default"
      fenceExact(source.source, source.source.kind === "commit" ? "kind sha" : "kind")
      if (source.source.kind === "commit") {
        fenceRequire(SHA.test(source.source.sha), "existing commit source required")
        historical = true
        candidate ||= source.source.sha === c.candidateSourceSha
      } else current = true
      fenceRequire(
        key > last && HASH.test(source.workflowSha256),
        "sorted unique source bindings required",
      )
      last = key
      manifest(source.executionInputs)
      fenceRequire(
        source.executionInputs.every((input) => input.path !== entry.workflow),
        "workflow bytes have one binding",
      )
    }
    fenceRequire(
      entry.disposition !== "nonwriter" || current,
      "nonwriter requires current-default source binding",
    )
    fenceRequire(
      entry.disposition !== "fenced-legacy" ||
        !REQUIRED_WRITERS.includes(entry.workflow) ||
        candidate,
      "mandatory fenced workflow requires candidate source binding",
    )
    fenceRequire(
      entry.disposition !== "fenced-legacy" || historical,
      "fenced workflow requires explicit historical commit binding",
    )
  }
  for (const workflow of REQUIRED_WRITERS)
    fenceRequire(
      c.topology.some(
        (entry) => entry.workflow === workflow && entry.disposition === "fenced-legacy",
      ),
      "mandatory legacy subsystem fencing required",
    )
  for (const [workflow, disposition] of [
    [OWNER, "recovery-owner"],
    [AUDIT, "recovery-audit"],
  ])
    fenceRequire(
      c.topology.some((entry) => entry.workflow === workflow && entry.disposition === disposition),
      "recovery topology identity required",
    )
  return c
}
// Scope belongs to reviewed controller code, never to the evidence record. Include
// all GitHub configuration and agent/editor inputs conservatively, at any depth.
function platformConfigurationPath(value) {
  const parts = value.split("/")
  return (
    parts.some((part) => [".github", ".agents", ".claude", ".copilot", ".vscode"].includes(part)) ||
    parts.at(-1) === "AGENTS.md" ||
    parts.at(-1) === "SKILL.md" ||
    /^(?:\.?mcp(?:[-.].*)?|copilot.*)\.(?:json|jsonc|ya?ml|md)$/iu.test(parts.at(-1))
  )
}
function platformReview(raw, contract, entry, now) {
  const r = fenceParse(raw, 128 * 1024)
  fenceExact(
    r,
    "schemaVersion kind repository repositoryId candidateSourceSha workflowId workflow service observedAt expiresAt rationale observations operationalAssumptions historicalRerunReasoning headControlledInputReasoning configuration",
  )
  fenceRequire(
    r.schemaVersion === 1 && r.kind === "recovery-platform-nonwriter-review",
    "supported platform review required",
  )
  for (const key of ["repository", "repositoryId", "candidateSourceSha"])
    fenceRequire(r[key] === contract[key], "platform review candidate identity mismatch")
  for (const key of ["workflowId", "workflow", "service"])
    fenceRequire(r[key] === entry[key], "platform review workflow identity mismatch")
  const validTime = () =>
    fenceRequire(
      Number.isSafeInteger(r.observedAt) &&
        r.observedAt >= 0 &&
        Number.isSafeInteger(r.expiresAt) &&
        r.observedAt <= now() &&
        now() < r.expiresAt &&
        r.expiresAt <= r.observedAt + 24 * 60 * 60 * 1000,
      "platform review outside bounded observation window",
    )
  validTime()
  const text = (value) =>
    fenceRequire(
      typeof value === "string" && value.trim().length > 0 && value.length <= 16384,
      "explicit platform review reasoning required",
    )
  // This is dated semantic evidence, not proof that assertions are true. Reviewers
  // must block on unobservable authority and account for historical and PR inputs.
  for (const key of ["rationale", "historicalRerunReasoning", "headControlledInputReasoning"])
    text(r[key])
  for (const key of ["observations", "operationalAssumptions"]) {
    fenceRequire(
      Array.isArray(r[key]) && r[key].length > 0 && r[key].length <= 64,
      "explicit platform observations and operational assumptions required",
    )
    for (const value of r[key]) text(value)
  }
  fenceRequire(
    Array.isArray(r.configuration) && r.configuration.length <= 512,
    "bounded platform configuration manifest required",
  )
  let previous = ""
  for (const input of r.configuration) {
    fenceExact(input, "path mode sha256")
    path(input.path)
    fenceRequire(
      input.path > previous &&
        platformConfigurationPath(input.path) &&
        ["100644", "100755"].includes(input.mode) &&
        HASH.test(input.sha256),
      "sorted supported platform configuration required",
    )
    previous = input.path
  }
  return { review: r, validTime }
}
function platformTree(raw) {
  fenceRequire(
    typeof raw === "string" &&
      raw.isWellFormed() &&
      Buffer.byteLength(raw) <= 16 * 1024 * 1024 &&
      (raw === "" || raw.endsWith("\0")),
    "complete bounded platform configuration tree required",
  )
  const entries = raw === "" ? [] : raw.slice(0, -1).split("\0")
  fenceRequire(entries.length <= 100000, "bounded platform configuration tree required")
  const seen = new Set(),
    relevant = []
  for (const line of entries) {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t([^\0]+)$/u.exec(line)
    // Reject unsupported modes anywhere: a submodule or symlink could conceal
    // configuration descendants, including applicable AGENTS.md files.
    fenceRequire(match, "unsupported or incomplete platform configuration tree entry")
    const [, mode, file] = match
    fenceRequire(
      !seen.has(file) &&
        !file.includes("\\") &&
        ![...file].some((char) => char.codePointAt(0) <= 31 || char.codePointAt(0) === 127) &&
        !file.split("/").some((part) => ["", ".", ".."].includes(part)),
      "unique exact platform configuration tree paths required",
    )
    seen.add(file)
    if (platformConfigurationPath(file)) relevant.push({ path: file, mode })
  }
  return relevant.sort((a, b) => (a.path < b.path ? -1 : 1))
}
// Independent workflows may overlap; every workflow retains its ordered double
// observation. Join all started work before returning a failure.
async function observeWorkflows(entries, observe) {
  let next = 0
  let failed = false
  const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (!failed && next < entries.length) {
      const entry = entries[next++]
      try {
        await observe(entry)
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  const results = await Promise.allSettled(workers)
  const failure = results.find((result) => result.status === "rejected")
  if (failure) throw failure.reason
}

export function createRecoveryFenceReader({ github, git, now = Date.now, sleep = recoverySleep }) {
  const reads = recoveryMethods(github, [
    "getRepository",
    "getRef",
    "listRepositoryWorkflowsComplete",
    "getWorkflowById",
    "listWorkflowRunsAllShasComplete",
  ])
  const source = recoveryMethods(git, ["showFile", "isAncestor"])
  return {
    async observeLegacyFence(request, options = {}) {
      const budget = recoveryReadBudget(
        { ...options, timeoutMs: Math.min(options.timeoutMs ?? 30000, 30000) },
        now,
      )
      request = snapshotRecoveryData(request, 16384)
      fenceExact(request, "candidate executor policySha256")
      const { candidate, executor, policySha256 } = request
      parseRecovery({
        schemaVersion: 2,
        kind: "recovery-adoption-intent",
        candidate,
        policySha256,
        legacyBodySha256: "0".repeat(64),
        legacyPhase: "NPM_COMPLETE",
        operations: ["adopt"],
      })
      fenceExact(executor, "controllerSha verifierClosureSha256 workflow runId runAttempt jobId")
      fenceRequire(
        SHA.test(executor.controllerSha) &&
          HASH.test(executor.verifierClosureSha256) &&
          executor.workflow === OWNER,
        "trusted owner executor required",
      )
      for (const key of ["runId", "runAttempt", "jobId"])
        fenceRequire(
          typeof executor[key] === "string" && recoveryId(executor[key]) === executor[key],
          "canonical executor identity required",
        )
      let sourceBytes = 0
      // Git objects are immutable. Share only exact SHA/path reads within this
      // observation; every logical read still consumes the original byte budget.
      const sourceCache = new Map()
      const show = async (ref, path, maximumBytes = 2 * 1024 * 1024) => {
        budget.options()
        fenceRequire(SHA.test(ref), "immutable source cache key required")
        const key = JSON.stringify([ref, path])
        if (!sourceCache.has(key))
          sourceCache.set(
            key,
            Promise.resolve().then(() => source.showFile({ ref, path }, budget.options())),
          )
        const raw = await sourceCache.get(key)
        budget.options()
        fenceRequire(
          typeof raw === "string" && raw.isWellFormed() && Buffer.byteLength(raw) <= maximumBytes,
          "bounded exact git bytes required",
        )
        sourceBytes += Buffer.byteLength(raw)
        fenceRequire(sourceBytes <= 16 * 1024 * 1024, "total git byte bound")
        return raw
      }
      const read = async (name, args = {}) => {
        let result
        try {
          result = await runRecoveryAdapterRead(budget, (options) => reads[name](args, options), {
            now,
            sleep,
          })
          budget.options()
        } catch {
          // Never include an adapter exception's API body, URL, or token text.
          fenceRequire(false, `${name} unavailable (ERROR/READ_FAILED)`)
        }
        const status = ["ABSENT", "AMBIGUOUS", "ERROR"].includes(result.status)
          ? result.status
          : "UNKNOWN"
        const code = READ_ERROR_CODES.has(result.code) ? result.code : "UNKNOWN"
        fenceRequire(result.status === "PRESENT", `${name} unavailable (${status}/${code})`)
        return snapshotRecoveryData(result.value, 8 * 1024 * 1024)
      }
      const rawPolicy = await show(executor.controllerSha, RECOVERY_POLICY_PATH, 128 * 1024)
      const policy = parseRecoveryPolicy(rawPolicy)
      fenceRequire(
        policy.status === "ADMITTED" && fenceDigest(canonicalPolicyBytes(policy)) === policySha256,
        "expected-controller policy binding required",
      )
      const verifierAdmission = await validateRecoveryVerifier(
        { candidate, controllerSha: executor.controllerSha, policy, rawPolicy },
        {
          showFile: ({ ref, path }) => show(ref, path),
          isAncestor: async (args) => {
            const result = await source.isAncestor(args, budget.options())
            budget.options()
            return result
          },
        },
      )
      fenceRequire(
        verifierAdmission.actualClosureSha256 === executor.verifierClosureSha256,
        "fence executor verifier closure differs",
      )
      const matches = []
      for (const digest of verifierAdmission.approvedContractDigests) {
        const raw = await show(
          executor.controllerSha,
          `${CONTRACT_ROOT}/${digest}.json`,
          128 * 1024,
        )
        fenceRequire(fenceDigest(raw) === digest, "contract locator digest mismatch")
        const contract = parseRecoveryFenceContract(raw)
        if (
          contract.repository === candidate.repository &&
          contract.repositoryId === candidate.repositoryId &&
          contract.candidateSourceSha === candidate.candidateSha
        )
          matches.push({ contract, contractSha256: digest })
      }
      fenceRequire(matches.length === 1, "exactly one approved candidate fence contract required")
      const { contract, contractSha256 } = matches[0]
      const verifyInputs = async (ref, entries) => {
        for (const entry of entries)
          fenceRequire(
            fenceDigest(await show(ref, entry.path)) === entry.sha256,
            "reviewed input bytes changed",
          )
        return fenceDigest(canonicalPolicyBytes(entries))
      }
      const probeClosureSha256 = await verifyInputs(executor.controllerSha, contract.probeClosure)
      const fixtureBytes = {}
      for (const fixture of contract.fixtures) {
        const raw = await show(executor.controllerSha, fixture.path)
        fenceRequire(fenceDigest(raw) === fixture.sha256, "reviewed fixture bytes changed")
        fixtureBytes[fixture.revision] = raw
      }
      const evidence = await show(
        executor.controllerSha,
        `${EVIDENCE_ROOT}/${contract.evidenceSha256}.json`,
        8 * 1024 * 1024,
      )
      fenceRequire(
        fenceDigest(evidence) === contract.evidenceSha256,
        "evidence locator digest mismatch",
      )
      validateRecoveryFenceEvidence(evidence, {
        fixtureBytes,
        probeClosureSha256,
      })
      const repository = async () => {
        const value = await read("getRepository")
        fenceRequire(
          value.full_name === candidate.repository &&
            recoveryId(value.id) === candidate.repositoryId &&
            value.default_branch === "main",
          "fresh production repository/default branch mismatch",
        )
        const ref = await read("getRef", { ref: "heads/main" })
        fenceRequire(
          ref.ref === "refs/heads/main" &&
            ref.object?.type === "commit" &&
            SHA.test(ref.object.sha),
          "fresh default branch SHA required",
        )
        return {
          repository: value.full_name,
          repositoryId: recoveryId(value.id),
          defaultBranch: value.default_branch,
          sha: ref.object.sha,
        }
      }
      const topology = async () => {
        const workflows = await read("listRepositoryWorkflowsComplete")
        fenceRequire(
          Array.isArray(workflows) && workflows.length === contract.topology.length,
          "exhaustive workflow mapping required",
        )
        const values = workflows
          .map((w) => ({
            workflowId: recoveryId(w.id),
            workflow: w.path,
            state: w.state,
          }))
          .sort((a, b) => (a.workflow < b.workflow ? -1 : a.workflow > b.workflow ? 1 : 0))
        fenceSame(
          values.map(({ workflowId, workflow }) => ({ workflowId, workflow })),
          contract.topology.map(({ workflowId, workflow }) => ({
            workflowId,
            workflow,
          })),
          "unknown or renamed workflow identity",
        )
        return values
      }
      const initialRepository = await repository(),
        initialTopology = await topology()
      const platformReviews = []
      const platformEntries = contract.topology.filter(
        (entry) => entry.disposition === "platform-nonwriter",
      )
      if (platformEntries.length) {
        const trees = recoveryMethods(git, ["listTreeEntries"])
        const tree = platformTree(
          await trees.listTreeEntries({ ref: initialRepository.sha }, budget.options()),
        )
        budget.options()
        for (const entry of platformEntries) {
          const raw = await show(
            executor.controllerSha,
            `${PLATFORM_REVIEW_ROOT}/${entry.reviewSha256}.json`,
            128 * 1024,
          )
          fenceRequire(
            fenceDigest(raw) === entry.reviewSha256,
            "platform review locator digest mismatch",
          )
          const checked = platformReview(raw, contract, entry, now)
          fenceSame(
            tree,
            checked.review.configuration.map(({ path, mode }) => ({
              path,
              mode,
            })),
            "platform configuration inventory changed",
          )
          await verifyInputs(initialRepository.sha, checked.review.configuration)
          platformReviews.push(checked)
        }
      }
      const writers = []
      await observeWorkflows(contract.topology, async (entry) => {
        const bindings = []
        for (const source of entry.sources ?? []) {
          const ref =
            source.source.kind === "current-default" ? initialRepository.sha : source.source.sha
          fenceRequire(
            ref !== executor.controllerSha || source.source.kind === "current-default",
            "contract-owning commit self-binding forbidden",
          )
          fenceRequire(
            fenceDigest(await show(ref, entry.workflow)) === source.workflowSha256,
            "workflow source bytes changed",
          )
          const executionClosureSha256 = await verifyInputs(ref, source.executionInputs)
          bindings.push({ sourceSha: ref, executionClosureSha256 })
        }
        if (entry.disposition !== "fenced-legacy") return
        const state = async () => {
          const value = await read("getWorkflowById", {
            workflowId: entry.workflowId,
          })
          fenceRequire(
            recoveryId(value.id) === entry.workflowId &&
              value.path === entry.workflow &&
              value.state === "disabled_manually",
            "legacy mutation authority not revoked",
          )
          return {
            workflowId: entry.workflowId,
            workflow: entry.workflow,
            state: value.state,
          }
        }
        const runs = async () =>
          fenceTerminalRuns(
            await read("listWorkflowRunsAllShasComplete", {
              workflowId: entry.workflowId,
            }),
            {
              ...candidate,
              workflowId: entry.workflowId,
              workflow: entry.workflow,
            },
          )
        const beforeState = await state(),
          beforeRuns = await runs(),
          afterState = await state(),
          afterRuns = await runs()
        fenceSame(beforeState, afterState, "workflow revocation changed")
        fenceSame(beforeRuns, afterRuns, "all-SHA drainage changed")
        for (const binding of bindings)
          writers.push({
            workflow: entry.workflow,
            sourceSha: binding.sourceSha,
            protection: "mutation-authority-revoked",
            proofSha256: fenceDigest(
              fenceCanonical({
                contractSha256,
                evidenceSha256: contract.evidenceSha256,
                binding,
                state: afterState,
                runs: afterRuns,
              }),
            ),
            activeRuns: [],
          })
      })
      const finalTopology = await topology(),
        finalRepository = await repository()
      fenceSame(initialTopology, finalTopology, "workflow topology changed during observation")
      fenceSame(
        initialRepository,
        finalRepository,
        "default branch/repository changed during observation",
      )
      budget.options()
      for (const review of platformReviews) review.validTime()
      // Collapse identical current/default commit selectors, preserving one proof per source.
      const unique = [
        ...new Map(writers.map((w) => [`${w.workflow}:${w.sourceSha}`, w])).values(),
      ].sort((a, b) =>
        a.workflow < b.workflow
          ? -1
          : a.workflow > b.workflow
            ? 1
            : a.sourceSha < b.sourceSha
              ? -1
              : a.sourceSha > b.sourceSha
                ? 1
                : 0,
      )
      fenceRequire(unique.length > 0 && unique.length <= 64, "bounded legacy writer proof required")
      return {
        contractSha256,
        candidate,
        executor,
        observedAt: budget.started,
        expiresAt: Math.min(
          budget.started + 30000,
          ...platformReviews.map(({ review }) => review.expiresAt),
        ),
        concurrencyGroup: policy.fence.concurrencyGroup,
        cancelInProgress: false,
        writers: unique,
        inventoryComplete: true,
      }
    },
  }
}

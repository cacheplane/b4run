import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"

import type { Reporter, TestProject, TestSpecification } from "vitest/node"

import { buildLinkedDists } from "./helpers/linked-dists.ts"

/** Cache paths only: this inventory never skips or replaces a build. */
async function distFiles(packages: readonly { dir: string }[]): Promise<string[]> {
  const files: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`Cannot invalidate non-regular dist entry: ${path}`)
    }
  }
  for (const { dir } of packages) {
    const dist = join(dir, "dist")
    if (!(await lstat(dist)).isDirectory()) {
      throw new Error(`Cannot invalidate non-regular dist root: ${dist}`)
    }
    await visit(dist)
  }
  return files.sort()
}

const preparationKind = "b4.cli.linked-dist-preparation.v1"

type PreparationReporter = Reporter & {
  readonly preparationKind: typeof preparationKind
  prepareInitial(project: TestProject): Promise<void>
  retire(): Promise<void>
  /** Read-only diagnostics for the admission regressions; never a readiness flag. */
  inspect(): Readonly<{
    readers: number
    signatures: number
    writer: boolean
    requestedRevision: number
    retiring: boolean
    terminal: boolean
  }>
}

function isPreparationReporter(value: unknown): value is PreparationReporter {
  return (
    typeof value === "object" &&
    value !== null &&
    "preparationKind" in value &&
    value.preparationKind === preparationKind &&
    "prepareInitial" in value &&
    typeof value.prepareInitial === "function"
  )
}

/** Installed by the owning project's public configureVitest hook, before reporters are created. */
export function installPreparationReporter(project: TestProject): void {
  const { vitest } = project
  if (vitest.config.reporters.some(isPreparationReporter)) {
    throw new Error("Linked dist preparation reporter installed more than once")
  }
  if (
    vitest.config.typecheck?.enabled ||
    vitest.projects.some((selected) => selected.config.typecheck?.enabled)
  ) {
    throw new Error("Linked dist preparation does not support Vitest typecheck runs")
  }

  let previous: readonly string[] = []
  let requestedRevision = 0
  let inFlight: Promise<void> | undefined
  // The public flight can reject terminal admission immediately; retirement must
  // still join the actual compiler work before a new context can write dist.
  let ownedWriter: Promise<void> | undefined
  // Retain even an undefined thrown value separately from writer ownership.
  // Only a later requested, fully successful preparation can reopen admission.
  let preparationFailure: { error: unknown } | undefined
  let terminalError: Error | undefined
  let rejectTerminal!: (error: Error) => void
  const terminal = new Promise<never>((_resolve, reject) => {
    rejectTerminal = reject
  })
  // A terminal event may have no current waiter. Keep its original rejection
  // handled while retaining the rejected promise for every later waiter.
  void terminal.catch(() => {})
  let retiring = false
  let initialPermit = true
  let rerunRegistered = false
  let readerCount = 0
  const zeroWaiters = new Set<() => void>()
  const projectIds = new Map<TestProject, number>()
  const leases = new Map<string, { members: readonly string[]; count: number }>()
  let failedStartup: { key: string; members: readonly string[] } | undefined

  function fail(message: string): never {
    if (!terminalError) {
      terminalError = new Error(message)
      rejectTerminal(terminalError)
    }
    throw terminalError
  }
  function checkTerminal(): void {
    if (terminalError) throw terminalError
  }
  function checkAdmission(): void {
    checkTerminal()
    if (retiring) throw new Error("Linked dist preparation context is retiring")
  }
  function members(specs: readonly TestSpecification[]): string[] {
    return specs
      .map((spec) => {
        let id = projectIds.get(spec.project)
        if (id === undefined) {
          id = projectIds.size
          projectIds.set(spec.project, id)
        }
        return JSON.stringify([id, spec.moduleId, spec.pool, spec.taskId])
      })
      .sort()
  }
  function waitForReaders(): Promise<void> {
    if (readerCount === 0) return Promise.resolve()
    let wake!: () => void
    const empty = new Promise<void>((resolve) => {
      wake = resolve
      zeroWaiters.add(wake)
    })
    return empty.finally(() => zeroWaiters.delete(wake))
  }
  function release(key: string): void {
    const lease = leases.get(key)
    if (!lease || lease.count < 1 || readerCount < 1) {
      fail("Linked dist reader lease underflow")
    }
    lease.count -= 1
    readerCount -= 1
    if (lease.count === 0) leases.delete(key)
    if (readerCount === 0) {
      for (const wake of zeroWaiters) wake()
      zeroWaiters.clear()
    }
  }
  function prepare(invalidate: boolean, initial = false): Promise<void> {
    checkAdmission()
    requestedRevision += 1
    if (inFlight) return inFlight

    // Publish synchronously, before either the reader wait or compiler starts.
    // An already admitted run keeps its lease and does not re-enter this gate.
    const work = Promise.resolve()
      .then(async () => {
        if (!initial) await Promise.race([waitForReaders(), terminal])
        checkTerminal()
        let builtRevision: number
        do {
          builtRevision = requestedRevision
          const packages = await buildLinkedDists()
          checkTerminal()
          const current = await distFiles(packages)
          checkTerminal()
          if (invalidate) {
            for (const path of [...new Set([...previous, ...current])].sort()) {
              vitest.invalidateFile(path)
            }
          }
          previous = current
        } while (builtRevision !== requestedRevision)
        // Release in this same turn as the final revision comparison. A rerun
        // queued during invalidation must publish its own writer after this point,
        // rather than join a successful flight whose loop has already finished.
        preparationFailure = undefined
        inFlight = undefined
      })
      .catch((error: unknown) => {
        if (!terminalError) preparationFailure = { error }
        throw error
      })
    ownedWriter = work
    void work
      .finally(() => {
        if (ownedWriter === work) ownedWriter = undefined
      })
      .catch(() => {})
    const flight = Promise.race([work, terminal]).finally(() => {
      if (inFlight === flight) inFlight = undefined
    })
    inFlight = flight
    return flight
  }

  const reporter: PreparationReporter = {
    preparationKind,
    inspect: () => ({
      readers: readerCount,
      signatures: leases.size,
      writer: inFlight !== undefined,
      requestedRevision,
      retiring,
      terminal: terminalError !== undefined,
    }),
    async retire() {
      retiring = true
      await ownedWriter?.catch(() => {})
      await waitForReaders()
      previous = []
      projectIds.clear()
    },
    async prepareInitial(setupProject) {
      // Vitest memoizes a failed setup. Its rerun hook must exist before any
      // cold build or ownership validation can reject.
      if (!rerunRegistered) {
        setupProject.onTestsRerun(async () => {
          await prepare(true)
        })
        rerunRegistered = true
      }
      if (!initialPermit) fail("Linked dist initial ownership permit already consumed")
      initialPermit = false
      checkAdmission()
      if (readerCount !== 1 || leases.size !== 1 || inFlight) {
        fail("Linked dist cold preparation requires exactly one pre-pool reader lease")
      }
      const startup = [...leases.entries()][0]
      if (!startup || startup[1].count !== 1) fail("Ambiguous linked dist startup lease")
      // onTestRunStart precedes globalSetup. No pool has run yet, so only this
      // single captured startup lease may be excluded from the cold writer wait.
      try {
        await prepare(false, true)
      } catch (error) {
        failedStartup = { key: startup[0], members: startup[1].members }
        throw error
      }
    },
    async onTestRunStart(specs) {
      checkAdmission()
      if (
        vitest.config.typecheck?.enabled ||
        specs.some((spec) => spec.project.config.typecheck?.enabled || spec.pool === "typecheck")
      ) {
        fail("Linked dist preparation does not support Vitest typecheck runs")
      }
      while (inFlight) {
        await inFlight
        checkAdmission()
      }
      if (preparationFailure) throw preparationFailure.error
      if (specs.length === 0) fail("Cannot admit an empty linked dist reader signature")
      const current = members(specs)
      const key = JSON.stringify(current)
      const lease = leases.get(key)
      if (lease) lease.count += 1
      else leases.set(key, { members: current, count: 1 })
      readerCount += 1
      // No await separates the final writer check from registering this lease.
    },
    onTestRunEnd(modules, _errors, reason) {
      const current = members(modules.map((module) => module.toTestSpecification()))
      const key = JSON.stringify(current)
      if (failedStartup) {
        // The only partial/empty-end exception is this coordinator's captured
        // cold failure, with no competing lease. Check a counted subset.
        const remaining = [...failedStartup.members]
        const subset = current.every((member) => {
          const index = remaining.indexOf(member)
          if (index < 0) return false
          remaining.splice(index, 1)
          return true
        })
        if (
          reason !== "failed" ||
          !subset ||
          readerCount !== 1 ||
          leases.get(failedStartup.key)?.count !== 1
        )
          fail("Cannot correlate failed linked dist startup end")
        release(failedStartup.key)
        failedStartup = undefined
        return
      }
      if (current.length === 0 || !leases.has(key)) {
        fail("Cannot correlate linked dist reader end; recreate the Vitest context")
      }
      // Equivalent simultaneous runs share a signature count, never a FIFO/run ID.
      release(key)
    },
  }

  vitest.config.reporters.push(reporter)
  // This PUBLIC listener is awaited before close/reinitialization (unlike the
  // reporter's onServerRestart notification). Old reporters still receive ends.
  // Vitest has no public unsubscribe. Its persistent listener retains only a
  // WeakRef, so old projects, graphs, and path inventories can be collected.
  const prior = new WeakRef(reporter)
  vitest.onServerRestart(() => prior.deref()?.retire())
}

export async function setup(project: TestProject): Promise<void> {
  const capabilities = project.vitest.config.reporters.filter(isPreparationReporter)
  if (capabilities.length !== 1) {
    const error = new Error("Expected exactly one linked dist preparation reporter")
    // A failed memoized setup must never turn a later run into an unprepared run.
    project.onTestsRerun(() => Promise.reject(error))
    throw error
  }
  const capability = capabilities[0]
  if (!capability) throw new Error("Missing linked dist preparation reporter")
  await capability.prepareInitial(project)
}

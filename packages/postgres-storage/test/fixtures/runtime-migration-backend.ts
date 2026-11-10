import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool, type PoolClient } from "pg"
import { getContainerRuntimeClient } from "testcontainers"
import type { SqlPool } from "../../src/sql.ts"

export const assetRoot = new URL(
  "../../../../test/agent-protocol/fixtures/runtime-v1/",
  import.meta.url,
)
export const fixtureManifest = JSON.parse(
  readFileSync(new URL("manifest.json", assetRoot), "utf8"),
) as {
  postgres: {
    path: string
    sha256: string
    identity: { installationId: string; generation: string; threadId: string; throughSeq: number }
    naming: { schema: string; tablePrefix: string }
    catalog: { objects: unknown[] }
    preservedRecords: Record<
      string,
      { columns: string[]; count: number; canonicalRowSHA256: string[] }
    >
    journal: { seq: number; eventId: string; payloadSHA256: string }[]
  }
}
export const expected = fixtureManifest.postgres
export const naming = expected.naming
export const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Non-JSON value in pinned fixture oracle")
  return encoded
}
export function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error("Invalid owned migration SQL identifier")
  return `"${value}"`
}
export const table = (name: string) =>
  `${identifier(naming.schema)}.${identifier(`${naming.tablePrefix}_${name}`)}`
const statusCode = (error: unknown) =>
  error !== null && typeof error === "object" && "statusCode" in error
    ? Number(error.statusCode)
    : undefined
export const legacyCatalogSQL = `
 SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity AS rls,
  (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
  (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
  (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid) AS indexes,
  (SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY pg_get_triggerdef(t.oid)) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
  (SELECT jsonb_agg(p.polname ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
 FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
 WHERE s.nspname=$1 AND left(c.relname,length($2)+1)=$2||'_' ORDER BY c.relname`

/** Same exact native query is used ONLY to prove marker self-consistency in the RED copy.
 * The future independent structural verifier must not trust this query as an oracle. */
export async function legacyCatalog(client: PoolClient) {
  return (await client.query(legacyCatalogSQL, [naming.schema, naming.tablePrefix])).rows
}
export async function readCopy(pool: Pool) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    await client.query("SET LOCAL search_path=pg_catalog")
    await client.query("SET LOCAL TimeZone='UTC'")
    await client.query("SET LOCAL bytea_output='hex'")
    const catalog = await legacyCatalog(client)
    const marker = (await client.query(`SELECT * FROM ${table("runtime_installation")}`)).rows[0]
    const records: Record<string, { count: number; canonicalRowSHA256: string[] }> = {}
    for (const [name, item] of Object.entries(expected.preservedRecords)) {
      const rows = (
        await client.query(
          `SELECT ${item.columns.map((column) => `${identifier(column)}::text AS ${identifier(column)}`).join(",")} FROM ${identifier(naming.schema)}.${identifier(name)}`,
        )
      ).rows
      records[name] = {
        count: rows.length,
        canonicalRowSHA256: rows.map((row) => sha(canonical(row))).sort(),
      }
    }
    const rawJournal = (
      await client.query(`SELECT seq::text,id,payload FROM ${table("journal")} ORDER BY seq`)
    ).rows
    const journal = rawJournal.map((row) => ({
      seq: Number(row.seq),
      eventId: row.id as string,
      payloadSHA256: sha(row.payload as string),
    }))
    await client.query("COMMIT")
    return { catalog, marker, records, journal }
  } catch (error) {
    try {
      await client.query("ROLLBACK")
    } catch (rollback) {
      throw new AggregateError([error, rollback], "Migration snapshot and rollback failed")
    }
    throw error
  } finally {
    client.release()
  }
}
export function recordingPool(pool: Pool, writes: string[]): SqlPool {
  const track = (sql: string) => {
    const verb = /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.exec(sql)?.[1]
    if (verb) writes.push(verb.toUpperCase())
  }
  return {
    async query<R>(sql: string, values?: readonly unknown[]) {
      track(sql)
      return { rows: (await pool.query(sql, values ? [...values] : undefined)).rows as R[] }
    },
    async connect() {
      const client = await pool.connect()
      return {
        async query<R>(sql: string, values?: readonly unknown[]) {
          track(sql)
          return { rows: (await client.query(sql, values ? [...values] : undefined)).rows as R[] }
        },
        release() {
          client.release()
        },
      }
    },
    async end() {
      /* Caller owns the actual default Pool and joins it explicitly. */
    },
  }
}

export function migrationBackend() {
  const nonce = process.env.B4_PROTOCOL_PG_RESOURCE_ID ?? randomUUID()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce))
    throw new Error("Migration resource nonce must be a UUID")
  const name = `b4-migration-${nonce}`,
    volumeName = `${name}-data`,
    target = "/var/lib/postgresql/data"
  const label = { "org.b4run.protocol-resource": name }
  const prefix = `r9m_${nonce.slice(0, 8)}`
  const nominated = process.env.B4_PROTOCOL_MIGRATION_EVIDENCE
  if (nominated !== undefined && (!isAbsolute(nominated) || existsSync(nominated)))
    throw new Error("Nominated private migration evidence path must be unique and absolute")
  const directory = nominated ?? mkdtempSync(join(tmpdir(), "b4-migration-evidence-"))
  if (nominated) mkdirSync(directory, { mode: 0o700 })
  chmodSync(directory, 0o700)
  const save = (file: string, data: unknown) =>
    writeFileSync(join(directory, file), `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    })
  type ParentReady = {
    status: string
    nonce: string
    engineId: string
    containerName: string
    volumeName: string
    resourceLabel: string
    eventHTTPStatus: number
    containerHTTPStatus: number
    volumeHTTPStatus: number
    parentPid: number
    observerPid: number
    readyToken: string
    intentSHA256: string
    reaperProfile: string
    localHostProcess: boolean
  }
  let parentReady: ParentReady | undefined,
    parentReadySHA256: string | undefined,
    parentReadyDirectory: string | undefined
  let docker:
    | Awaited<ReturnType<typeof getContainerRuntimeClient>>["container"]["dockerode"]
    | undefined
  let container: StartedPostgreSqlContainer | undefined,
    control: Pool | undefined,
    containerId = "",
    volumeCreated = false,
    counter = 0
  const activeCases = new Set<string>(),
    poolErrors: { name: string; code: string | null }[] = []
  const track = (pool: Pool) => {
    const observe = (error: Error & { code?: string }) =>
      poolErrors.push({ name: error.name, code: error.code ?? null })
    pool.on("error", observe)
    pool.on("connect", (client) => client.on("error", observe))
    return pool
  }
  async function absent(kind: "container" | "volume", id: string) {
    if (!docker) throw new Error("Migration runtime client absent")
    try {
      await (kind === "container"
        ? docker.getContainer(id).inspect()
        : docker.getVolume(id).inspect())
    } catch (error) {
      if (statusCode(error) === 404) return 404
      throw new Error("Owned migration absence inspection failed")
    }
    throw new Error("Exact migration resource unexpectedly exists")
  }
  async function inspectOwned() {
    if (!docker || !containerId) throw new Error("Missing exact migration container identity")
    const raw = await docker.getContainer(containerId).inspect()
    const mount = raw.Mounts.filter((item) => item.Type === "volume")
    if (
      raw.Id !== containerId ||
      raw.Name !== `/${name}` ||
      raw.Config.Labels["org.b4run.protocol-resource"] !== name ||
      raw.Mounts.length !== 1 ||
      mount.length !== 1 ||
      mount[0]?.Name !== volumeName ||
      mount[0]?.Destination !== target ||
      !mount[0]?.RW
    )
      throw new Error(
        "Current migration container/name/nonce/mount identity mismatch; mutation refused",
      )
    return {
      id: raw.Id,
      name: raw.Name,
      imageId: raw.Image,
      resourceLabel: name,
      mounts: mount.map((item) => ({
        name: item.Name,
        destination: item.Destination,
        type: item.Type,
        rw: item.RW,
      })),
    }
  }
  return {
    async start() {
      let stage:
        | "gated-profile"
        | "pristine-bytes"
        | "parent-readiness"
        | "runtime-client"
        | "engine-info"
        | "same-engine"
        | "precreate-absence"
        | "volume-create"
        | "volume-handle"
        | "volume-inspect"
        | "volume-identity"
        | "container-start"
        | "fixture-copy"
        | "native-tools"
        | "control-pool" = "gated-profile"
      try {
        if (process.env.B4_TEST_PGSTORAGE !== "1")
          throw new Error("Migration requires explicitly gated real PostgreSQL lane")
        stage = "pristine-bytes"
        const pristine = new URL(expected.path, assetRoot)
        if (sha(readFileSync(pristine)) !== expected.sha256)
          throw new Error("Pinned native SQL bytes changed")
        save("before-create-intent.json", {
          nonce,
          name,
          volumeName,
          target,
          label,
          image: "postgres:16",
          naming,
          poolMax: "unmodified default10",
        })
        stage = "parent-readiness"
        const parentReadyPath = process.env.B4_PROTOCOL_MIGRATION_PARENT_READY_FILE
        const parentReadySHA = process.env.B4_PROTOCOL_MIGRATION_PARENT_READY_SHA256
        if ((parentReadyPath === undefined) !== (parentReadySHA === undefined))
          throw new Error("Incomplete local migration parent readiness")
        if (parentReadyPath !== undefined && parentReadySHA !== undefined) {
          // Refuse the local profile BEFORE runtime resolution can create support resources.
          if (process.env.TESTCONTAINERS_RYUK_DISABLED !== "true" || existsSync("/.dockerenv"))
            throw new Error(
              "Local observed migration requires exact no-Ryuk native-host profile before TC resolution",
            )
          if (!isAbsolute(parentReadyPath) || !/^[0-9a-f]{64}$/.test(parentReadySHA))
            throw new Error("Invalid exact local parent readiness path/hash")
          const bytes = readFileSync(parentReadyPath)
          if (sha(bytes) !== parentReadySHA)
            throw new Error("Exact independent parent readiness bytes changed")
          const ready = JSON.parse(bytes.toString("utf8")) as ParentReady
          if (
            ready.status !== "READY_BEFORE_CHILD_LAUNCH" ||
            ready.nonce !== nonce ||
            ready.containerName !== name ||
            ready.volumeName !== volumeName ||
            ready.resourceLabel !== name ||
            ready.eventHTTPStatus !== 200 ||
            ready.containerHTTPStatus !== 404 ||
            ready.volumeHTTPStatus !== 404 ||
            !Number.isSafeInteger(ready.parentPid) ||
            ready.parentPid <= 0 ||
            !Number.isSafeInteger(ready.observerPid) ||
            ready.observerPid <= 0 ||
            typeof ready.engineId !== "string" ||
            !ready.engineId ||
            typeof ready.readyToken !== "string" ||
            !ready.readyToken ||
            !/^[0-9a-f]{64}$/.test(ready.intentSHA256) ||
            ready.reaperProfile !== "disabled" ||
            ready.localHostProcess !== true
          )
            throw new Error(
              "Independent local parent is not ready for exact resources/profile before TC resolution",
            )
          parentReady = ready
          parentReadySHA256 = parentReadySHA
          parentReadyDirectory = dirname(parentReadyPath)
        }
        // Public installed TC client and PostgreSqlContainer use the SAME daemon strategy/cache.
        // Ordinary gated CI without a local ready profile retains its existing TC behavior.
        stage = "runtime-client"
        docker = (await getContainerRuntimeClient()).container.dockerode
        stage = "engine-info"
        const info = await docker.info()
        stage = "same-engine"
        if (parentReady) {
          if (parentReady.engineId !== info.ID)
            throw new Error(
              "Independent observer and public TC selected different actual engines; no creation permitted",
            )
          save("actual-parent-readiness-consumed.json", {
            readySHA256: parentReadySHA256,
            actualTCEngineId: info.ID,
            nonce,
            parentPid: parentReady.parentPid,
            observerPid: parentReady.observerPid,
            checkedBeforeAnyCreate: true,
            reaperProfile: "disabled",
            localHostProcess: true,
          })
        }
        stage = "precreate-absence"
        await absent("container", name)
        await absent("volume", volumeName)
        stage = "volume-create"
        // Dockerode5 returns a Volume handle in both branches. Its installed
        // public callback overload also types the handle correctly; the Promise
        // overload in installed @types4 describes the inspect payload instead.
        const createdHandle = await new Promise<
          ReturnType<NonNullable<typeof docker>["getVolume"]>
        >((resolve, reject) => {
          docker!.createVolume({ Name: volumeName, Labels: label }, (error, handle) => {
            if (error) {
              reject(error)
              return
            }
            volumeCreated = true
            if (handle === undefined) {
              reject(new Error("Named migration volume handle absent after create acknowledgment"))
              return
            }
            resolve(handle)
          })
        })
        stage = "volume-handle"
        if (createdHandle.name !== volumeName)
          throw new Error("Named migration volume handle identity mismatch")
        stage = "volume-inspect"
        const created = await createdHandle.inspect()
        stage = "volume-identity"
        if (created.Name !== volumeName || created.Labels?.["org.b4run.protocol-resource"] !== name)
          throw new Error("Named migration volume create receipt mismatch")
        save("created-volume.json", {
          name: created.Name,
          resourceLabel: name,
          driver: created.Driver,
          engineId: info.ID,
        })
        class OwnedContainer extends PostgreSqlContainer {
          protected override async containerCreated(id: string) {
            containerId = id
            const owned = await inspectOwned()
            save("created-container.json", owned)
            if (parentReady && parentReadyDirectory) {
              // Independent capture must precede successful start, within unchanged startup180/before240.
              const capturePath = join(parentReadyDirectory, "observer-container-captured.json")
              const deadline = performance.now() + 15_000
              while (!existsSync(capturePath) && performance.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 50))
              if (!existsSync(capturePath))
                throw new Error(
                  "Independent exact container/mount capture not acknowledged before start",
                )
              const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
                status: string
                nonce: string
                readyToken: string
                intentSHA256: string
                engineId: string
                container: typeof owned
                volumeName: string
                resourceLabel: string
              }
              if (
                capture.status !== "EXACT_CONTAINER_AND_VOLUME_CAPTURED_BEFORE_START" ||
                capture.nonce !== nonce ||
                capture.readyToken !== parentReady.readyToken ||
                capture.intentSHA256 !== parentReady.intentSHA256 ||
                capture.engineId !== info.ID ||
                capture.volumeName !== volumeName ||
                capture.resourceLabel !== name ||
                canonical(capture.container) !== canonical(owned)
              )
                throw new Error("Independent before-start exact ID/mount acknowledgment mismatch")
              save("actual-parent-capture-consumed.json", {
                captureSHA256: sha(readFileSync(capturePath)),
                containerId,
                readySHA256: parentReadySHA256,
                checkedBeforeStartReturned: true,
              })
            }
          }
        }
        stage = "container-start"
        container = await new OwnedContainer("postgres:16")
          .withName(name)
          .withLabels(label)
          .withBindMounts([{ source: volumeName, target, mode: "rw" }])
          .withStartupTimeout(180_000)
          .start()
        if (container.getId() !== containerId)
          throw new Error("Started migration container differs from before-ready identity")
        await inspectOwned()
        stage = "fixture-copy"
        await container.copyFilesToContainer([
          { source: fileURLToPath(pristine), target: "/tmp/b4-runtime-v1.sql" },
        ])
        const copied = await container.exec(["cat", "/tmp/b4-runtime-v1.sql"])
        if (copied.exitCode !== 0 || copied.stderr !== "" || sha(copied.stdout) !== expected.sha256)
          throw new Error("Native SQL file-copy byte prerequisite failed")
        stage = "native-tools"
        const version = await container.exec(["psql", "--version"])
        if (version.exitCode !== 0 || !/PostgreSQL\) 16\./.test(version.stdout))
          throw new Error("Expected actual native psql16 test engine")
        save("native-tools.json", { psql: version.stdout.trim() })
        stage = "control-pool"
        control = track(
          new Pool({
            connectionString: container.getConnectionUri(),
            application_name: `${prefix}_control`,
          }),
        )
        if (control.options.max !== 10)
          throw new Error("Control pool must use unmodified default max10")
      } catch (error) {
        // Deliberately no error message/stack/custom name/code, query, DSN,
        // native payload or provider data in this additional setup diagnostic.
        const errorClass =
          error instanceof TypeError
            ? "TypeError"
            : error instanceof RangeError
              ? "RangeError"
              : error instanceof SyntaxError
                ? "SyntaxError"
                : error instanceof AggregateError
                  ? "AggregateError"
                  : error instanceof Error
                    ? "Error"
                    : "NonError"
        save("startup-failure.json", {
          nonce,
          stage,
          errorClass,
          volumeCreateAcknowledged: volumeCreated,
          containerIdObserved: containerId !== "",
          startedContainerReturned: container !== undefined,
          controlPoolCreated: control !== undefined,
        })
        throw error
      }
    },
    async withCopy<T>(body: (first: Pool, second: Pool) => Promise<T>): Promise<T> {
      if (!container || !control) throw new Error("Owned migration fixture not ready")
      const database = `r9_migration_${++counter}`
      const appNames: [string, string] = [`${prefix}_${counter}_a`, `${prefix}_${counter}_b`]
      await control.query(`CREATE DATABASE ${identifier(database)}`)
      activeCases.add(database)
      const restored = await container.exec([
        "psql",
        "--no-password",
        "--username",
        container.getUsername(),
        "--dbname",
        database,
        "--single-transaction",
        "--set",
        "ON_ERROR_STOP=1",
        "--file",
        "/tmp/b4-runtime-v1.sql",
      ])
      save(`case-${counter}-native-restore.private.json`, {
        exitCode: restored.exitCode,
        stdout: restored.stdout,
        stderr: restored.stderr,
      })
      if (restored.exitCode !== 0)
        throw new Error(
          "Native psql fixture restore failed; exact owned DB retained, private diagnostics recorded",
        )
      const uri = new URL(container.getConnectionUri())
      uri.pathname = `/${database}`
      const first = track(
          new Pool({ connectionString: uri.toString(), application_name: appNames[0] }),
        ),
        second = track(
          new Pool({ connectionString: uri.toString(), application_name: appNames[1] }),
        )
      let value: T | undefined, failure: unknown
      let failed = false
      const cleanup: unknown[] = []
      const dropOwnedCopyAfterBackendClosure = async (control: Pool) => {
        const remaining = Number(
          (
            await control.query(
              "SELECT count(*) AS count FROM pg_stat_activity WHERE application_name=ANY($1::text[])",
              [appNames],
            )
          ).rows[0].count,
        )
        if (remaining !== 0)
          throw new Error("Known migration SQL app backends remain; DB removal refused")
        await control.query(`DROP DATABASE ${identifier(database)}`)
        activeCases.delete(database)
        save(`case-${counter}-closed.json`, {
          database,
          actualNamedAppBackendCountBeforeDrop: remaining,
          bothPoolsEnded: true,
          databaseNormallyDropped: true,
        })
      }
      try {
        if (first.options.max !== 10 || second.options.max !== 10)
          throw new Error("App pools must use unmodified default max10")
        const acquired = await Promise.allSettled([first.connect(), second.connect()])
        const held = acquired.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []))
        try {
          if (acquired[0]?.status !== "fulfilled" || acquired[1]?.status !== "fulfilled")
            throw new Error("Independent migration checkout failed")
          const identities = await Promise.allSettled(
            held.map((client) =>
              client.query("SELECT pg_backend_pid() AS pid,current_database() AS database"),
            ),
          )
          if (identities[0]?.status !== "fulfilled" || identities[1]?.status !== "fulfilled")
            throw new Error("Independent migration backend identity query failed")
          const a = identities[0].value.rows[0],
            b = identities[1].value.rows[0]
          if (a.pid === b.pid || a.database !== database || b.database !== database)
            throw new Error(
              "Two default migration pools must have distinct backends in the SAME restored DB",
            )
          save(`case-${counter}-pools.json`, {
            database,
            firstPID: a.pid,
            secondPID: b.pid,
            firstMax: first.options.max,
            secondMax: second.options.max,
            appNames,
          })
        } finally {
          for (const client of held) client.release()
        }
        value = await body(first, second)
      } catch (error) {
        failed = true
        failure = error
      } finally {
        const ended = await Promise.allSettled([first.end(), second.end()])
        for (const result of ended) if (result.status === "rejected") cleanup.push(result.reason)
        if (!cleanup.length) {
          try {
            await dropOwnedCopyAfterBackendClosure(control)
          } catch (error) {
            cleanup.push(error)
          }
        }
      }
      if (failed || cleanup.length)
        throw new AggregateError(
          [...(failed ? [failure] : []), ...cleanup],
          "Migration copy case or normal cleanup failed",
        )
      return value as T
    },
    async finish() {
      const errors: unknown[] = []
      if (activeCases.size)
        errors.push(new Error("Owned migration DB/case work remains; container stop refused"))
      if (poolErrors.length) errors.push(new Error("Observed migration pool/client errors"))
      let controlEnded = false,
        nativeCount: number | undefined,
        beforeControlCount: number | undefined
      let controlPID: number | undefined,
        firstVerifierPID: number | undefined,
        lastVerifierPID: number | undefined
      if (control) {
        try {
          const checked = (
            await control.query(
              `SELECT pg_backend_pid() AS pid,(SELECT count(*) FROM pg_stat_activity WHERE left(application_name,$1)=$2 AND application_name<>$3) AS count`,
              [prefix.length, prefix, `${prefix}_control`],
            )
          ).rows[0]
          beforeControlCount = Number(checked.count)
          controlPID = Number(checked.pid)
          if (beforeControlCount !== 0)
            errors.push(new Error("Known named SQL app backends remain before control end"))
        } catch (error) {
          errors.push(error)
        }
        try {
          await control.end()
          controlEnded = true
        } catch (error) {
          errors.push(error)
        }
      }
      if (container && controlEnded && !errors.length) {
        try {
          const result = await container.exec([
            "psql",
            "--no-password",
            "--username",
            container.getUsername(),
            "--dbname",
            container.getDatabase(),
            "--tuples-only",
            "--no-align",
            "--command",
            `SELECT pg_backend_pid(),(SELECT count(*) FROM pg_stat_activity WHERE left(application_name,${prefix.length})='${prefix}')`,
          ])
          const native = result.stdout.trim().split("|").map(Number)
          firstVerifierPID = native[0]
          nativeCount = native[1]
          if (result.exitCode !== 0 || !Number.isSafeInteger(firstVerifierPID) || nativeCount !== 0)
            throw new Error(
              "Independent native migration backend closure proof failed; stop refused",
            )
          const last = await container.exec([
            "psql",
            "--no-password",
            "--username",
            container.getUsername(),
            "--dbname",
            container.getDatabase(),
            "--tuples-only",
            "--no-align",
            "--command",
            `SELECT pg_backend_pid(),(SELECT count(*) FROM pg_stat_activity WHERE pid=${firstVerifierPID})`,
          ])
          const closed = last.stdout.trim().split("|").map(Number)
          lastVerifierPID = closed[0]
          if (last.exitCode !== 0 || !Number.isSafeInteger(lastVerifierPID) || closed[1] !== 0)
            throw new Error("First native closure verifier remains; stop refused")
          save("before-stop-identity.json", await inspectOwned())
          await container.stop({ timeout: 10_000, remove: true, removeVolumes: false })
          await absent("container", containerId)
          await absent("container", name)
        } catch (error) {
          errors.push(error)
        }
      } else if (containerId && !errors.length)
        errors.push(
          new Error(
            "Startup did not yield a normally joined started container; preserve exact identity for parent containment",
          ),
        )
      if (volumeCreated && !errors.length) {
        try {
          await absent("container", name)
          if (!docker) throw new Error("Missing exact owned Docker client")
          const volume = await docker.getVolume(volumeName).inspect()
          if (volume.Name !== volumeName || volume.Labels?.["org.b4run.protocol-resource"] !== name)
            throw new Error("Current migration volume identity mismatch; removal refused")
          await docker.getVolume(volumeName).remove({ force: false })
          await absent("volume", volumeName)
        } catch (error) {
          errors.push(error)
        }
      }
      save("normal-closure.json", {
        nonce,
        containerId,
        name,
        volumeName,
        activeCases: [...activeCases],
        controlEnded,
        actualNamedBackendCountBeforeControlEnd: beforeControlCount ?? null,
        controlPID: controlPID ?? null,
        actualNamedBackendCountAfterControlEnd: nativeCount ?? null,
        firstNativeVerifierPID: firstVerifierPID ?? null,
        lastNativeVerifierPID: lastVerifierPID ?? null,
        lastVerifierBound:
          "Native exec returned exit0; final container404 bounds last verifier. No recursive global backend claim.",
        poolErrors,
        errorCount: errors.length,
        exactResources404: errors.length === 0 && volumeCreated,
      })
      if (errors.length)
        throw new AggregateError(
          errors,
          "Migration owned resource cleanup incomplete; preserve exact scope",
        )
      if (sha(readFileSync(new URL(expected.path, assetRoot))) !== expected.sha256)
        throw new Error("Pinned SQL original changed after tests")
    },
  }
}

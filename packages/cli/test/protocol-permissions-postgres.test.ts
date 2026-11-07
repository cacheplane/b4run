import type { RememberedRuleIntent } from "@b4run/permissions"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { Pool } from "pg"
import { describe, expect, it } from "vitest"
import {
  createPostgresPermissionsStore,
  postgresRuntimeStorage,
} from "../../postgres-storage/dist/node.js"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createPermissionService, parkPermissions } from "../src/lib/runtime/permissions.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

describe.skipIf(process.env.B4_TEST_PGSTORAGE !== "1")(
  "native PostgreSQL permission composition",
  () => {
    it("rolls back actual rule receipt I/O, retries the accepted Run, and never re-adds a later removed rule", async () => {
      const container = await new PostgreSqlContainer("postgres:16")
        .withStartupTimeout(180_000)
        .start()
      const pool = new Pool({ connectionString: container.getConnectionUri() })
      const errors: Error[] = []
      pool.on("error", (error) => errors.push(error))
      pool.on("connect", (client) => client.on("error", (error) => errors.push(error)))
      let f: Awaited<ReturnType<typeof fixture>> | undefined,
        host: ReturnType<typeof createExecutionHost> | undefined
      try {
        f = await fixture(
          postgresRuntimeStorage({ pool, schema: "r6_runtime", tablePrefix: "b4_ap_v1_native" }),
        )
        const accepted = await f.admit(body({ on_completion: "keep" }))
        let rules = createPostgresPermissionsStore({
          pool,
          schema: "r6_rules",
          tablePrefix: "rules",
        })
        const permissions = createPermissionService({
          ...f.authority,
          grants: "required",
          resolvePermissions: async () => rules,
        })
        let effects = 0
        host = createExecutionHost({
          storage: f.storage,
          permissions,
          async invoke({ run, store }) {
            if (run.run.run_id === accepted.runId)
              await store.transaction((tx) =>
                parkPermissions(
                  tx,
                  run.run.run_id,
                  [
                    {
                      interruptId: "native-prompt",
                      namespace: [],
                      request: {
                        kind: "tool",
                        detail: { toolName: "effect", suggestedPattern: "effect" },
                      },
                      protectedProposal: { value: 1 },
                    },
                  ],
                  "required",
                ),
              )
            else {
              expect(rules.match("tool", "effect")).toBe("allow")
              effects++
            }
            return {}
          },
        })
        await host.tick()
        await host.idle()
        const paused = await f.snapshot(accepted.threadId)
        const command = {
          id: 1,
          method: "input.respond",
          params: {
            namespace: [],
            interruptId: "native-prompt",
            response: { decision: "always", grant: paused.pending[0]?.input.data.b4.grant },
            metadata: {
              b4: {
                v: 1,
                submissionId: crypto.randomUUID(),
                expected: {
                  generation: paused.scope.generation,
                  runId: accepted.runId,
                  pausedGeneration: paused.thread?.pausedGeneration,
                },
              },
            },
          },
        }
        const continuation = await permissions.respond(
          f.request(),
          accepted.threadId,
          accepted.runId,
          command,
        )
        expect(rules.match("tool", "effect")).toBe("unknown")
        const intent = (
          (await f.snapshot(accepted.threadId)).inbox.find((entry) => entry.kind === "rule_intent")
            ?.payload as { intent: RememberedRuleIntent } | undefined
        )?.intent
        if (!intent) throw new Error("Missing committed native rule intent")
        // A different store instance must prove the actual same rule scope.
        rules = createPostgresPermissionsStore({ pool, schema: "r6_rules", tablePrefix: "rules" })
        await pool.query(
          "CREATE FUNCTION r6_rules.fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected permission receipt write'; END $$",
        )
        await pool.query(
          "CREATE TRIGGER fail_receipt BEFORE INSERT OR UPDATE ON r6_rules.rules_perm_rules FOR EACH ROW EXECUTE FUNCTION r6_rules.fail_receipt()",
        )
        await expect(host.tick()).rejects.toThrow("injected permission receipt write")
        let snapshot = await f.snapshot(accepted.threadId)
        expect(
          snapshot.runs.find((row) => row.run.run_id === continuation.runId)?.metadata,
        ).toMatchObject({ phase: "accepted" })
        expect(
          snapshot.runs.find((row) => row.run.run_id === continuation.runId)?.metadata.startedAt,
        ).toBeUndefined()
        expect(effects).toBe(0)
        expect(
          (
            await pool.query(
              "SELECT * FROM r6_rules.rules_permissions WHERE tool='tool' AND pattern='effect'",
            )
          ).rows,
        ).toEqual([])
        await pool.query("DROP TRIGGER fail_receipt ON r6_rules.rules_perm_rules")
        await host.tick()
        await host.idle()
        snapshot = await f.snapshot(accepted.threadId)
        expect(snapshot.runs).toHaveLength(2)
        expect(
          snapshot.runs.find((row) => row.run.run_id === continuation.runId)?.metadata.phase,
        ).toBe("settled")
        expect(effects).toBe(1)
        await pool.query(
          "DELETE FROM r6_rules.rules_permissions WHERE tool='tool' AND pattern='effect'",
        )
        expect(await rules.rememberedRules?.apply(intent)).toBe("applied")
        expect(rules.match("tool", "effect")).toBe("unknown")
        expect(
          (await permissions.respond(f.request(), accepted.threadId, accepted.runId, command))
            .runId,
        ).toBe(continuation.runId)
        await host.tick()
        await host.idle()
        expect(effects).toBe(1)
        expect(
          (
            await pool.query(
              "SELECT * FROM r6_rules.rules_permissions WHERE tool='tool' AND pattern='effect'",
            )
          ).rows,
        ).toEqual([])
      } finally {
        try {
          await host?.close()
        } finally {
          try {
            await f?.close()
          } finally {
            try {
              await pool.end()
            } finally {
              const id = container.getId()
              await container.stop()
              process.stdout.write(`R6 removed own native composition container ${id}\n`)
            }
          }
        }
      }
      expect(errors).toEqual([])
    }, 240_000)
  },
)

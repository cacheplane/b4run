import { afterEach, beforeEach, expect, test, vi } from "vitest"

const controlled = vi.hoisted(() => ({
  calls: [] as string[],
  postgresStartError: undefined as Error | undefined,
  proxyStartError: undefined as Error | undefined,
  proxyStopError: undefined as Error | undefined,
  postgresStopError: undefined as Error | undefined,
}))

vi.mock("@testcontainers/postgresql", () => ({
  PostgreSqlContainer: class {
    withName() {
      return this
    }
    withLabels() {
      return this
    }
    withNetwork() {
      return this
    }
    withNetworkAliases() {
      return this
    }
    withCommand() {
      return this
    }
    withStartupTimeout() {
      return this
    }
    async start() {
      controlled.calls.push("postgres.start")
      if (controlled.postgresStartError) throw controlled.postgresStartError
      return {
        getId: () => "unit-postgres",
        logs: async () => ({ on: () => undefined }),
        stop: async () => {
          controlled.calls.push("postgres.stop")
          if (controlled.postgresStopError) throw controlled.postgresStopError
        },
      }
    }
  },
}))

vi.mock("testcontainers", () => ({
  Network: class {
    async start() {
      controlled.calls.push("network.start")
      return {
        getId: () => "unit-network",
        stop: async () => {
          controlled.calls.push("network.stop")
        },
      }
    }
  },
  GenericContainer: class {
    withName() {
      return this
    }
    withLabels() {
      return this
    }
    withNetwork() {
      return this
    }
    withEnvironment() {
      return this
    }
    withExposedPorts() {
      return this
    }
    withWaitStrategy() {
      return this
    }
    withStartupTimeout() {
      return this
    }
    async start() {
      controlled.calls.push("proxy.start")
      if (controlled.proxyStartError) throw controlled.proxyStartError
      return {
        getId: () => "unit-proxy",
        stop: async () => {
          controlled.calls.push("proxy.stop")
          if (controlled.proxyStopError) throw controlled.proxyStopError
        },
      }
    }
  },
  Wait: { forListeningPorts: () => ({}) },
}))

import { startEdgeContainers } from "./helpers/hono-edge-fixture.ts"

beforeEach(() => {
  // UUIDv4 job identifiers can never equal this unit-only all-zero scope.
  // Fake resource records must not become outer observer ownership evidence.
  vi.stubEnv("B4_PROTOCOL_PG_RESOURCE_ID", "protocol-00000000000000000000000000000000")
  controlled.calls.length = 0
  controlled.postgresStartError = undefined
  controlled.proxyStartError = undefined
  controlled.proxyStopError = undefined
  controlled.postgresStopError = undefined
})

afterEach(() => {
  vi.unstubAllEnvs()
})

test("Postgres startup failure closes the already-started network", async () => {
  const startupError = new Error("controlled Postgres startup failure")
  controlled.postgresStartError = startupError

  await expect(startEdgeContainers()).rejects.toBe(startupError)

  expect(controlled.calls).toEqual(["network.start", "postgres.start", "network.stop"])
})

test("proxy startup failure closes Postgres and network while preserving its original error", async () => {
  const startupError = new Error("controlled proxy startup failure")
  controlled.proxyStartError = startupError
  controlled.postgresStopError = new Error("controlled Postgres teardown failure")
  const secondaryFailure = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    await expect(startEdgeContainers()).rejects.toBe(startupError)

    expect(controlled.calls).toEqual([
      "network.start",
      "postgres.start",
      "proxy.start",
      "postgres.stop",
      "network.stop",
    ])
    expect(secondaryFailure).toHaveBeenCalledTimes(1)
    expect(secondaryFailure.mock.calls[0]?.[0]).toBe("R8_EDGE_CLEANUP_FAILURE")
    const record = JSON.parse(String(secondaryFailure.mock.calls[0]?.[1]))
    expect(record).toEqual({
      resourceId: "protocol-00000000000000000000000000000000",
      fixtureId: expect.stringMatching(/^[a-f0-9]{32}$/),
      stage: "postgres.stop",
      name: expect.stringMatching(/^b4-edge-[a-f0-9]{32}-postgres$/),
      failureCount: 1,
    })
  } finally {
    secondaryFailure.mockRestore()
  }
})

test("normal stop attempts every resource and reports a teardown failure", async () => {
  const teardownError = new Error("controlled proxy teardown failure")
  controlled.proxyStopError = teardownError
  const containers = await startEdgeContainers()

  const failure = await containers.stop().then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(controlled.calls).toEqual([
    "network.start",
    "postgres.start",
    "proxy.start",
    "proxy.stop",
    "postgres.stop",
    "network.stop",
  ])
  expect(
    failure === teardownError ||
      (failure instanceof AggregateError && failure.errors.includes(teardownError)),
  ).toBe(true)
})

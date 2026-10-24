import { existsSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

function dependencyRequire(
  parent: ReturnType<typeof createRequire>,
  name: string,
): ReturnType<typeof createRequire> {
  const manifest = parent.resolve
    .paths(name)
    ?.map((directory) => join(directory, name, "package.json"))
    .find(existsSync)
  if (!manifest) throw new Error(`Missing installed dependency ${name}`)
  return createRequire(realpathSync(manifest))
}

function hostingRequire(): ReturnType<typeof createRequire> {
  let owner = createRequire(new URL("../../examples/chat/web/package.json", import.meta.url))
  for (const name of [
    "@copilotkit/runtime",
    "@copilotkit/channels-intelligence",
    "@copilotkit/channels-teams",
    "@microsoft/agents-hosting",
  ]) {
    owner = dependencyRequire(owner, name)
  }
  return owner
}

interface Schema {
  safeParse(value: unknown): { success: boolean }
}

interface TokenProvider {
  sysOptions: Record<string, unknown>
  getAccessToken(config: Record<string, string>, scope: string): Promise<string>
}

describe("patched private integration dependency owners", () => {
  it("validates Microsoft activity records with the installed Zod replacement", () => {
    const owner = hostingRequire()
    const activity = owner("@microsoft/agents-activity") as { activityZodSchema: Schema }
    expect(
      activity.activityZodSchema.safeParse({
        type: "message",
        text: "fixture",
        semanticAction: {
          id: "fixture",
          state: "start",
          entities: { fixture: { type: "thing", extra: "preserved" } },
        },
      }).success,
    ).toBe(true)
    expect(activity.activityZodSchema.safeParse({ type: 42 }).success).toBe(false)
  })

  it("preserves CopilotKit tool JSON Schema constraints with the installed Zod replacement", () => {
    const example = createRequire(new URL("../../examples/chat/web/package.json", import.meta.url))
    const owner = dependencyRequire(example, "@copilotkit/react-core")
    const shared = dependencyRequire(owner, "@copilotkit/shared")("@copilotkit/shared") as {
      schemaToJsonSchema(schema: unknown, options: { zodToJsonSchema: unknown }): unknown
    }
    const { z } = owner("zod") as typeof import("zod")
    const { zodToJsonSchema } = owner("zod-to-json-schema") as { zodToJsonSchema: unknown }
    expect(
      shared.schemaToJsonSchema(
        z.object({ message: z.string().min(1), tags: z.array(z.string()).min(1).max(3) }),
        { zodToJsonSchema },
      ),
    ).toMatchObject({
      type: "object",
      properties: {
        message: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
      },
      required: ["message", "tags"],
    })
  })

  it("exercises the hosting owner's real MSAL client-credential flow without network", async () => {
    const owner = hostingRequire()
    const { MsalTokenProvider } = owner("@microsoft/agents-hosting") as {
      MsalTokenProvider: {
        new (): TokenProvider
        clearSharedCaches(): void
      }
    }
    const msal = dependencyRequire(owner, "@azure/msal-node")
    const msalManifest = JSON.parse(
      readFileSync(join(msal.resolve("@azure/msal-node"), "../../package.json"), "utf8"),
    ) as { version: string }
    expect(msalManifest.version).toBe("7.1.0")
    const provider = new MsalTokenProvider()
    const posts: { url: string; body: string }[] = []
    const authority = "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001"
    provider.sysOptions.networkClient = {
      async sendGetRequestAsync(url: string) {
        expect(url.startsWith("https://login.microsoftonline.com/")).toBe(true)
        return {
          status: 200,
          headers: {},
          body: url.includes("/discovery/instance")
            ? {
                tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,
                metadata: [
                  {
                    preferred_network: "login.microsoftonline.com",
                    preferred_cache: "login.microsoftonline.com",
                    aliases: ["login.microsoftonline.com"],
                  },
                ],
              }
            : {
                authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
                token_endpoint: `${authority}/oauth2/v2.0/token`,
                end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
                issuer: `${authority}/v2.0`,
                jwks_uri: `${authority}/discovery/v2.0/keys`,
              },
        }
      },
      async sendPostRequestAsync(url: string, options: { body: string }) {
        posts.push({ url, body: options.body })
        return {
          status: 200,
          headers: {},
          body: {
            access_token: "local-fixture-token",
            token_type: "Bearer",
            expires_in: 3600,
            ext_expires_in: 3600,
          },
        }
      },
    }
    MsalTokenProvider.clearSharedCaches()
    try {
      const token = await provider.getAccessToken(
        {
          clientId: "00000000-0000-0000-0000-000000000002",
          clientSecret: "local-fixture-secret",
          authority,
        },
        "https://api.botframework.com",
      )
      expect(token).toBe("local-fixture-token")
      expect(posts).toHaveLength(1)
      const tokenUrl = new URL(posts[0]?.url ?? "")
      expect(`${tokenUrl.origin}${tokenUrl.pathname}`).toBe(`${authority}/oauth2/v2.0/token`)
      expect(tokenUrl.searchParams.get("client-request-id")).toMatch(/^[0-9a-f-]{36}$/)
      const body = new URLSearchParams(posts[0]?.body)
      expect(body.get("grant_type")).toBe("client_credentials")
      expect(body.get("scope")).toContain("https://api.botframework.com/.default")
    } finally {
      MsalTokenProvider.clearSharedCaches()
    }
  })
})

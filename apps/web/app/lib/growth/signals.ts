import { PostHog } from "posthog-node"
import type { EmailKind } from "./email"

export interface ServerSignalClient {
  capture(input: {
    distinctId: string
    event: "site:contact_accepted"
    properties: { form: "founder_updates"; email_kind: EmailKind }
  }): Promise<void>
}

export function createPosthogServerClient(key: string): ServerSignalClient {
  const client = new PostHog(key, {
    host: "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 3000,
  })
  return {
    async capture({ distinctId, event, properties }) {
      try {
        client.capture({
          distinctId,
          event,
          properties: {
            form: properties.form,
            email_kind: properties.email_kind,
            $process_person_profile: false,
          },
          disableGeoip: true,
        })
        await client.flush()
      } catch {
        // A failed signal must never fail a form submission; nothing identifying is logged.
      }
    },
  }
}

export function noopSignalClient(): ServerSignalClient {
  return { async capture() {} }
}

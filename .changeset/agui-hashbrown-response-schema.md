---
"@b4run/langchain": patch
"@b4run/cli": patch
"@b4run/sdk": patch
---

Apply a client-supplied `hashbrown.responseSchema` on the AG-UI run body to the route's root model, or reject the run. `POST /agui/:routeId` used to accept the field and read nothing from it, so a Hashbrown client that expected the final message to match its UI schema got an unconstrained model and found out only when a reply failed to parse. On an `agent` route the schema is now bound as the provider's native schema-constrained output alongside the route's tools — OpenAI `response_format` (`json_schema`, `strict: true`) and Anthropic `output_config.format` — so tool-calling turns are untouched and only the final message is constrained. A malformed schema, a non-agent route, or a provider with no such mode is refused with `422` and the new `B4_E5402` (`invalid_response_schema` / `response_schema_not_supported`) before any run side effect. Runs without the field are unchanged. `@b4run/langchain` gains `JsonSchemaResponseFormat`, `createChatModel({ responseFormat })`, `streamAgent({ responseFormat })` and the `JSON_SCHEMA_RESPONSE_FORMAT_PROVIDERS` list.

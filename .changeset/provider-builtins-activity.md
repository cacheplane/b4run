---
"@b4run/sdk": patch
"@b4run/langchain": patch
"@b4run/ag-ui": patch
---

Normalize provider-owned tool activity and answer annotations without converting
native provider history into app function calls. Preserve display steps and
citations on canonical assistant messages and restore them through AG-UI.

Add provider-keyed `agent().builtInTools` options for supported OpenAI, Anthropic
and Google capabilities. Google routes now use the optional `@langchain/google`
integration rather than `@langchain/google-genai`, with a retaining adapter for
native streaming parts and grounding attribution. Replace the old Google
dependency and use LangChain core 1.2.18 or a compatible version. Applications
must render Google Search Suggestions unchanged. File search remains deferred,
and Anthropic fetch/code execution remain disabled.

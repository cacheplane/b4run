---
"@b4run/langchain": patch
---

The missing model provider error (`B4_E4001`) now suggests the install command for the package manager that launched the process (`npm install`, `pnpm add`, `yarn add` or `bun add`, read from `npm_config_user_agent`), defaulting to `npm install` instead of always printing `pnpm add`.

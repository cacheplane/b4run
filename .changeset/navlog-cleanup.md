---
"@b4run/devkit": patch
"create-b4-app": patch
---

A structure pass on the navlog template.
- **Layout:** `WorkbenchLayout` keeps the state both layouts share and renders `DesktopWorkbench` or `PhoneWorkbench`; one `useElementHeight` hook replaces two.
- **Shell:** `AppShell` composes hooks in `app/lib/` (server status, run errors, drop notices, thread switch, thread titles), and `MemoryPanel` reads its data through `useMemoryCandidates`.
- **Styles:** `app/theme.css` is now the entry for one stylesheet per part of the app in `app/styles/`, with the palette in `styles/tokens.css`.
- **Removed:** the markdown planning-brief fallback (pre-structured-answer threads still render in the chat), test-only exports, and unused POH distance helpers.
- **Lib:** the advisories and winds parsers move out of `weather-selectors.ts`, verdict types live in `verdict.ts`, the eval's scripted runs move to `navlog-quality.fixtures.ts`, and the server's flight category moves to `src/lib/`.

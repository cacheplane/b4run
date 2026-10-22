---
"@b4run/inspector": patch
"@b4run/cli": patch
"@b4run/vite-plugin": patch
"@b4run/devkit": patch
"create-b4-app": patch
---

Update the Inspector to Next.js 16.4.1, the CLI's development dependencies to Hono ^4.13.11 and its Node adapter ^2.1.3, and Vite tooling to 6.4.4. These updates include upstream fixes for Next.js cache/image-processing vulnerabilities and static-path access-control issues in Hono and Vite. The documentation site, web examples, and generated navlog applications use the same patched Next.js version.

These CLI test dependencies do not impose new runtime minimums on existing applications. Refresh and audit application lockfiles separately to consume patched upstream dependencies.

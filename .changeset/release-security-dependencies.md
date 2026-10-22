---
"@b4run/inspector": patch
"@b4run/cli": patch
"@b4run/vite-plugin": patch
"@b4run/devkit": patch
"create-b4-app": patch
---

Update the Inspector to Next.js 16.4.1, the CLI's minimum Hono version to 4.13.11 and its Node adapter minimum to 2.1.3, and Vite tooling to 6.4.4. These updates include upstream fixes for Next.js cache/image-processing vulnerabilities and static-path access-control issues in Hono and Vite. The documentation site, web examples, and generated navlog applications use the same patched Next.js version.

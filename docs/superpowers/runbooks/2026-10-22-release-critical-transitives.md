# Critical transitive prerequisites for B4.run 0.15.0

The October 22 lockfile audit after the Next/Hono/Vite prerequisite found five
critical advisory records across four transitive packages. Do not treat passing
CI or the repaired historical security suite as a clean vulnerability audit.

| Package | Before | Patched lock | Affected owner |
| --- | --- | --- | --- |
| `dompurify` | 3.4.13 | 3.4.17 | Website PostHog and Mermaid paths |
| `proxy-addr` | 2.0.7 | 2.0.8 | Express in example MCP and private registry paths |
| `handlebars` | 4.7.9 | 4.7.10 | Private Verdaccio hooks |
| `tar` | 7.5.7 | 7.5.22 | Private Vercel CLI tooling |

Primary advisory records:
[DOMPurify](https://github.com/advisories/GHSA-cg2g-xh64-v4q7),
[proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h),
[Handlebars AST](https://github.com/advisories/GHSA-8r5x-fm3f-whwj),
[Handlebars property checks](https://github.com/advisories/GHSA-p8wg-vrv2-v86f),
and [tar](https://github.com/advisories/GHSA-23hp-3jrh-7fpw).
These are affected-version findings, not demonstrations of application exploitability.

DOMPurify and proxy-addr resolve within existing owner ranges. The private
`@vercel/fun` and `@verdaccio/hooks` owners pin exact vulnerable versions, so
root overrides target only those two owner edges. Neither override changes a
published package's dependency contract. Remove them when the private owner
updates consume the patched versions. Existing reviewed compiler implementation
6.0.2 and unrelated dependency resolutions remain unchanged.

The four added patched-floor expectations failed against all four old versions
before the repair. Frozen installation and all 23 dependency graph tests pass;
security TypeScript checking passes. The resulting lock diff is limited to these
four packages, their incoming references and the two override declarations.

Fresh audit results after the patch:

- Full workspace: 0 critical, 67 high, 64 moderate, 18 low.
- Production selection: 0 critical, 37 high, 27 moderate, 4 low.

These counts describe the audit response at preparation time and are not a
promise that the dependency tree has no vulnerabilities. The owner subsequently required remediation of the remaining high production
findings before release; the completion evidence below supersedes these counts.
Require independent review and fresh hosted gates before merging this patch;
regenerate the 0.15.0 candidate only after all selected prerequisites land.

## Expanded production remediation

The 37 high production records were traced to ten package names. Compatible
owner ranges now resolve fast-uri 3.1.8, js-yaml 3.15.2/4.3.2, Undici
6.28.1/7.29.1/8.10.2, Axios 1.20.0, Fastify busboy 3.2.2, source-map-js 1.2.2,
MCP SDK 1.32.0 and follow-redirects 1.16.1. GraphQL Yoga 5.24.6 and
its defer-stream plugin 3.24.6 consume patched GraphQL utilities 12.1.0 through
their own declared ranges. CopilotKit owner versions and published dependency
contracts remain unchanged. No public-owner override is retained.

The private website upgrades remark-mdx-frontmatter from 5 to 6, replacing its
obsolete TOML 3 parser with smol-toml. The site configures YAML frontmatter;
the actual MDX pipeline, metadata exports, content index, feed and SEO tests
exercise that behavior. Unrelated Sass, Rolldown/Yuku and compiler refreshes
from dependency resolution were removed. The TypeScript wrapper remains 6.0.2.

Final narrowed graph verification on October 22:

- Production audit: **0 critical, 0 high, 11 moderate, 1 low**.
- Full workspace audit: **0 critical, 27 high, 44 moderate, 11 low**.
- Frozen installation passes, with zero unresolved snapshot references.
- Dependency graph and installed Mermaid chain: 33 tests pass.
- Website MDX/content/blog/SEO checks: 155 tests pass.
- Full workspace build: 29 tasks pass. Typecheck: 59 tasks pass.
- Release-integrity checks: 33 pass. Scoped repository lint passes.
- Independent review found no blocking graph, owner-range or frontmatter issue.

These counts are a fresh registry response, not a permanent security guarantee.
Moderate/low production findings and development-only high findings remain open.
The entire committed security suite and hosted CI, including Windows collection,
CopilotKit/browser runtime and the real Vercel boundary, must pass before merge.

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
promise that the dependency tree has no vulnerabilities. The owner is deciding
whether the remaining high production findings expand this release's scope.
Require independent review and fresh hosted gates before merging this patch;
regenerate the 0.15.0 candidate only after all selected prerequisites land.

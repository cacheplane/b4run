# Development and private production dependency remediation

This follow-up starts from main `014918499a9093852f045d3a477cf77dd53ac8d8`
after the immutable 0.15.2 release. It addresses the remaining high development
and moderate production advisories. The original checkout's existing edits are
preserved; implementation uses an isolated, previously clean worktree.

## Audit evidence

| Selection | Baseline | Remediated frozen graph |
| --- | --- | --- |
| Full workspace, including development | 26 high, 45 moderate, 13 low, zero critical | Zero critical/high/moderate, two low |
| Production selection | 12 moderate, three low, zero high/critical | Zero critical/high/moderate, one low |

The full audit SHA-256 is
`3a12b61e88d25878e13405922cdd2e6d3859e27fbb14a03f31cb42c6607d78f8`.
The production audit SHA-256 is
`59de95ef22c1d2b6e921ca42d171455ee756b6cafd76c1cad4e4645d223c334a`.
The final lock SHA-256 is
`22412f0783468365aff75260071cfe9e905bf6ae72b5d64eeccdcc6968d5e5bd`.

Raw baseline and final audit JSON, exact registry metadata, rejected resolver
output, owner graph and red/green logs are retained as
`/private/tmp/b4run-security-followup-*` and
`/private/tmp/b4run-security-development-owner-*` in the task workspace.
`pnpm audit` still exits 1 for the retained low findings; its JSON, rather than
exit status alone, supplies these severity counts. No advisory suppression,
ignored advisory or audit-source substitution was introduced.

The remaining low findings are KaTeX 0.16.47
([GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7))
in the private CopilotKit web path, and development-only `@tootallnate/once`
2.0.0 ([GHSA-vpq2-c234-7xj6](https://github.com/advisories/GHSA-vpq2-c234-7xj6))
in Vercel's function tooling. The audit selections describe this workspace;
root policies do not impose dependency resolution on independent consumers.

## Resolved owners and versions

| Family | Final resolution and owner |
| --- | --- |
| Undici / Busboy | Vercel and its Node builder: 5.28.4/5.29.0 → 6.29.1; vulnerable Busboy 2 disappears; remaining GraphQL fetch owner uses Busboy 3.2.2 |
| minimatch / braces | Vercel Python analysis: minimatch 10.2.6; actual glob owners retain their supported brace majors at 1.1.21, 2.1.7 and 5.0.12 |
| Vercel routing / configuration | path-to-regexp 8.4.2, smol-toml 1.9.1 and static-config Ajv 8.20.0 |
| Native image processing | Root and Wrangler/Miniflare converge on Sharp 0.35.5 and one native library generation |
| Docker tooling | Dockerode's grpc-js 1.14.6 |
| Local registry | Verdaccio 6.11.1, compression 1.8.2 and cache dependency http-cache-semantics 4.3.0 |
| Browser/test tooling | Owned Vitest/UI and transitive production peer/mocker 4.1.12; Angular's Vite 8.3.5, with Vite 6.4.4 retained for existing owners |
| Private CopilotKit runtime | Express qs 6.16.1, rate-limiter ip-address 10.7.5, pino-pretty fast-copy 3.1.0 and AJV fast-uri 3.1.9 |

Directly owned development manifests and the factory target's test manifest are
aligned with Vitest 4.1.12. Published package versions remain 0.15.2; these
changes affect repository tooling and private integration resolution. They do
not replace any immutable published package or constitute a new npm release.

## Bounded policies and lock integrity

Exact upstream pins still prevent several supported patched resolutions. The
new or updated root policies are:

| Selector | Resolution |
| --- | --- |
| `undici@>=5 <6` | `6.29.1` |
| `minimatch@>=10 <10.2.3` | `10.2.6` |
| `path-to-regexp@>=8 <8.4.0` | `8.4.2` |
| `sharp@>=0.35 <0.35.5` | `0.35.5` |
| `smol-toml@>=1 <1.7.1` | `1.9.1` |
| `vitest@>=4 <4.1.12` | `4.1.12` |
| `qs@>=6 <6.16.0` | `6.16.1` |
| `vite@>=8 <8.3.3` | `8.3.5` |
| `ajv@>=8 <8.18.0` | `8.20.0` |

Remove each policy when every retained owner admits a safe resolution and the
reviewed-minimum and owner regressions pass without it. The Undici 5→6 policy
crosses a major contract and receives actual Vercel transport qualification.
Other rows remain within the affected owners' major versions. Compatible brace,
cache, IP, copier, URI and grpc updates persist in the lock without permanent
override selectors.

An initial `pnpm update` refreshed unrelated peer closures and failed to refresh
some targeted transitive nodes. That output was set aside. Regeneration starts
from the baseline lock, uses temporary constraints to select compatible patched
children, then removes those constraints and stabilizes the lock. The final
`pnpm install --frozen-lockfile` succeeds with only the reviewed permanent
policies. The TypeScript 6 wrapper and its actual implementation remain 6.0.2.

Vite 8.3.5 raises its PostCSS floor to ^8.5.30, Rolldown to ~1.2.14 and
picomatch to ^4.0.7. Their shared compatible resolutions also appear under
ng-packagr and tinyglobby. Compatible existing lru-cache/content-type nodes are
reused by path-scurry/type-is. These are shared owner-closure resolutions, not
separate application upgrades. Review found no duplicate peer-graph expansion:
Vitest/mocker retain three instances each and Vite retains two 6.4.4 instances
and one updated 8.3.5 instance.

## Compatibility and security qualification

The new owner suite passes all 20 tests. It traverses the actual installed
owners and checks both Vercel transports, streamed upload, multipart decoding and
errors, malformed WebSocket compression negotiation in a subprocess, remaining
Busboy prototype headers, SVG rasterization and AVIF round trips, Vercel globs,
TOML/routes/config schemas, bounded brace nesting through three real owners,
query limits, address classification/family isolation and bounded malformed
input, URI scheme/host handling, copier depth limits, and both mock interceptor
boundaries. The manual-source test parses generated modules without executing
the supplied strings. All network fixtures bind to disposable loopback ports.

The corrected raw-backslash probe records old mocker 4.1.11 accepting a redirect
registration and 4.1.12 rejecting it. Its initial percent-encoded fixture was
inert and was discarded. The old-package probe uses retained package bytes and
does not alter the final installed graph. Native Windows CI now includes the
owner suite; the exact workflow fixtures change with that added command.

The complete committed-source security suite passes 400 tests with one platform
skip. Before checkpoint commit, two receipt tests intentionally rejected the
uncommitted lock via `AUDIT_SOURCE_UNPROVABLE`; the guard and tests were
preserved. An earlier discovery timeout under local load is retained separately.
The final focused graph/owner run passes 43 tests. Local lint passes 31 tasks,
build passes 29 tasks, and typecheck passes 59 tasks plus root projects.
Release integrity passes 33 tests. Adding the Windows owner suite also required
synchronizing a hard-coded exact-command assertion and its negative mutation
case; the initial mismatch is retained and the corrected workflow-contract suite
passes all 188 tests. Inventory validation passes. Pack validation passes all
59 unit checks and real packing; TypeScript tooling passes 27 unit checks and
its real fresh-install runtime/compiler probes. All five Chromium security
regressions and the harness reporter self-test pass.

The cache advisory
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
lists no patched version; its
[maintainer disputes the report](https://github.com/kornelski/http-cache-semantics/issues/56).
Version 4.3.0 is outside the listed affected range, and is not described here as
a demonstrated upstream fix. The actual Verdaccio notification owner leaves Got
caching disabled. Tests prove repeated requests reach the origin for cacheable
cookie-bearing responses and for stale `proxy-revalidate` responses even with a
`max-stale` request directive. The policy API's private/no-store/no-cache cases
are also checked. This evidence does not establish that arbitrary shared-cache
configurations are safe.

Fast-copy's requested depth advisory is qualified through pino-pretty's actual
`createCopier({})` API: deep input produces the documented bounded
`MaxDepthExceededError` instead of native stack exhaustion. An extra assumption
about cloned-object prototype hardening was unsupported by the loose copier's
documented contract and was removed; both old and current loose copiers can set
a clone's prototype from an own `__proto__` key. Global Object.prototype remains
unchanged. Per-clone prototype hardening is not claimed as a fix in this work.

WebSocket qualification covers malformed compression-parameter rejection, not
fragment-count or decompression-bomb resource bounds. The grpc patch requires
hosted owner/Docker compatibility qualification; real certificate-authentication
security qualification is not claimed. Broader source, release-controller,
packaging, tooling-pack, browser, harness, native Vercel and platform gates must
pass on the exact PR head before integration. The PR's checks and final merge
record provide that hosted evidence; local individual lanes are not represented
as a successful run of the aggregate `pnpm ci:validate` command.

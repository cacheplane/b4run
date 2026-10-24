# Security remediation after 0.15.1

The owner's answer to the pending audit question arrived after 0.15.1 had
already become immutable. Publication proceeded while that question remained
unanswered; it should have waited. The published tag and bytes cannot be replaced.
This branch prepares remediation for a follow-up patch. **Keep the next package
publication on hold until the fresh production audit has zero high and critical
findings and the exact release gates pass.** Do not infer a waiver from an
unanswered question or a passing CI run.

## Verified inputs

Main `fe8c0a012a74ae3d70ae480b51e0bcef6e5d3cff` has six high production findings:
three Zod versions (4.4.3, 3.25.75 and 3.25.76), body-parser 2.3.0, MSAL Node
5.1.5 and Undici 8.10.2. GitHub advisory pages re-read October 24 identify:

- [Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): patched 4.6.6.
- [body-parser GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828): patched 1.20.9 and 2.4.0.
- [MSAL GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5): patched 7.1.0.
- [Undici GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c): patched 6.29.1, 7.30.1 and 8.12.2.

At inspection, latest AG-UI client 1.0.3 requires Zod ^3.25.76. Latest Microsoft
agents-hosting 1.9.1 still pins Zod 3.25.75 and MSAL Node 5.6.0. Updating only
their owner versions cannot remove these findings.

## Changes and compatibility boundaries

Raise directly owned Zod manifests, the SDK optional peer, generated app
templates and executable consumer fixtures to at least 4.6.6. Refresh compatible
body-parser resolutions to 1.20.9 and 2.4.0. Keep the existing TypeScript wrapper's
reviewed implementation at 6.0.2 and preserve unrelated package versions.

Six bounded root policies prevent affected resolutions from returning:

| Selector | Replacement | Reason and removal condition |
| --- | --- | --- |
| `zod@>=3 <4.6.6` | `4.6.6` | Private AG-UI/Microsoft paths retain Zod 3 constraints; remove when their supported owner ranges admit patched Zod and no affected snapshots remain. |
| `@azure/msal-node@>=5 <7.1.0` | `7.1.0` | Microsoft hosting retains a vulnerable MSAL pin; remove when the supported hosting range admits a patched release. |
| `openai@7>undici` | `8.12.2` | Preserve OpenAI 7’s existing optional transport major when broad peer ranges intersect several patched floors; remove with the Undici policies after resolver proof preserves the intended major. |
| `undici@>=6 <6.29.1` | `6.29.1` | Prevent affected 6.x resolutions, including development paths; remove when every owner excludes affected versions. |
| `undici@>=7 <7.30.1` | `7.30.1` | Prevent the exact vulnerable 7.29.0 owner pin from returning; same removal condition. |
| `undici@>=8 <8.12.2` | `8.12.2` | Prevent affected runtime and test 8.x resolutions; same removal condition. |

The Zod 3 and MSAL substitutions cross the owners' declared major-version
contracts. They are deliberate compatibility changes, not ordinary compatible
lock refreshes. Root pnpm policies apply to this repository; they do not impose
these private example policies on independent consumers' package managers.
Published directly owned Zod dependency and peer minima carry the patched floor.
Do not claim the overrides alone prove compatibility or consumer-wide remediation.

The added owner check traverses the actual installed CopilotKit → Teams →
Microsoft hosting graph. It validates Microsoft activity records using the
installed Zod replacement and exercises the real hosting token provider and
MSAL client-credential implementation against an in-memory OAuth transport.
It checks the resulting token, endpoint, correlation identifier, grant type and
scope. It uses fixture credentials and performs no external authentication.
Real Microsoft tenant authentication, certificates and managed identity are
not asserted by that local fixture. Both real example CopilotKit route adapters
also run against the local B4.run HTTP boundary.

## Validation

Dependency-floor coverage was observed failing against old versions before the
updates. The final focused graph, owner compatibility and CopilotKit route suites
pass 34 tests. Initial full build passed 29 tasks; final clean validation and
hosted release gates remain pending. A fresh production audit of the experimental
resolved graph reports zero high and critical, 12 moderate and three low findings.
This is a workspace production selection, not a blanket exploitability assertion.
The final production audit JSON SHA-256 is
`de9f800e4587dc71496b35256e6719a6e1e8106463f09a994f6ca059d1092bee`.
The full audit including development dependencies still reports zero critical,
26 high, 45 moderate and 13 low findings; its SHA-256 is
`b8f2222b6cbf436859b99276b6dcdb6c86aeda89d3df8098634637994d11c9af`.
Those additional development findings are not claimed remediated by resolving
the six production findings named in the owner's question. No audit suppression
or ignored advisory was introduced. Record independent review, final validation,
hosted gates and publication outcome before lifting the follow-up release hold.

The initial bounded Undici selectors unexpectedly chose 6.29.1 for OpenAI 7's
broad optional peer. A parent-specific policy now preserves its previous major
as 8.12.2. The final graph and route checks were rerun after this adjustment.
Tool-schema compatibility also checks CopilotKit's real Standard JSON Schema
adapter, including required fields, string length and constrained array items;
calling the legacy converter directly with a Zod 4 schema would lose those
constraints and is not the tested owner path.

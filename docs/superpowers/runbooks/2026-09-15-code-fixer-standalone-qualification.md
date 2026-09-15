# Code-fixer standalone qualification

The code-fixer installation guide targets source commit
`0003db2802b718ed167c8266b09a2d00ae01a522` from `cacheplane/b4run` and published
B4 **0.8.32** packages. It installs an ordinary `/fix` agent, tools, skills,
workspace declaration, and evaluation support.

## Release identity

- Corrected application: [PR #655](https://github.com/cacheplane/b4run/pull/655).
- Historical receipt-order correction: [PR #658](https://github.com/cacheplane/b4run/pull/658).
- Release commit: `4084b7a66014e1b4ab8190b76e71a981c126b919`, [PR #656](https://github.com/cacheplane/b4run/pull/656).
- [Immutable 0.8.32 release](https://github.com/cacheplane/b4run/releases/tag/v0.8.32), published September 15, 2026.
- [Release commit CI](https://github.com/cacheplane/b4run/actions/runs/34993487982), [publication and release smokes](https://github.com/cacheplane/b4run/actions/runs/35005950564), and [independent artifact audit](https://github.com/cacheplane/b4run/actions/runs/35007726822) passed.
- Sealed manifest SHA256: `ba2e907f30152f2667ec853b18ebc3d7eda7827f5e26f23bf25a0c504234414b`.

The release required resumptions because npm propagation exhausted the bounded
publisher budget. Recovery verified existing bytes and reused the signed payload.
No package bytes or release tag were replaced. A separate 0.8.33 version commit
landed during publication; these results describe **0.8.32**, not 0.8.33.

## Archive-based qualification

The source was extracted with `git archive` into a fresh directory outside the
monorepo. Six runtime/testing B4 packages were pinned to 0.8.32; the compiler
configuration was copied into `config/`; commands used the installed `b4` binary.
The monorepo-only lint command and consumer-packaging helper were excluded.
All other original source hashes were rechecked after testing.

Node 24 and npm were used with a running Docker daemon. The prepared fixture
image was `sha256:337e9f68cbb1695833e454feade694371dd93a8fa729c9d3251120c67ad9c6c8`.

| Command or check | Result |
| --- | --- |
| `node scripts/prepare.ts` | Fixture image prepared |
| `npm install --registry=https://registry.npmjs.org` | Passed; no workspace links |
| `npm run check` | Passed |
| `npm run build` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | 48 tests passed |
| `npm run eval:replay` | Both fixtures passed all six criteria; stopped at `approval-pending` |
| `npm run test:sandbox` | 9 integration tests passed |
| Built `.b4/build/server.mjs` via Agent Protocol | `/fix#agent` executed `readFile` in a real managed Docker workspace and returned a deterministic local model response |
| Cleanup | HTTP thread deleted; no containers using the fixture image or managed workspace volumes remained |

All 13 B4 packages in the installed dependency graph were exactly 0.8.32, fetched
from the public npm registry, and matched the sealed manifest's npm integrity
values. The retained package lockfile contains no local package links.

The replay cases were `cli-flags` and `nullable-inputs`. Each passed visible tests,
independent checks, source scope, failure reproduction, post-edit verification,
and runtime approval. Approval acceptance, denial, independent verification,
and killed-verifier cleanup were exercised by the Docker integration suite.

These tests used local model fixtures and historical repair replays, with no paid
model calls. They establish installation and deterministic runtime behavior;
they do not establish live-model repair quality or a time-to-repair claim.

## Publication-path qualification

The public guide adds a supported basic scaffold, the primary route marker,
and an installation-specific Docker scope. Those differences require their own
fresh-directory check before merging the guide; the archive-based result above
does not by itself establish that the scaffold conversion works.

The publication path was verified in a second fresh directory outside the
monorepo with the public command:

```sh
npm exec --yes --package=create-b4-app@0.8.32 -- create-b4-app <unused-target> --template basic --dist-tag 0.8.32
```

The freshly generated hello route and its test were removed; scaffold metadata,
contributor guidance, extra compatible dependencies, and ignore rules were
preserved. The guide's bounded source files and local compiler configuration
were applied. The primary route received `// b4-blueprint: code-fixer@1`; the
Docker scope was set to `code-fixer-guide-qualification`. The fresh scaffold's
TypeScript-only build command was replaced with `b4 build`.

The following all passed from that installed app: `npm install
--registry=https://registry.npmjs.org`, `npm ci`, `npm run sandbox:prepare`,
`npm run fixtures:qualify`, `npm run check`, `npm run build`,
`npm run typecheck`, `npm test` (48 tests), `npm run eval:replay` (both fixtures),
and `npm run test:sandbox` (9 tests).

A host-only smoke used the public `createAimock` export from `@b4run/testing`
with two deterministic responses and no proxy. It launched the built server
with the local mock URL, created a thread, invoked `/fix#agent` through
`/threads/<id>/runs/wait`, and observed the `readFile` tool result and final
fixture response. It deleted the thread and stopped both processes. No containers
using the fixture image or managed workspace volumes remained.

Every installed B4 package was exactly 0.8.32 and matched the sealed release
manifest's integrity value; the lockfile contained no workspace links.
The resulting package-lock SHA256 is `469100bf8a72d6a6e880d6851db2809a263dfe8eb84c210d3eee7754c71d07fd`.

Local command logs, original scaffold hashes, installed file hashes, lockfile,
and HTTP result were retained in
`artifacts/standalone/code-fixer-blueprint-0.8.32/`. This local evidence supplements
the public CI and artifact audit links above; it is not a hosted release asset.

The installed 0.8.32 CLI was also exercised against the production-built local
website with `B4_BLUEPRINTS_URL=http://127.0.0.1:59641`. `b4 add` listed
`code-fixer` under `agents`; `b4 add code-fixer` returned the guide containing the
exact source commit, package version, and offline built-runtime procedure. The
local website process was stopped afterward.

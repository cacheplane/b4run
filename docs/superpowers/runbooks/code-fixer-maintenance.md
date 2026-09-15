# Code-fixer maintainer checks

The copyable app in `examples/code-fixer/server` contains one CLI sample, normal
route evals, and focused unit and Docker replay tests. It runs with `b4 dev` and
does not depend on the files in `test/code-fixer`.

The repository-only suite in `test/code-fixer` owns the second nullable-input
fixture, batch subprocesses, timeouts, cancellation and recovery checks,
historical qualification, publication evidence, and consumer qualification.
Commands below run from the repository root, after `pnpm install` and `pnpm build`.

```sh
pnpm code-fixer:qualify
pnpm code-fixer:prepare
pnpm --filter @b4-example/code-fixer-server test
pnpm test:code-fixer
pnpm --filter @b4-example/code-fixer-server test:sandbox
pnpm test:code-fixer:sandbox
pnpm code-fixer:replay
```

`code-fixer:qualify` executes only the checked-in historical source and reference
patches on the host. It must never accept agent-produced patches. Agent changes
are verified inside Docker through the app's review tools.

`code-fixer:prepare` builds one image with dependencies for both historical
samples. `sandbox:prepare` inside the copied app builds its single sample image.
The maintainer image also supports the ordinary app's CLI sample.

Each batch attempt makes a private copy of the app, replaces its single `sample/`
directory with the selected maintained fixture, and starts its own harness
worker. The app's configuration reads that sample's project identity. No runtime
fixture registry or environment-driven fixture selector is installed in the app.
Both historical source trees, task text, manifests and reference patches retain
their original bytes.

For paid model recordings, supply `OPENAI_API_KEY` on the host:

```sh
pnpm code-fixer:live -- --attempts 3
```

Each fixture receives the requested number of attempts. The worker records the
same six criteria as route evals and ordinary replay tests: reproduction,
post-edit verification, approval, visible assertions, independent assertions,
and a nonempty prepared source change. Reported billable tokens remain unknown;
this command does not promise a token budget. Failed attempts remain in the
batch summary. Timeout and cancellation terminate the owned process group;
cleanup recovers the attempt's app and verifier installations.

Review evidence with `code-fixer:export` using its required input/output options.
Only complete successful live receipts with qualified provenance are exportable;
replays must remain labeled as replays. Keep the published installation guide
and homepage evidence pinned to their qualified revision until the new app is
released and separately qualified against published packages.

CI's Docker lane runs both the ordinary app and maintainer Docker tests, followed
by deterministic replays of both historical fixtures. The normal source-test
lane includes the maintainer unit tests through `vitest.workspace.ts`.

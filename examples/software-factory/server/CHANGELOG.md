# @b4-example/software-factory-server

## 0.0.4

### Patch Changes

- Updated dependencies [a30db23]
- Updated dependencies [0093dea]
- Updated dependencies [54aa602]
  - @b4run/cli@1.0.0
  - @b4run/sandbox@1.0.0
  - @b4run/sdk@1.0.0
  - @b4run/workspace@1.0.0

## 0.0.3

### Patch Changes

- The builder is now manifest-driven, and is only the builder. The controller moved out to
  `@b4-example/software-factory-controller` — the registry, verifier, workspace reader,
  target and task catalog, `scripts/prepare-target.ts`, the `factory` CLI and every factory
  test went with it — and this package keeps one bounded route that edits files in a
  container.
- `b4.config.ts` is now a function of a single input, `FACTORY_BUILDER_MANIFEST`: a JSON
  manifest the controller writes per task (`factory builder-manifest`) naming the captured
  workspace, the target's image, scope, sandbox policy and permissions, and the prompt. The
  workspace is served through the resolver form of `sandbox.workspace` after
  `verifyCapturedWorkspaceDefinition`, which is also the shape a per-thread task choice will
  take. The builder imports no controller source.
- `build` and `check` now run behind `scripts/with-manifest.mjs` and skip with a notice when
  `FACTORY_BUILDER_MANIFEST` is unset, so an unfiltered repository-wide build — which has no
  task in hand — does not fail on a package that cannot be built out of context. The Docker
  lane is the only place a manifest exists, so `build`/`check` skip everywhere else.
- `FACTORY_TASK_ID` is gone: the manifest names the task.
- Updated dependencies [185ae3c]
- Updated dependencies [1cadde8]
- Updated dependencies [71bccb3]
  - @b4run/sandbox@0.10.0
  - @b4run/cli@0.10.0
  - @b4run/workspace@0.10.0
  - @b4run/sdk@0.10.0

## 0.0.2

### Patch Changes

- Updated dependencies [7c9627f]
- Updated dependencies [67b18fe]
- Updated dependencies [516c038]
- Updated dependencies [6a59e00]
- Updated dependencies [7410154]
- Updated dependencies [9927409]
  - @b4run/cli@0.9.0
  - @b4run/sdk@0.9.0
  - @b4run/workspace@0.9.0
  - @b4run/sandbox@0.9.0

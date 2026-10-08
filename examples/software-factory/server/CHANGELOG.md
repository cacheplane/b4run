# @b4-example/software-factory-server

## 0.0.10

### Patch Changes

- Updated dependencies [b006a95]
- Updated dependencies [d0bb6a1]
- Updated dependencies [e6cfa3d]
- Updated dependencies [29acd56]
- Updated dependencies [1180d4c]
- Updated dependencies [52b19ec]
- Updated dependencies [6b7f152]
- Updated dependencies [2c33a3f]
- Updated dependencies [ed43d4f]
- Updated dependencies [2d07889]
- Updated dependencies [5caad96]
- Updated dependencies [0cd999a]
- Updated dependencies [0b33206]
- Updated dependencies [61e5922]
- Updated dependencies [b25fc3b]
- Updated dependencies [b61e133]
- Updated dependencies [0231fb5]
- Updated dependencies [fd0c456]
- Updated dependencies [861f84a]
- Updated dependencies [00b85cf]
- Updated dependencies [03fb4e6]
- Updated dependencies [fc59949]
- Updated dependencies [bcfc8b8]
- Updated dependencies [936b7bf]
- Updated dependencies [936b7bf]
- Updated dependencies [73c9289]
- Updated dependencies [e9bfd30]
- Updated dependencies [91726d5]
- Updated dependencies [bbd4a0c]
- Updated dependencies [9547137]
- Updated dependencies [18bc4fd]
- Updated dependencies [bbc7871]
- Updated dependencies [d45b2dc]
  - @b4run/cli@0.13.2
  - @b4run/sdk@0.13.2
  - @b4run/workspace@0.13.2
  - @b4run/sandbox@0.13.2

## 0.0.9

### Patch Changes

- Updated dependencies [f9350c4]
- Updated dependencies [0c76234]
- Updated dependencies [216befd]
- Updated dependencies [a683816]
- Updated dependencies [17f16ea]
- Updated dependencies [3b1be6e]
- Updated dependencies [c7282f4]
- Updated dependencies [b0605d7]
  - @b4run/sdk@0.13.1
  - @b4run/cli@0.13.1
  - @b4run/workspace@0.13.1
  - @b4run/sandbox@0.13.1

## 0.0.8

### Patch Changes

- Updated dependencies [f2ee6cf]
- Updated dependencies [1f335b1]
- Updated dependencies [0781125]
- Updated dependencies [c301d77]
- Updated dependencies [5260ecb]
- Updated dependencies [3b489a5]
- Updated dependencies [0dd8fff]
- Updated dependencies [90b68be]
- Updated dependencies [1da86ae]
- Updated dependencies [79c5f63]
- Updated dependencies [03795da]
- Updated dependencies [fcf6d83]
  - @b4run/workspace@0.13.0
  - @b4run/sandbox@0.13.0
  - @b4run/cli@0.13.0
  - @b4run/sdk@0.13.0

## 0.0.7

### Patch Changes

- Updated dependencies [ef4c901]
- Updated dependencies [7f81d24]
  - @b4run/cli@0.12.0
  - @b4run/sandbox@0.12.0
  - @b4run/sdk@0.12.0
  - @b4run/workspace@0.12.0

## 0.0.6

### Patch Changes

- Updated dependencies
  - @b4run/cli@0.11.2
  - @b4run/sandbox@0.11.2
  - @b4run/sdk@0.11.2
  - @b4run/workspace@0.11.2

## 0.0.5

### Patch Changes

- Updated dependencies [837bcfb]
- Updated dependencies [c282336]
  - @b4run/cli@0.11.1
  - @b4run/sdk@0.11.1
  - @b4run/sandbox@0.11.1
  - @b4run/workspace@0.11.1

## 0.0.4

### Patch Changes

- Updated dependencies [a30db23]
- Updated dependencies [0093dea]
- Updated dependencies [54aa602]
  - @b4run/cli@0.11.0
  - @b4run/sandbox@0.11.0
  - @b4run/sdk@0.11.0
  - @b4run/workspace@0.11.0

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

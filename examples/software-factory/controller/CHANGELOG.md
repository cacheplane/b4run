# @b4-example/software-factory-controller

## 0.0.9

### Patch Changes

- Updated dependencies [3777065]
  - @b4run/cli@0.14.1
  - @b4run/sandbox@0.14.1
  - @b4run/sdk@0.14.1
  - @b4run/workspace@0.14.1

## 0.0.8

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
  - @b4run/cli@0.14.0
  - @b4run/sdk@0.14.0
  - @b4run/workspace@0.14.0
  - @b4run/sandbox@0.14.0

## 0.0.7

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

## 0.0.6

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

## 0.0.5

### Patch Changes

- Updated dependencies [ef4c901]
- Updated dependencies [7f81d24]
  - @b4run/cli@0.12.0
  - @b4run/sandbox@0.12.0
  - @b4run/sdk@0.12.0
  - @b4run/workspace@0.12.0

## 0.0.4

### Patch Changes

- Updated dependencies
  - @b4run/cli@0.11.2
  - @b4run/sandbox@0.11.2
  - @b4run/sdk@0.11.2
  - @b4run/workspace@0.11.2

## 0.0.3

### Patch Changes

- Updated dependencies [837bcfb]
- Updated dependencies [c282336]
  - @b4run/cli@0.11.1
  - @b4run/sdk@0.11.1
  - @b4run/sandbox@0.11.1
  - @b4run/workspace@0.11.1

## 0.0.2

### Patch Changes

- Updated dependencies [a30db23]
- Updated dependencies [0093dea]
- Updated dependencies [54aa602]
  - @b4run/cli@0.11.0
  - @b4run/sandbox@0.11.0
  - @b4run/sdk@0.11.0
  - @b4run/workspace@0.11.0

## 0.0.1

### Patch Changes

- Initial release. The software factory's controller, extracted from
  `@b4-example/software-factory-server` and re-landed as a b4 app in its own right: its
  mutating commands are `workflow` routes (`/work-orders/{create,dispatch,approve,deny,cancel}#workflow`
  and `/reconcile#workflow`), so the runtime supplies the serialisation — one run at a time on
  the thread whose id is the work order's id — and `dispatch` awaits its run inside the
  request.
- Holds the state machine, the append-only journal, the two-phase command log and
  `registry.sqlite`; the baseline capture, workspace reader, assembly, digest, verifier,
  bundle freeze and export; the target and task catalog (`targets/`, `tasks/`, `fixtures/`,
  `scripts/prepare-target.ts`); and every factory test, including the Docker-gated
  `test:sandbox` lane.
- Ships the `factory` CLI: an HTTP client of the controller's routes for the commands that
  change something (`FACTORY_CONTROLLER_URL`), a read-only reader of
  `<FACTORY_STATE_DIR>/registry.sqlite` for `show`, `list`, `events` and `evidence`, and
  `builder-manifest --task <id> --out <dir>`, which needs neither.
- Reads are not routes and the controller is the only writer. `FACTORY_BUILDER_APP_ROOT`
  addresses the builder's installation store so the workspace reader can open a builder
  thread's managed workspace read-only, without acquiring the builder's session.

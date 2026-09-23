# @b4-example/software-factory-controller

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

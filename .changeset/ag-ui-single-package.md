---
"@b4run/ag-ui": patch
---

**Breaking:** the activity stylesheet moved from `@b4run/ag-ui/react/styles.css` to `@b4run/ag-ui/styles.css`, one sheet for every kit, and the React CopilotKit connector moved from `@b4run/ag-ui/copilotkit` to `@b4run/ag-ui/react/copilotkit`.

`@b4run/ag-ui` now has one folder per framework. The Angular activity kit ships in it: standalone components at `@b4run/ag-ui/angular` that render the same DOM contract as the React kit, a connector for any AG-UI event stream at `./angular/events`, and a CopilotKit connector for `<copilot-chat>` at `./angular/copilotkit`. They ship in Angular's partial compilation format for your Angular build to link. `@angular/core`, `@angular/common`, `@angular/platform-browser` (`^22.0.0`) and `@copilotkit/angular` (`>=0.5.3`) are optional peer dependencies.

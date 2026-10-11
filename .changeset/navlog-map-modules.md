---
"@b4run/devkit": patch
"create-b4-app": patch
---

The navlog template's route map helpers live together in `web/app/lib/map/`: marker icons (`markers.ts`), label placement (`labels.ts`, `label-dom.ts`), the Leaflet layers `RouteMap` draws (`layers.ts`) and the draft rules (`draft.ts`). `RouteMap` lists its effects in order and only decides when each layer is drawn. `sheet-control.ts` and the button classes (now `buttons.ts`) move from `app/components/` to `app/lib/`. No behavior changes.

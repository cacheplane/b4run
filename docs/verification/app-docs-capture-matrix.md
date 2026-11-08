# App documentation capture qualification

## 2026-11-06: Navlog aircraft lookup

The first admitted recording uses the installed **B4 beta 0.1.0** build, as requested. It contains two prompts submitted through the native app, two completed turns, four completed tool calls (two reads and two memory lookups), and 125 observed events. The normalized capture is 41,352 bytes. No weather was fetched and no flight plan was filed.

- Capture: `navlog-aircraft`, SHA-256 `9a07247b3380c87a0f92c04f503624c421e4dac9daa9ca7b7c0d4168b476177d`.
- Beta executable: SHA-256 `6f7340cb2288c8b0916d119c2d1623b495c11ae698363a73d672e13ae4f5a803`. The installed bundle reports no source revision; it is explicitly unavailable, not inferred from the current checkout.
- Recorder source: `b3930da` (the full revision is in the lesson manifest). This is what the capture's `revisions.app` identifies.
- Runtime and example: `dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7`, workspace packages built before use; pinned workspace lockfile, Node 24.20.0, LangGraph 1.4.17, `gpt-5-mini`, isolated SQLite keyword memory.
- Source snapshots: the example's `readDoc.ts` and `workspace/aircraft/c172n.md`, read from the pinned Git revision, with independent SHA-256 digests in the manifest.

Review covered all messages, intermediate event fields, tool arguments/results, assembled streamed text, the plain-text transcript, and both source snapshots. Only example aircraft data and workspace-relative paths remain. Account details, connection endpoints, credentials, home paths and native identifiers are absent. No video or screenshot is included in the published asset set. The scanner passed, then the complete allowlist passed publisher dry-run before assets were copied into the local website tree. This does not deploy the website.

The prompt names N738ZU while the example baseline names N734ST. The recording and lesson retain that difference. No transcript or result was edited to manufacture a cleaner answer. Missing observations remain unavailable. The result of `readDoc` is the observed JSON string, not a reconstructed object.

Named moments select the first read (event 8), second read (event 72), and completed conversation (event 124). Tests verify every manifest digest, capture provenance, moment and source reference. The browser review verified inline moment navigation and source loading against this real capture.

## Earlier qualification attempts

An isolated local hub/account was prepared while the account question was pending. A full flight-planning turn could not compute a navlog because winds data were unavailable. That recording also exposed omitted custom-event fields; a failing regression test preceded the recorder fix. This attempt is private and was not admitted. A subsequent local aircraft lookup qualified the corrected recorder but was also kept private after the user selected the beta build.

The checkpoint defect is separate: LangGraph 1.7.1 stores `__interrupt__` as an array, while the workspace's 1.4.17 fixtures used a singleton. The CLI now validates both representations. Parser/endpoint/resume checks passed (108 tests, one skipped), the workspace build passed, and all nine generated Navlog lifecycle tests passed. No relaxed permission or checkpoint validation was introduced.

## Coverage and remaining media

This first lesson qualifies message streaming, repeated tools, a follow-up turn, completion, replay, source inspection and transcript fallback. Approval, cancellation and unknown outcomes are fixture-tested but are not represented as live-qualified recordings by this lesson. Video demos and captions remain the separate content/media delivery step; no placeholder video is presented as a real recording.

## Implementation checks

- Recorder: full Swift suite passed, 1,428 tests in 174 suites; strict formatting passed. A finish-barrier race is now rejected rather than repaired with snapshot data.
- Website: full focused-package run passed, 1,694 tests with 71 skipped, before the final content wiring. The final inspector and Markdown suites passed through the repository-root runner: 49 tests across ten files. The root run exposed a working-directory assumption in the new manifest test; asset paths are now module-relative.
- Website lint, typecheck and production build passed. The built SEO audit passed with 117 indexed pages, 92 docs, 92 documentation OG images and no errors. The standalone inspector returned 200 with noindex, its canonical lesson and transcript fallback; an unknown recording returned 404.
- Browser checks covered real inline and direct moment links, source loading and contrast, selected activity, and mobile controls. At 375px the integrated page has no horizontal overflow and visible inspector buttons are at least 44px high. Earlier component-width checks covered 320, 375, 768, 1024 and 1440px. Browser review caught and corrected a cancelled-fetch remount bug, inherited source text contrast and a narrow docs-header overflow.
- The broad `pnpm ci:validate` attempt passed release integrity, lint, build-cache checks, all 29 build tasks and all 59 typecheck/build prerequisites. Its source-test phase was interrupted after widespread existing timeout failures under machine load averages above 80 (later above 150). It also found the manifest test path issue fixed above. This is **not** a green repository-wide gate. Remaining release/package/harness stages were not reached by that invocation.

The six existing files that failed under contention were rerun together with `--maxWorkers=1` and unchanged timeouts: 254 tests passed, two failed. Vercel build, dev-server, workspace source-capture, Kubernetes command and inspector bulk-safety suites passed. The two sandbox bounded-filesystem real-shell cases still exceeded 5 seconds while the machine load average remained near 87. Their code is unchanged. No repository-wide green result is claimed, and no timeout was increased to mask the limit. Release inventory and changeset checks passed separately.

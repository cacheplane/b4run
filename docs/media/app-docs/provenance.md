# App docs media provenance

## Admitted assets

The `navlog-aircraft` manifest in `apps/web/lib/turn-inspector/lessons.ts` identifies the reviewed beta event recording, transcript and two pinned source snapshots. Its qualification record is `docs/verification/app-docs-capture-matrix.md`. The recording contains 125 observed events across two completed turns. The app binary identity and recorder revision are distinct; the installed beta binary's source revision is unavailable.

No native screen video, poster or caption track was captured/admitted for that take. The local screenshot of the new documentation inspector is implementation evidence, not native application footage or a public video asset.

## Required record for a future video

Before admission, record: lesson/take ID; app flavor/version/binary digest; app source revision if actually available; recorder/runtime/example revisions; protocol-capture digest; native recording start/end and synchronization evidence; original footage digest; edit/cut/speed map; output video/poster/caption/transcript digests; review date; privacy review; publisher validation/dry-run; and browser playback result.

A new native take requires its matching capture. Retain old digest-addressed assets rather than replacing their contents. Only update the lesson manifest after the replacement lesson and its moments have passed qualification. Public preparation does not authorize deployment.

## 2026-11-06: Native beta video take

`navlog-aircraft-video` is a separate take from `navlog-aircraft`. It contains 101 observed events, two completed turns and four completed tools. The native prompts name the aircraft profile by path; they do not use the earlier aircraft-number mismatch. Moments select events 8, 61 and 100. The normalized capture digest is `7e80731a5d435fb476db1a4c28d839eb44a7cdc6c5594bfa8ca1e44b65489016`.

The installed beta executable digest remains `6f7340cb2288c8b0916d119c2d1623b495c11ae698363a73d672e13ae4f5a803`; its source revision is unavailable. The recorder source is `48c9887c7f88d379da53fa682ff2104520934c29`. The existing isolated runtime and example remain at `dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7` (Node 24.20.0, LangGraph 1.4.17, gpt-5-mini). No weather lookup or filing occurred.

Screen Studio footage was supplied by the owner as a silent 1020×720, 60 fps MP4, lasting 120.283333 seconds. The lesson retains source seconds 28–90; the overview retains 28–60. Both crop the app window at x=60, y=60, width=900, height=600 and encode at 30 fps, H.264 CRF 18. There are no internal cuts, speed changes, replaced outputs or invented UI. Setup footage and excess closing wait are removed. The owner accepted this export's resolution for now; dense tool output is better read in the inspector.

The exact prompts, tool expansion, follow-up and final answers match the concurrently recorded protocol capture. Visual synchronization was reviewed at one-second intervals; it is not a frame-accurate event-to-video seek map. The two players pause one another rather than pretending to share a frame clock. Captions are descriptive teaching text, not transcribed speech. Posters come from each cut, and the text transcript includes both exact requests and answers, plus the four tool arguments and results.

All shipped assets are named by SHA-256 under `apps/web/public/docs-recordings/`; `videos.ts` pins each video's poster, captions, transcript and matching lesson. The old take and its immutable assets remain available. The capture publisher validated and dry-ran the complete capture/transcript/source allowlist before copying it. Media review inspected the retained app-only interval, both prompts and answers, and contact sheets for setup/privacy contamination; no unrelated window is retained. Asset contract tests verify hashes, captions bounded by clip duration, live lesson linkage and accessible player markup. Browser playback and final test results are recorded separately.

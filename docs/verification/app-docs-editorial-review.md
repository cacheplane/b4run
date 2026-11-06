# App documentation editorial review

## November 6, 2026: text and learning journey

Reviewed all ten app guides against `app-docs-release-facts.md`, the admitted Navlog transcript, current lesson manifest and inspector controls. Voice references: Brian's January 9 and January 11, 2024 posts; March 4, 2018 RxJS introduction; June 5, 2020 Angular Transfer State. Applied a familiar starting point, short connected explanations, direct actions and an observable result. No personal verification anecdotes were invented.

| Path | Review result | Remaining qualification |
| --- | --- | --- |
| Overview | Existing provider users have a direct setup path; B4 developer branch is optional | Production product naming/build walkthrough |
| Install | Download placeholders and prospective Homebrew command remain explicit | Real release artifacts, cask install/update, platform acceptance |
| Codex | App account and provider login are distinct; first-conversation continuation present | Released runtime connection/login and visible labels |
| Claude Code | Terminal authentication and local folder path explained separately | Released runtime connection/login and visible labels |
| First conversation | General turn concepts precede Navlog; guided Arguments/Result/Tree/JSON inspection; separate follow-up call; backward seek; source distinction | Native demo video, production build qualification |
| Manage work | Folder/project, conversation context and lifecycle boundaries explained | Real UI actions and quit/logout acceptance |
| iPhone | Companion and Mac responsibilities separated; download placeholder explicit | Distribution, real-device pairing, remote actions, notifications |
| Accounts/data | Provider requests, hub sync and local files distinguished | Released account lifecycle/deletion acceptance |
| Troubleshooting | Recovery starts from visible installation/authentication/turn/connectivity state | Released labels and recovery walkthroughs |
| B4 agents | Static inspection before optional server setup; first task now matches the read-only lesson | Production app/server compatibility; separate approval qualification |

Added reciprocal app links from the framework Navlog and flight-planner recipes. Existing framework URLs are unchanged. The inspector remains an interactive view of observed turns, not a project readers must build.

The public text does not claim the missing video exists. `docs/media/app-docs/storyboards.md` records the remaining demonstration sequence and capture requirements. The completed beta lesson does not establish provider-specific, approval or phone live coverage. The stale checkpoint blocker in the release sheet is now marked resolved with its evidence.

This review qualifies prose against the available evidence, not production launch readiness. Download and release acceptance gates remain open as authorized earlier.

### Validation

Content revision: `ad17b14e4`. Inspector/export/manifest suites: 54 tests across 11 files passed. Repository `node scripts/check-docs.mjs`: passed. Production website build: passed. Regenerated lastmod for exactly the four edited public routes; lastmod content and route checks passed. Built SEO audit: 117 indexed pages, 92 docs, 92 documentation OG images, zero failures. The first audit attempt had no server listening on its expected port; starting the built site on loopback port 3018 and rerunning resolved that prerequisite failure.

No application code, public recordings or runtime dependencies changed in this editorial pass. Full repository CI and real-device/release acceptance were not rerun; their existing qualification limits remain open.

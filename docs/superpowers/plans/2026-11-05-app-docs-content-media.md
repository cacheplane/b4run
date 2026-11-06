# App Docs Content and Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, or superpowers:subagent-driven-development when delegation is selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish ten fact-checked production guides in Brian’s teaching voice, with real videos and inspectable Navlog moments.

**Architecture:** A release-fact sheet drives prose and captures. Each conceptual guide progresses from a real demonstration to general teaching and inspection; setup/privacy/troubleshooting adapt to reader needs. Public media and source are immutable reviewed assets tied to qualified revisions.

**Tech Stack:** MDX, native app recordings, static video/captions/transcripts, existing website media tooling.

---

## Prerequisites and source of truth

Read the design, delivery plan and Brian voice references. Consult LLA design rules and the current b4.run token source. App behavior is verified against the release being documented. The app README and milestone log contain historical and fixture-only statements; neither is a substitute for release verification.

Create `docs/verification/app-docs-release-facts.md` and `docs/verification/app-docs-editorial-review.md` in b4run. These are internal evidence records, not public pages. Media recordings use the app recorder plan and controlled demo data. No screenshots of personal conversations or credentials.

### Task 1: Establish release facts before drafting instructions

- [ ] Inventory the ten pages from the design. For each claim record: app/runtime version, source path or official release artifact, observed behavior, date, verification type (source/fixture/live), and publication status (verified/needs verification). This is an evidence checklist, not a copied backlog.
- [ ] Verify production Mac download/install/update path and minimum OS/architecture; confirm iPhone distribution/requirements and that links actually resolve. Use local release manifests first, browse official download/product sources if needed. Do not use developer packaging scripts as end-user installation instructions.
- [ ] Verify app account versus provider authentication, prerequisites, connection setup, working folder/project behavior, existing terminal-thread availability, provider settings/defaults, approvals, stopping/closing/quitting, search/archive, phone connectivity/notifications and account deletion/data boundaries. Read current decisions rather than preserving stale roadmap claims.
- [ ] Record exact visible UI labels and actual supported controls in the released build. Keep screenshots/version references synchronized. When a fact needs a device/account not available, mark that page section unverified and finish independent writing; do not manufacture a successful check.
- [ ] Establish terminology: public app name from release, conversation versus turn, app account versus provider account, App CLI versus Framework CLI. B4 Navlog recordings remain explicitly labeled B4. Commit the factual evidence sheet before finalizing public copy.

### Task 2: Draft ten complete text-first guides

Files: `apps/web/content/docs/app/index.mdx`, `install.mdx`, `codex.mdx`, `claude-code.mdx`, `first-conversation.mdx`, `manage-work.mdx`, `iphone.mdx`, `accounts-and-data.mdx`, `troubleshooting.mdx`, `b4-agents.mdx`. Navigation plan supplies wrappers/SEO entries when these pages are publishable.

- [ ] Write overview: a concise practical introduction, what runs on the Mac, what the iPhone adds, and distinct setup links for existing provider users. Do not require B4 setup to understand or use the app.
- [ ] Write install/sign-in and both provider guides as complete standalone paths: prerequisites, actual actions, visible success, one common recovery path and continuation to first conversation. Link shared setup instead of repeating it everywhere. Use released commands/labels only.
- [ ] Write first conversation and manage work. Introduce a turn broadly, then use the recorded Navlog interaction as the inspectable example once it exists. Explain reading tool activity and responding to supported requests. A provider user can complete their own conversation without running Navlog.
- [ ] Write iPhone, accounts/data and troubleshooting. Explain when the Mac must be reachable and actual offline states. Separate local processing from provider network calls and hub sync. Recovery instructions identify the visible condition, meaning and concrete action. Do not invent remote capabilities or overstate privacy with an unqualified “nothing leaves your Mac.”
- [ ] Write the B4 guide using the maintained Navlog project/template and exact qualified runtime version. Explain its provider credential requirement separately from provider CLI logins. Link existing framework Navlog/building guides instead of duplicating server internals. Explain local plan recording honestly (`transmitted: false`).
- [ ] Apply the voice edit: practical problem first, familiar mental model, explicit action, observed result, next useful connection. Prefer “Let's follow one turn” over an abstract feature inventory. No invented first-person anecdotes, hype, em-dash slogans, or mechanical paragraph templates.
- [ ] Review every actionable statement against the fact sheet. Each published page must be useful without unfinished video slots or placeholder promises. Drafts can stay internal until verified; navigation only registers complete pages. Commit coherent page groups.

### Task 3: Plan and record focused demonstrations

Create `docs/media/app-docs/storyboards.md`, `docs/media/app-docs/provenance.md`; public assets are produced by the capture publisher under `apps/web/public/docs-recordings/` using immutable filenames. Create `apps/web/app/components/turn-inspector/DocsDemoVideo.tsx` and `docs-demo-video.test.tsx` for accessible playback and media coordination.

- [ ] Storyboard the overview: agent selection, useful prompt, activity, result, and phone follow-up only if live verified. Record separate authentic setup clips for each runtime when needed. A B4 demo must never be labeled as a provider-specific setup result.
- [ ] Storyboard the Navlog lesson around its actual first-turn capture and follow-up. Use a bounded route/departure prompt; record the exact date and weather inputs. Select real tool moments after inspecting the run rather than scripting an assumed tool sequence. A missed desired behavior is a new take or revised teaching point, not an edited fake response.
- [ ] Record the approval lesson in an isolated workspace: request local flight-plan recording, inspect the request, decide deliberately, and show the actual local result. Disclose that it is not transmitted. Verify denial/expired behavior only if taught. Do not trigger an external filing service.
- [ ] Capture native screen video and protocol recording from the same run. Use the recorder's run ID/timestamps to match footage. Record honest disclosures for sped/slowed footage or stubbed weather. Do not claim staged fixture runs are live integrations.
- [ ] Edit for readable text, generate poster, captions and a descriptive transcript. Preserve meaningful waiting/decision context. Use existing repository recording tooling where suitable; inspect its dependencies and avoid inventing a separate media platform. Check download sizes and encoding playback in the target browser.
- [ ] Implement a semantic video with controls, `preload="none"`, poster, captions track, transcript link and no autoplay. Connect it to the inspector's shared media coordinator. Test accessible naming, fallback, captions and exclusive playback. Run `pnpm --filter @b4run/web test -- app/components/turn-inspector/docs-demo-video.test.tsx`.
- [ ] Manually review video, transcript, capture and source for identity/secret leakage. Run capture validation and publisher dry-run, then prepare reviewed immutable assets for the PR. No production upload is implied by local artifact preparation.

### Task 4: Wire the teaching sequence to actual moments

Files: the ten MDX pages, `apps/web/lib/turn-inspector/lessons.ts`, review records; create `apps/web/app/components/turn-inspector/lesson-manifest.test.ts` and `scripts/docs-captures/check-lessons.ts`.

- [ ] Assign the first-conversation page one primary inspected lesson. Keep repeated examples consistent but change the capability under discussion. General concepts appear before example-specific inspector instructions. Setup/privacy pages may use screenshots or plain prose instead of forced replay sections.
- [ ] Add real video references and `TurnInspector`/`InspectMoment` entries. Every action names a valid manifest moment. “Inspect the weather result” selects its actual call/result, not the first matching display title. Do not add a Source tab to nondeveloper lessons unless it materially helps.
- [ ] Write meaningful video transcripts and standalone text around embeds. Link from the B4 guide to framework source/configuration instruction, and add reciprocal links in `apps/web/content/docs/recipes/navlog.mdx` and `flight-planner.mdx` where they explain using the agent in the app.
- [ ] Implement the lesson checker: load only trusted manifests and authored MDX references; verify capture digest/provenance, referenced moment existence, source hashes/ranges, video/caption/transcript existence, and a resolvable lesson backlink. Integrate into root docs validation without making normal checks run a model. Tests include missing media, wrong revision and nonexistent moment failures.
- [ ] Run `pnpm exec tsx scripts/docs-captures/check-lessons.ts`; expected exit 0 for all public lessons. Run manifest and markdown-export tests. Commit `docs: connect app lessons to verified recordings`.

### Task 5: Editorial and production-readiness review

- [ ] Walk the full path as an existing provider user: landing -> App -> install -> provider connection -> first conversation -> work organization -> optional phone -> troubleshooting. Then follow the B4 branch from static inspection to running Navlog. Check the two audiences stay distinct and links form purposeful next steps.
- [ ] Review voice against the four specified posts, not generic marketing style. Review technical wording against the release-fact sheet. Record source-verified versus live-verified statements and any remaining blocked publication items.
- [ ] View every page at desktop and phone widths, keyboard-only and 200% zoom. Confirm headings/readability, video controls/captions, noncompeting playback, readable tool payloads and Source selection. Check the entire lesson remains understandable with JavaScript disabled or capture loading failed.
- [ ] After final edits, run `pnpm --filter @b4run/web seo:lastmod` before route tests or the build and commit its generated manifest. Run web tests, typecheck, lint and build; root `node scripts/check-docs.mjs` after prerequisite builds; run `seo:lastmod:check`, `seo:lastmod:routes` and `seo:audit-built` with the web filter after the final build. Run the applicable root CI gate set; prose-only classification does not cover media components, scripts or CSS.
- [ ] Record exact results in `docs/verification/app-docs-editorial-review.md`, including any unavailable real-device/runtime checks. Prepare final PR(s) and preview links. Do not mark production docs complete while installation or key behavioral claims are unverified; do not publish or merge as part of this planning task.

## Execution checkpoint — November 6

- Ten source-backed text guides exist; production acceptance remains open and authorized download placeholders are retained.
- The first-conversation lesson now teaches the compact inspector's real controls and all three admitted moments. The B4 setup path starts with the same read-only lookup. Both framework recipes link back to the app path.
- The editorial review is recorded in `docs/verification/app-docs-editorial-review.md`; the release sheet now distinguishes the resolved checkpoint defect and qualified beta capture from production gates.
- Overview, provider setup, first-conversation and approval storyboards are prepared in `docs/media/app-docs/storyboards.md`. Media provenance explicitly records that native video/captions/poster are not yet available.
- Next execution: capture native footage and protocol events from the same controlled beta take, review/admit matching assets, then implement and test accessible video/exclusive playback. Do not pair new native footage with the old capture as if they were one take. The independent lesson-checker CLI and final production acceptance remain unfinished.
- Current checks: 54 focused tests, docs completeness, production build, lastmod checks and built SEO audit passed. See the editorial record for exact scope and prerequisites.

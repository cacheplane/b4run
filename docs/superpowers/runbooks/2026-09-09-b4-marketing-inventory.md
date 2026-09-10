# B4.run marketing and external-account inventory

**Updated:** 2026-09-10 UTC; initial HTTP inventory observed September 9. **Tracking:** [issue #602](https://github.com/cacheplane/b4run/issues/602).
**Source baseline:** `811cd0402a478f3d541bd60572b24a34ddd6665b` on
`blove/b4-rename-followup-plan`.

The public homepage and Getting Started page serve B4.run canonical and social
metadata. All cataloged brand downloads, favicon variants, four demo posters,
and eight hosted video URLs respond successfully. One active public entrypoint
is broken: **`https://b4.run/brand` returns HTTP 404**, despite links from the
homepage navigation, issue template, and brand asset manifest. The source tree
has no `apps/web/app/brand` page because [commit 5b161844](https://github.com/cacheplane/b4run/commit/5b161844d426ddd8fd893e8e8e80197bd64194e9)
intentionally removed it on 2026-05-13 ([PR #137](https://github.com/cacheplane/b4run/pull/137)).
The repair is to point surviving links at the existing ZIP and set the asset
manifest homepage to `/`, with the ZIP copy of that manifest synchronized.
**Repair prepared in [PR #618](https://github.com/cacheplane/b4run/pull/618), which remains unmerged and undeployed; production verification pending.** No new
brand landing page is required.

This inventory combines current HTTP/API reads, repository source, and explicitly
identified historical account evidence. It does not establish that every external
account has been found. “Unknown” is not “not used.” This inventory subtask changed no external resources,
DNS, redirects, mail settings, credentials, CI configuration, or published content.
The parent task performed separately authorized cleanup and the owner-approved OpenSSF submission recorded below and in the
cutover runbook. No messages or emails were sent by this subtask.

## Accounts and resources

“Pre-rename state” below deliberately avoids repeating retired product names in
active guidance. Historical observations remain in the linked vendor audit.
Named technical ownership does not establish who has billing or editorial authority.

| Account/resource | URL or resource ID | Owner | Pre-rename state / current usage evidence | Required action and verification status |
|---|---|---|---|---|
| Product repository/profile | [cacheplane/b4run](https://github.com/cacheplane/b4run) | GitHub organization `cacheplane`; maintainer Brian Love named on the public homepage | Current `gh api repos/cacheplane/b4run` returns final repository name, homepage `https://b4.run`, description “Build LangGraph agents like Next.js apps.” and enabled Discussions. Header/footer point here. | **Verified current.** Account billing/support display names were not inspected. |
| Organization profile | [cacheplane](https://github.com/cacheplane), `cacheplane/.github/profile/README.md` | `cacheplane`; individual editor unknown | Current API content names B4.run, `@b4run/*`, the final repository and docs. [Commit 8040b3c](https://github.com/cacheplane/.github/commit/8040b3c0e35b5efd003999114ca7b6d5852473ff) changes that README. | **Verified current.** Existing profile update is retained; no publication needed for this finding. |
| OpenSSF Best Practices profile | [project 13317](https://www.bestpractices.dev/en/projects/13317/passing) | Authenticated project owner; submission explicitly approved | September 10 profile reads confirm `B4.run`, `https://b4.run`, and `https://github.com/cacheplane/b4run`. Exactly three identity fields and seven evidence-link prefixes changed, plus two server timestamps. | **Verified current.** All 194 status fields unchanged; passing remains 100%. Owner approved submission after disclosure of the CDLA license notice; see the concise receipt below. |
| Blog author profile | [blove](https://github.com/blove) | Brian Love, per `apps/web/app/components/blog/post-index.ts` | Source author mapping links Brian Love to this personal GitHub profile and `/brand/brian.jpg`. | **Source verified.** No separate personal-profile rebranding requirement established. |
| Website hosting | [b4.run](https://b4.run), Vercel project `prj_Syd2iGdPVSDoqtZCqqP2XeWnNlLB` | Historical vendor audit: Cacheplane team `team_RWMT2bzjj1nkSXI3N3arQ6CP`; individual account owner unknown | Current homepage HTTP 200. Earlier audit identifies renamed project `b4-run`; this pass did not re-read authenticated project settings. | **Public site verified; account metadata historical.** The parent task prepared surviving-link repairs to the existing ZIP; verify deployment afterward. The intentionally removed `/brand` route should remain absent. |
| npm public organization | [b4run](https://www.npmjs.com/org/b4run) | npm owner `blove` authenticated for trust management | All 21 package publishers verified for `cacheplane/b4run`, `release.yml`, publish/staged-publish permissions, and no environment restriction. Dedicated bootstrap token revoked; repository bootstrap secret and authorization variable removed. | **Publisher settings and retirement verified.** [#599](https://github.com/cacheplane/b4run/issues/599) closed; actual production OIDC proof remains open in [#619](https://github.com/cacheplane/b4run/issues/619) for the next ordinary release. See the cutover receipt; no throwaway release. |
| Brand page and asset catalog | [brand page](https://b4.run/brand), [manifest](https://b4.run/brand/assets.json), [ZIP](https://b4.run/brand/b4-run-brand-assets.zip) | Repository maintainers; editorial owner unknown | Manifest identifies B4.run, version `2026-09-07`, eight public asset entries and the ZIP. `/brand` is 404; manifest, ZIP and all eight entries are 200. | **Repair prepared; deployment pending:** point MobileMenu, not-found and issue-template links to the existing ZIP; set manifest homepage to `/` and synchronize the archived manifest. Keep the intentional route removal. |
| Social previews, favicons and app icons | [OG image](https://b4.run/opengraph-image), `/favicon.ico`, `/site.webmanifest`, PNG variants under the website root | Repository maintainers; design owner unknown | Live root/docs metadata uses `B4.run`, `summary_large_image` and `/opengraph-image`; icons and manifest respond 200. Source layout and structured data use B4.run. | **HTTP and metadata verified.** Local horizontal PNG visually reads B4.run. Full remote-image visual QA and previews inside third-party social platforms remain unverified. |
| Demo video hosting and transcripts | Vercel Blob `store_9RQ8eZyGheVy0wOp`; host `9rq8ezyghevy0wop.public.blob.vercel-storage.com`; prefix `/b4/demo/`; [transcript](https://github.com/cacheplane/b4run/blob/main/docs/brand/demo/transcript.md) | Historical audit associates store with Cacheplane; individual media owner unknown | Current `apps/web/app/lib/demo-media.json` selects four clips, two encodings each, four local posters and transcript anchors. All respond 200. Text describes B4.run and the `npm create b4-app@latest my-agent` closing card. | **Current links/text verified.** Playback and every video frame were not re-reviewed. Parent-task cleanup deleted all eight pre-rename `/demo/` objects after the 83-page reference audit; parent reports fresh HEAD checks: all eight retired URLs 404 and all eight current URLs 200. Historical store-label details remain in the cutover inventory. |
| Public support/community contact | [Discussions](https://github.com/cacheplane/b4run/discussions), [Issues](https://github.com/cacheplane/b4run/issues), [private security reporting](https://github.com/cacheplane/b4run/security/advisories/new) | Repository maintainers | `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and `.github/ISSUE_TEMPLATE/config.yml` route contacts through GitHub. The API confirms Discussions enabled. | **Published routing verified.** No ticket/report was created and private reporting was not submitted. No B4-specific mailbox is evidenced in these sources. |
| Organization email contact | `hello@cacheplane.ai`, published in organization profile | Cacheplane; mailbox administrator unknown | Current organization README explicitly publishes this address. It is an organization contact, not evidence of a B4 sender domain. | **Published address verified; delivery unknown.** Preserve the organization identity unless its owner supplies a concrete change. No email sent. |
| Email/newsletters/templates | Resend account identity unknown; verified domains `threadplane.ai` (`3b778706-790a-478a-ada5-4b7c7cba9d26`) and `cacheplane.ai` (`d06fd468-31e6-4254-98ff-e8d7be35916b`) | Unknown | Current authenticated `GET /domains` returned 200, `has_more: false`, these two domains, both verified in `us-east-1`; no B4 sender domain. No B4 email/newsletter integration found in website source. | **Domain inventory verified; B4 email use unknown.** Preserve other-product domains. Owner must identify templates, campaigns, reply-to/support addresses and billing display names; these were not queried. No new sender domain or vendor required by this inventory. |
| Website analytics | Account/vendor/property ID unknown | Unknown | Website dependency list and layout contain no analytics SDK; sampled live HTML has only same-origin Next.js script sources. Searches found no GA/GTM, Plausible, PostHog or Vercel Analytics instrumentation in website source. | **Unknown account use.** This does not rule out dashboard-enabled collection or integrations outside the repository. Owner must identify actual account/property and establish continuity before any changes. |
| Search-engine ownership and indexing | [sitemap](https://b4.run/sitemap.xml), [robots](https://b4.run/robots.txt); Google Search Console/Bing account or property unknown | Unknown | Live robots advertises B4.run host/sitemap. All 83 sitemap locations use `https://b4.run/`. No search-verification metadata was present in the two sampled pages; no source verification integration identified. | **Public crawl inputs verified; ownership/indexing unknown.** Identify the actual console/property, then inspect domain ownership, submitted sitemap, ingestion and index coverage. Public HTTP success does not prove submission or indexing. |
| On-site docs search | `apps/web/app/components/docs/DocsSearch.tsx`, `search-index.ts`, `docs-search-results.ts` | Repository maintainers | Search builds a local content index and filters results in the client with `useMemo`; no hosted-search call appears in this implementation. | **Implementation identified.** No Algolia or other hosted-search migration is established; accounts outside this implementation remain unknown. |
| Social handles and chat/community accounts | X/Twitter, LinkedIn, YouTube, Discord, Slack, Bluesky, Mastodon: specific URLs/IDs unknown | Unknown | No product-profile links for these platforms found in inspected website source. Twitter metadata specifies a card, not a handle. Provider/ecosystem outbound links do not establish product accounts. | **Unknown.** Owner must identify used accounts and editors, then prepare exact display-name, biography, website-link, avatar and banner edits. No outreach or announcements authorized by this inventory. |
| Design libraries, external media kits, marketing/billing/support profiles | Account/vendor/file IDs unknown | Unknown | Repository contains its own brand assets; no external design-library or marketing-platform resource identified by this pass. | **Unknown.** Owner must name resources and access holders. Prepare edits against those actual resources; do not add a vendor merely to fill the table. |

## Verification evidence

Read-only Python HTTP GET/HEAD requests on 2026-09-09 returned:

| Surface | Observed result |
|---|---|
| Homepage `/` | 200 HTML; canonical and `og:url` exactly `https://b4.run`; `og:site_name` B4.run; OG/Twitter image `https://b4.run/opengraph-image`. |
| `/docs/getting-started` | 200 HTML; canonical and `og:url` exactly `https://b4.run/docs/getting-started`; B4.run social metadata. |
| `/brand` | 404 on both GET and HEAD. The homepage links this URL. No matching app route found in source, and it is absent from the sitemap. |
| `/opengraph-image` | 200 `image/png`, 57,417 bytes. Metadata declares 1200 × 630. |
| `/twitter-image` | 404. Current live Twitter metadata uses `/opengraph-image`, so this is not a broken current metadata reference. Layout comments mentioning a re-export are stale source commentary. |
| `/brand/assets.json` and ZIP | 200 JSON and ZIP; ZIP 276,153 bytes. All eight manifest asset URLs return 200 with corresponding SVG/PNG/ICO/manifest types. |
| ZIP integrity before prepared repair | Live ZIP SHA256 `e545e90662791b9ae7c34a085d8ecb8b1085ccdad3d26a221205e069c4504082` equaled the local ZIP at initial audit. The subsequently prepared manifest synchronization changes the local archive; deployment and its new digest remain pending. `unzip -l` lists 22 B4-named files, including logos, app icons, social cards, tokens and README. |
| Favicons and app icons | ICO, 16/32/48/64 PNGs, Apple touch icon, Android 192/512 icons all 200 with image content types. Webmanifest is 200 and both name fields are B4.run. |
| Demo clips | `product-loop`, `author`, `test`, `run`: all eight MP4/WebM URLs are 200 with correct video types; four posters are 200 `image/webp`. No playback inference is made from HEAD responses. |
| Demo transcripts | All four GitHub document URLs return 200. Source headings correspond to the four catalog fragments. HTTP does not independently validate browser fragment navigation. |
| Pre-rename demo references | GET all 83 sitemap pages: 83 HTTP 200, no failures, zero occurrences of the exact Blob host plus `/demo/` prefix. Checked raw HTML and normalized escaped slashes, Unicode slash escapes and HTML slash entities. This covers currently rendered sitemap pages, not external bookmarks or unsampled deployed bundles. |
| Crawl inputs | Robots and sitemap both 200; robots permits `/`, disallows `/api/`, and advertises the B4.run sitemap. XML parsing found 83 locations, all on the final origin. |
| Resend domain read | Authenticated `GET https://api.resend.com/domains`: 200; complete two-domain response (`has_more: false`). Only public domain IDs, names, verification status and region were emitted. No email content, contacts, campaigns or send endpoint accessed. |
| Account/profile reads | `gh api repos/cacheplane/b4run`, organization profile content, and organization profile commit `8040b3c` succeeded. Only public profile/repository fields were emitted. |

The root configuration **key-name inventory** contains: `VERCEL_API_TOKEN`,
`NPM_TOKEN`, `LANGSMITH_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`RESEND_API_KEY`. No values were printed or saved. After explicit parent-task authorization, only
the Resend credential was loaded in memory for the read-only domain list; the
other credentials were not used. LangSmith and model-provider keys do not establish marketing dependencies. The
[earlier vendor audit](../plans/2026-09-07-b4-run-vendor-audit.md) is historical
account evidence, not fresh verification of access or settings.

## Parent-task cleanup update

After the 83-page reference audit, the parent task deleted the eight pre-rename
Blob objects under `/demo/`. Its fresh HEAD verification found all eight retired
URLs returning 404 and all eight current `/b4/demo/` URLs returning 200. The parent
also removed the unbound pre-rename native deployment domain and bootstrap
placeholder alias. These were parent-task operations, not mutations by this
inventory subtask; see the [cutover runbook](2026-09-09-b4-run-cutover.md) for
authorization, resource scope and cleanup receipts. The brand-link repair is
prepared separately; it must not be described as deployed until live verification.

## September 10 owner-approved updates

The OpenSSF profile submission updated exactly ten branding fields: `name`,
`homepage_url`, `repo_url`, and seven existing evidence-link prefixes. Only the
server-managed `updated_at` and `repo_url_updated_at` timestamps changed in
addition. Comparison of the before/after API snapshots confirms all 194
`*_status` fields unchanged, `badge_level: passing`, and `badge_percentage_0: 100`.
The owner explicitly approved the submission after disclosure of the CDLA
license notice. The stored `project_entry_license` field was unchanged at
`CC-BY-3.0+`; the submission notice and stored field are separate observations.
The [concise receipt](./2026-09-10-b4-openssf-profile.json) retains current public
identity and change counts, without copying historical account snapshots.

The owner also explicitly approved keeping the existing old-website and GitHub
rename redirects, superseding the initial no-redirect requirement. Runtime and
package compatibility aliases remain prohibited. This resolves the earlier
policy ambiguity without changing the brand-link repair: PR #618 still awaits
merge, deployment, and production verification.

## Follow-up and closure

1. Deploy and verify the prepared link repair. Acceptance: MobileMenu, not-found
   and issue-template brand links target the existing ZIP; public manifest homepage
   is `/`; the ZIP contains the synchronized manifest; downloads respond 200.
   Preserve the intentional absence of `/brand`; a new page or redirect is not
   part of the repair.
2. Have the account owner supply exact resource URLs/IDs and responsible editors
   for the unknown rows, including confirmation where a service is not used.
   A credential name or absent source match cannot close an account row.
3. For identified search/analytics resources, record current B4.run ownership,
   sitemap ingestion, indexing status and event continuity using their actual
   dashboards/APIs. Revisit crawl coverage after the provider processing period.
4. Prepare concrete profile, template and design edits with original/replacement
   text or assets. Obtain explicit authorization before announcements or messages.
5. Retain this read-only evidence alongside the
   [cutover runbook](2026-09-09-b4-run-cutover.md). Close issue #602 only when
   assigned account owners and website follow-ups supply verification results;
   this inventory alone does not close external-account work.

Documentation-only artifact validation: check whitespace and new-file brand
strings; runtime/package tests are not meaningful for this inventory. No source,
package behavior or CI configuration was edited by this inventory subtask. The
parent task owns the separate website repair and its validation.

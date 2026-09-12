# Paper Relay Public Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution, or superpowers:subagent-driven-development if the user chooses delegated execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public identity kit and its downloadable archive accurately express the approved Paper Relay system.

**Architecture:** Keep the D2.2 masters and established asset URLs. Update the public guidance, identity page, visual usage sheet, and manifest as one synchronized kit, then rebuild the existing ZIP without dropping its contents. The repository guidelines remain normative; the public copy must match their rules.

**Tech Stack:** Markdown, static HTML/CSS, native SVG, PNG, JSON, Python standard-library ZIP validation, and the existing pnpm/Next.js validation environment.

---

## Scope and references

- Approved design: [brand foundations spec](../specs/2026-09-12-paper-relay-brand-foundations-design.md).
- Normative rules: [brand guidelines](../../brand/guidelines.md).
- Existing branch: `brand/d2-2-identity-kit`, associated with PR #631.
- Work from the repository root in this existing worktree.
- Excluded: homepage content, architecture and styling; docs UI and navigation;
  production favicons; account avatars; marketing campaigns; runtime behavior.
- The identity kit page itself is in scope. It is a static brand reference, not
  the marketing homepage. Do not import the exploratory homepage composition.
- Retain Tight Shift files and palette values at their current paths; label them
  as archived alternatives rather than presenting a second approved default.

## File map

| File | Responsibility |
| --- | --- |
| `docs/brand/guidelines.md` | Normative brand rules; update only snapshot/publication status for this phase |
| `docs/brand/README.md` | Discoverability and accurate kit status |
| `apps/web/public/brand/identity/guidelines.md` (new) | Portable public copy of approved rules, with local kit links |
| `apps/web/public/brand/identity/usage-notes.md` | Existing stable entrypoint: concise approved guidance and link to full guidelines |
| `apps/web/public/brand/identity/index.html` | Brand reference page and exact-size proofs |
| `apps/web/public/brand/identity/usage-sheet.svg` | Editable composition showing the approved system |
| `apps/web/public/brand/identity/usage-sheet.png` | 1200 × 1800 raster counterpart of the sheet |
| `apps/web/public/brand/identity/fonts/` (new, if needed for the reference page) | Inter and JetBrains Mono fonts used by the sheet/page, plus their original license texts |
| `apps/web/public/brand/assets.json` | Stable asset inventory with approved preference and status metadata |
| `apps/web/public/brand/b4-run-brand-assets.zip` | Synchronized offline kit retaining the existing archive layout |

No changes to logo master paths, their geometry, the existing icon exports,
`BrandLogo.tsx`, or `opengraph-image.tsx` are required in this increment.

## Task 1: Establish the baseline and public guidance

- [ ] Confirm `git status --short --branch` and `gh pr view 631 --json headRefName,headRefOid,state`.
  Expected: the PR branch is checked out, with the approved guideline commits.
  Reconcile new upstream changes before editing; do not overwrite another writer.
- [ ] Run `pnpm install --frozen-lockfile` to restore the checkout's dependencies.
  The preceding docs check failed to start because `tsx` was missing. Confirm the
  install succeeds; do not change the lockfile to resolve a local setup issue.
- [ ] Save the pre-change ZIP, manifest, and master checksums outside the repository:

```bash
python3 - <<'PY'
from pathlib import Path
import hashlib, json, shutil, tempfile
root = Path.cwd()
baseline = Path(tempfile.mkdtemp(prefix="b4-kit-baseline-"))
public = root / "apps/web/public"
shutil.copy2(public / "brand/b4-run-brand-assets.zip", baseline / "kit.zip")
shutil.copy2(public / "brand/assets.json", baseline / "assets.json")
masters = sorted((public / "brand/identity/logos").glob("*.svg"))
masters += sorted((public / "brand").glob("*.svg"))
(baseline / "masters.json").write_text(json.dumps({
    str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
    for p in masters
}, indent=2))
print(baseline)
PY
```

  Export the printed path with `export B4_KIT_BASELINE='/the/printed/path'` for
  subsequent commands. This variable
  must refer to that existing baseline directory, not a freshly generated snapshot.
- [ ] Update the guidelines' status section to say that the public kit now follows
  Paper Relay, once the synchronization in this plan is complete. Keep the approved
  rules and deferred homepage boundary intact. Change README snapshot wording to
  match. Prepare these edits together with the kit, not as an early published claim.
- [ ] Create the public `identity/guidelines.md` from the approved guidelines.
  Adapt repository links to portable local paths: `logos/`, `icons/`, `index.html`,
  and `usage-notes.md`. Point the download link to the absolute public ZIP URL so
  it also works from the extracted archive. Add a source link to the repository
  guidelines. Preserve the rules and values; do not maintain a divergent design.
- [ ] Rewrite the existing `usage-notes.md` as a concise summary: approved palette,
  unchanged D2.2 geometry, clear space and starting sizes, Inter/JetBrains Mono,
  archived Tight Shift status, and a relative `guidelines.md` link. Explicitly
  distinguish reference examples from homepage positioning or claims.

## Task 2: Synchronize the visual reference

- [ ] Recompose the existing 1200 × 1800 SVG usage sheet around five sections:
  primary/compact marks; paper/ink/Relay/dark color roles; clear-space and small-size
  proofs; typography hierarchy; separate dot graphic usage. Use the approved
  guideline values. Keep a 48 px outer margin and avoid screenshot text too small
  to read at normal viewing size.
- [ ] Replace the equal-weight orange palette panels with typography/role guidance.
  Keep a short archival note linking to existing Tight Shift files on the HTML
  page. Remove the old unapproved slogans and miniature homepage study from the
  primary sheet. Use neutral specimen labels, not new marketing claims.
- [ ] Load Inter and JetBrains Mono from their official distributions for rendering.
  If the HTML/SVG needs distributed font files, add only the required files and
  their original licenses under `identity/fonts/`. Use relative paths and include
  them in the archive. Do not reuse temporary embedded font blobs without licenses.
- [ ] Preserve logo character groups and geometry when placing masters into the
  sheet. Reference or nest the original vectors; never typeset or redraw the logo.
  For sheet captions, use licensed fonts. If the chosen SVG renderer cannot resolve
  fonts reliably, outline caption text in the distributable SVG and retain the
  editable text composition as `identity/usage-sheet-source.svg` in the kit.
- [ ] Render `usage-sheet.png` from the final SVG at exactly 1200 × 1800. Use a
  browser or installed SVG renderer with fonts loaded. Compare the SVG and PNG
  visually; do not assume an export succeeded because a file was created.
- [ ] Update `index.html` to present the new sheet and approved guidance. Reference
  `usage-sheet.svg` as an image instead of maintaining a second inline copy of the
  entire sheet. Keep the existing exact-size proof images and their paths. Add
  readable HTML summaries of typography, color roles, and logo clear space, plus
  links to the full guidelines and archived alternatives.
- [ ] Inspect the identity page at desktop and narrow widths. Confirm there is no
  horizontal page overflow, clipped copy, illegible labeling, or broken image.
  Check loaded and fallback fonts, keyboard focus, and small-size logo proofs.
  The whole page must remain understandable without relying on SVG text alone.

## Task 3: Manifest and offline archive

- [ ] Set manifest version to `2026-09-12-paper-relay-v1`. Keep every existing asset
  ID and URL. Set `usage.preferredLogo` to `logo-horizontal-black-svg` and
  `usage.preferredIcon` to `icon-black-svg`; describe these as preferences for
  paper/light surfaces, not evidence of a deployed header or favicon change.
- [ ] Keep `usage.guidelinesUrl` at its stable `/brand/identity/usage-notes.md`
  entrypoint and link onward to full guidelines. Add root `defaultPalette: "relay"`
  and `paletteStatus: { "relay": "approved", "tightShift": "archived" }` metadata.
  Preserve existing palette values. Label Tight Shift assets as archived and
  remove current-default recommendations from those entries.
- [ ] Update the sheet label/description to Paper Relay and retain its documented
  1200 × 1800 dimensions. Validate all manifest URLs against `apps/web/public`.
- [ ] Rebuild the ZIP from the saved baseline, replacing the `identity/` subtree
  with the current public subtree. Preserve all other old entries and their bytes,
  except the archive-root manifest and README, which are deliberately updated.
  Replace `assets.json` at archive root; its URLs are online public URLs,
  which must be explained in an archive-root `README.md`. The offline entrypoint
  is `identity/index.html`, with relative image/font/guidance links.

```bash
python3 - <<'PY'
from pathlib import Path
import os, zipfile
baseline = Path(os.environ["B4_KIT_BASELINE"])
public = Path("apps/web/public")
target = public / "brand/b4-run-brand-assets.zip"
prefix = "b4-run-brand-assets/"
with zipfile.ZipFile(baseline / "kit.zip") as old, zipfile.ZipFile(
    target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
) as new:
    for entry in old.infolist():
        if not entry.filename.startswith(prefix + "identity/"):
            if entry.filename not in (prefix + "assets.json", prefix + "README.md"):
                new.writestr(entry, old.read(entry.filename))
    for p in sorted((public / "brand/identity").rglob("*")):
        if p.is_file():
            new.write(p, prefix + "identity/" + p.relative_to(public / "brand/identity").as_posix())
    new.write(public / "brand/assets.json", prefix + "assets.json")
    new.writestr(prefix + "README.md", "# b4.run — Paper Relay\n\n"
        "Open identity/index.html for the offline brand reference.\n"
        "Read identity/guidelines.md for the full rules.\n"
        "The URLs in assets.json refer to public files at https://b4.run.\n"
        "Tight Shift files are archived alternatives.\n")
print(target)
PY
```

## Task 4: Verify, review, and submit

- [ ] Run the focused integrity checks below. Expected: all assertions pass.

```bash
python3 - <<'PY'
from pathlib import Path
import hashlib, json, os, struct, zipfile
baseline = Path(os.environ["B4_KIT_BASELINE"])
public = Path("apps/web/public")
manifest = json.loads((public / "brand/assets.json").read_text())
previous = json.loads((baseline / "assets.json").read_text())
current = {a["id"]: a for a in manifest["assets"]}
assert len(current) == len(manifest["assets"]), "duplicate asset IDs"
for asset in previous["assets"]:
    assert current[asset["id"]]["url"] == asset["url"]
for asset in current.values():
    assert (public / asset["url"].lstrip("/")).is_file(), asset["url"]
for path, digest in json.loads((baseline / "masters.json").read_text()).items():
    assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest, path
png = (public / "brand/identity/usage-sheet.png").read_bytes()
assert png[:8] == b"\x89PNG\r\n\x1a\n"
assert struct.unpack(">II", png[16:24]) == (1200, 1800)
prefix = "b4-run-brand-assets/"
with zipfile.ZipFile(baseline / "kit.zip") as old, zipfile.ZipFile(public / "brand/b4-run-brand-assets.zip") as new:
    assert new.testzip() is None
    assert len(new.namelist()) == len(set(new.namelist())), "duplicate ZIP entries"
    assert set(old.namelist()) <= set(new.namelist()), "lost archived paths"
    for name in old.namelist():
        if not name.startswith(prefix + "identity/") and name not in (
            prefix + "assets.json", prefix + "README.md"
        ):
            assert old.read(name) == new.read(name), name
    for p in (public / "brand/identity").rglob("*"):
        if p.is_file():
            name = prefix + "identity/" + p.relative_to(public / "brand/identity").as_posix()
            assert new.read(name) == p.read_bytes(), name
    assert new.read(prefix + "assets.json") == (public / "brand/assets.json").read_bytes()
print("Manifest URLs, master hashes, PNG size, ZIP integrity, and synchronization passed")
PY
```

- [ ] Extract the new ZIP into a temporary directory and open its identity page
  with network disabled. Confirm local assets, fonts, and guideline links load.
  Inspect every relative Markdown link from both public and extracted contexts.
  External repository/download links should be visibly external; they need not
  work offline. Check the PNG at full size and in the responsive reference page.
- [ ] Run `git diff --check`, `pnpm --filter @b4run/web lint`, and
  `node scripts/check-docs.mjs`. Resolve failures attributable to this change;
  report any environment blocker with the actual command and error.
- [ ] Review the diff against the file map. Confirm the underlying website,
  production icons, logo masters, and technical claims have not changed.
  Commit the synchronized kit as one cohesive change, including docs status.
- [ ] Run `node scripts/check-changesets.mjs` against the committed head. No
  changeset is expected for this non-published website/brand-only change.
- [ ] Run the repository validation required by `AGENTS.md` before claiming the
  PR is fully validated: `pnpm ci:validate`. This path is not the narrow
  runbook-prose exception. Record any skipped or blocked checks precisely.
- [ ] Obtain a focused review of asset fidelity, archive synchronization, public
  guidance, and the explicit homepage boundary. Fix findings before submission.
- [ ] Before pushing, inspect `gh run list --repo cacheplane/b4run --limit 50
  --json status,event,headBranch,workflowName` and relevant active runs. Respect
  the limit of two maintainer-managed full-CI PRs, accounting for main validation;
  wait for active runs rather than cancelling release work.
- [ ] Update PR #631's description to cover the final synchronized Paper Relay
  kit and the actual checks performed. Use a body file for multiline text. Push
  only after local checks/review and the repository's CI submission constraint
  permit it; verify the PR points to the intended head and report its CI status.

## Handoff

Implementation has not started. This plan covers public-kit synchronization only.
The next independent workstreams are shared UI/docs styling, a fresh homepage
narrative and architecture phase, and format-specific marketing rollout.

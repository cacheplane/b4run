# Homepage walkthrough narrative implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preview the approved developer walkthrough as the homepage narrative, showing real readable example code.

**Architecture:** Preserve Paper Relay branding and hero. Replace the capability-tab composition with sequential server-rendered code sections: agent, workspace/sandbox, typed tools, plan/skill, independent verification, approval. Reuse CodePanel highlighting and copy behavior. Show the existing historical recording as supporting evidence below the narrative. Preserve the qualified 0.8.32 installation guide and identify it separately from the revised source preview.

**Tech Stack:** Next.js, React, CSS modules, Shiki, Vitest, Playwright CLI.

## Tasks
- [x] Add `narrative-source.json` containing exact local example source and contiguous excerpt ranges; add a regression test comparing snapshots with the real example and verifying displayed snippets. No network fetches during rendering. The local preview will not invent published links for uncommitted source.
- [x] Add `Narrative.tsx` with short prose beside copyable code. Show the full updated prepareReview tool. Keep plans and skills as guidance, verification and approval as enforced behavior. Add JSON highlighting for the host-owned checks policy.
- [x] Update `DeveloperHome.tsx` to present narrative, supporting historical recording, and installation CTA. Retain the hero, shared header/footer, and docs layout. Distinguish the current source preview from the qualified installation and historical recorded timing.
- [x] Add responsive CSS in `homepage.module.css`. Keep useful code widths, section anchors, accessible contrast and keyboard-scrolling code. Reuse CodePanel, allowing no external source link for preview source.
- [x] Update homepage rendering tests for ordered sections, no-JavaScript content, actual source, and historical provenance. Run homepage tests, web lint/typecheck, and metadata freshness checks.
- [x] Start a local Next development server. Use Playwright CLI for desktop/mobile screenshots, overflow checks, copy/instructions/recording interactions. Open the local URL in the user's browser panel. Deliver preview, not a deployment or PR.

## Review clarifications

The current source preview makes no timing or release-qualification claim. Historical recording preserves its original source, model, timing and checks; evidence JSON/exporter stay unchanged. The install guide remains at commit 0003db2802b718ed167c8266b09a2d00ae01a522 / B4 0.8.32. Tests must assert the full tool renders without folding and clipboard content equals actual source. Retain prerequisite/docs/report links and guide-printing wording. Run a web build and scoped docs checks before preview delivery.

## Preview verification

84 homepage and SEO tests pass. Web lint, typecheck, docs check and production build pass. Desktop 1440px and mobile 390px previews checked; no page or narrative-code overflow. Real browser copy, instruction expansion, recording expansion and reproduction-step selection pass. The recorded example link is pinned to the evidence source revision. Preview served at http://127.0.0.1:3017/.

## Approved bookends and reduced copy

Add a compact linked project map before the code and a six-step execution flow afterward. Replace the chapter navigation with file links. Trim each chapter to one explanatory sentence and one docs link; remove repeated callouts. Keep exact source, full readable tool, provenance boundaries and installation semantics. Verify anchors, section order, mobile layout and existing interactions.

Bookends verified: 85 homepage/SEO tests, web lint/typecheck/build and docs checks pass. Desktop and 390px mobile layouts checked; project links resolve to the code sections. Preview anchors: #project and #workflow.

## Publication

User approved PR and merge on green. Narrative source is now linked to the exact committed example revision; copy describes current example source rather than a local preview. The older qualified installation pin and recording are unchanged.

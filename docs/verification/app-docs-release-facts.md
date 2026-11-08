# App docs release facts

Checked November 5, 2026 (America/Los_Angeles). Website base: c1e179655. App source: a7e1ef743cebaf3704a3fa37ede72db8018df12d, version constant 0.1.0. This is source/release-inventory evidence, not a live acceptance run of a released app.

## Release qualification

| Claim | Evidence | Status |
| --- | --- | --- |
| Product name is Agent Workspace | b4app `docs/release.md`, cask template, website `/app/download` | Source verified |
| Production Mac package exists | `gh release list --repo cacheplane/b4app`: hub-v0.1.0 through hub-v0.5.0 only | Pending publication: no Mac release |
| Homebrew installation works | GitHub contents API for cacheplane/homebrew-tap/Casks/agent-workspace.rb returned 404, repository empty | Pending publication: no published cask |
| Website download entry responds | HTTPS HEAD `/app/download` returned 200 | Reachability verified; linked asset not qualified |
| Minimum platform | b4app project.yml macOS 26.0 / iOS 26.0; README Apple Silicon prerequisite | Source verified; package install pending |
| App distribution on iPhone | No App Store or TestFlight link identified in checked source | Pending release link; placeholder authorized |
| Runtime versions | b4app `docs/compatibility.md`; runtime-specific fixture/live statuses must remain distinct | Needs released-build check |

## Behavioral source inventory

| Guide | Source evidence in b4app | Qualification before publication |
| --- | --- | --- |
| Overview | README; WorkspaceProtocol/Domain.swift; HubSync and Mirror | Mac/provider/hub boundaries source verified; real release walkthrough pending |
| Install/sign-in | WorkspaceUI/SignIn/SignInView.swift, OnboardingView.swift; docs/release.md | Account choices source verified; download/install/sign-in pending |
| Codex | WorkspaceUI/ConnectionsView.swift, ConnectionCardView.swift; CodexAdapter | Reuse/auth flow source verified; installed released runtime check pending |
| Claude Code | same connections UI; ClaudeAdapter | Official terminal authentication source verified; released live check pending |
| First conversation | NewThread/NewThreadView.swift; WorkspaceModel.swift; D-183, D-088 | First-message start, default permissions, streaming source verified; UI walkthrough pending |
| Manage work | ProjectSections.swift; WorkspaceModel.swift; README lifecycle sections | Search/pin/archive and account lifecycle source verified; visible controls/quit behavior pending |
| iPhone | SignIn/AddPhoneView.swift; WorkspaceMirror/MirrorRelay.swift; website help | Pairing/source verified; real device distribution and push verification pending |
| Accounts/data | Coordinator/Accounts; WorkspaceMirror/MirrorAccount.swift; WorkspaceSecrets | Separate accounts and sync boundaries source verified; deletion release audit pending |
| Troubleshooting | WorkspaceUI/Remediation.swift and DiagnosticsView.swift where present; protocol errors | Recovery semantics source verified; released labels pending |
| B4 agents | WorkspaceUI/B4ProjectsView.swift, ConnectionSheets.swift; LocalServerService.swift | Source-backed connection paths; Read-only aircraft lookup live-qualified with beta 0.1.0 on November 6; production compatibility pending |

## Terminology and publication gate

Use Agent Workspace for the product name and b4app when identifying the repository/app docs. A conversation contains turns; a turn may contain tool calls and runtime requests. App account and provider account are separate. App CLI (`agent-workspace`) and Framework CLI (`b4`) are different tools.

The ten local guide drafts are for review. At the owner’s direction, the installation page includes the planned Homebrew command and clearly labeled Mac/iPhone download placeholders. The command is source-backed and awaits publication of the cask. Replace both download placeholders and validate the command before launch. Navigation and source checks can pass independently, but these guides are not cleared for deployment as production onboarding until Mac release, phone distribution, provider compatibility and real UI verification above are resolved. No model calls or personal account mutations were performed for this inventory.

## Generated Navlog qualification finding (November 5; resolved November 6)

The repository framework harness run during navigation verification failed its generated Navlog activation scenario. Its third AG-UI request returned HTTP 409 with `details.code = malformed_checkpoint` and the message `Pending checkpoint interrupts cannot be addressed safely`. The first two requests returned 200. The harness used its local mock model service; this was not a released-app or real-provider acceptance run. No framework runtime code changed in this branch. This was a capture blocker at the time of the November 5 check; the resolution is recorded below.

Evidence: `artifacts/testing/harness-2026-11-06T061312-352Z-22411/framework/vitest-report.json`; preserved generated app and AG-UI transcript under the temporary `b4-generated-navlog-activation-Hx5pyp` directory named by that report.

## November 6 qualification update

The `malformed_checkpoint` defect was corrected in framework revision `dd4271cbe69e49fb49b0587c30b5b4dbf733a0c7`. The checkpoint parser now validates both singleton and array interrupt representations. Parser/endpoint/resume checks passed (108 tests, one skipped), and all nine generated Navlog lifecycle tests passed. The earlier failing harness record remains historical evidence, not an outstanding capture blocker.

The installed B4 beta 0.1.0 build then completed the read-only Navlog aircraft lesson: two prompts, two completed turns, four tool calls and 125 observed events. The reviewed capture and pinned source are now used by the first-conversation guide. See [capture qualification](app-docs-capture-matrix.md) for binary/recorder/runtime identities and review details. The installed beta binary does not report a source revision; that field remains unavailable.

This qualifies the B4 lesson only. It does not qualify production downloads, Homebrew installation, provider-specific connection flows, iPhone pairing/push, approval or cancellation footage. Download placeholders and the prospective Homebrew command remain explicitly authorized by the owner. Production release qualification is still open.

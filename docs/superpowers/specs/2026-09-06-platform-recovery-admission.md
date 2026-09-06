# Platform workflows in recovery admission

Goal: unblock the existing post-publication recovery by representing GitHub's two known platform workflows accurately. Keep the existing controller and release protocol.

Add one `platform-nonwriter` topology variant with exact workflow ID, exact path, fixed service discriminator and digest-addressed review record. Only the Copilot reviewer and Dependabot updates paths are supported. The parent contract already binds repository and candidate; the review must repeat and match those identities. Do not accept arbitrary dynamic paths or ordinary nonwriters with empty sources.

The review is a bounded, dated semantic assertion that this service cannot mutate this candidate release or its evidence under the observed repository-accessible configuration. It records rationale, supporting observations, explicit operational assumptions and an expiry no more than 24 hours after observation. A hash binds reviewed bytes; it does not prove their truth. Unobservable authority remains a review blocker, not an empty inventory. Settings changes require reassessment.

At every fence observation, read the review from the executing controller commit, validate its digest, identities and time window, and freshly check relevant Git configuration against a complete path manifest. Include absence by comparing the entire set of relevant paths, not by accepting a failed git read. Dependabot configuration and Copilot setup, instructions/skills and MCP configuration inputs must be covered; current AGENTS.md must be included where applicable. Reject new/missing/modified relevant files. Continue complete bracketed workflow inventories and all existing legacy disable/drain checks unchanged.

Keep actual platform observations outside this code change until verified and independently reviewed. No policy admission or release write is part of implementing this representation.

Validation: supported two-service fixtures succeed; wrong repo/candidate/workflow/service, unknown or replaced topology, missing/tampered/expired review, configuration additions/removals/byte changes, unavailable tree reads, future-dated observations and unsupported fields fail. Existing YAML-only tests retain their behavior. Update content/closure pins with the implementation and run focused plus full controller validation.

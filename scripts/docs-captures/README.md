# Documentation recordings

A recording is a bounded observation of one fresh B4 thread. Playback never calls a model, coordinator or hub.

1. Run the intended app build and connect the maintained Navlog example. Create a new empty thread. Keep ordinary conversations out of the recording account or use a dedicated thread that contains only the demo.
2. Start the authoring CLI against that build's coordinator. For beta, set `B4APP_FLAVOR=beta` and run `agent-workspace docs-record --thread-id <id> --output <absolute-private-file> --max-seconds 900`. Wait for readiness, submit prompts through the app, and type `finish` only after the conversation settles. EOF, timeout or stream loss invalidates the attempt. Keep intermediate files outside the website and Git.
3. Call `normalizeRecording(privateJson, { id, provenance: "live", revisions })` from `normalize.ts` using `tsx`. Pin the recorder source in `revisions.app`, and the runtime/example sources in their respective fields. Add moments only at observed event indices. Do not infer missing tool results or approval decisions.
4. Prepare a `Publication` manifest as defined in `publish.ts`. Include the normalized capture, a plain-text transcript, and only explicitly selected source files read from the example's Git revision. Each source range refers to a named moment. Record the exact app executable digest and version separately; use `null` when the installed app does not report its source revision. Do not guess from the current checkout.
5. Review every message, intermediate event field, tool argument/result, source snapshot and transcript. The secret scanner is a backstop, not the review. Record the review date, reviewer, findings and dependency provenance in the private manifest. A demo that encounters a real failure can teach that failure; never replace it with fabricated success.
6. Validate and dry-run from the repository root:

   ```sh
   pnpm exec tsx scripts/docs-captures/validate.ts /private/path/capture.json
   pnpm exec tsx scripts/docs-captures/publish.ts --manifest /private/path/review.json --dry-run
   ```

7. Omit `--dry-run` to copy the reviewed allowlist into the local website's `public/docs-recordings/`. This writes immutable content-addressed assets; it does not deploy. Add the reviewed `lesson` entry to `apps/web/lib/turn-inspector/lessons.ts`, then use `<TurnInspector lesson="..." />` and `<InspectMoment lesson="..." moment="...">...</InspectMoment>` in the lesson.

Run the inspector tests, Markdown export tests, website build and SEO checks. Inspect the actual recording in the browser at narrow and wide widths. Synthetic test fixtures must never enter the public manifest. Video and caption assets require their own review before adding them to a lesson.

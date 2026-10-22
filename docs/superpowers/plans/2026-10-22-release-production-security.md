# Production security prerequisites for 0.15.0

The owner requires remediation of the 37 high production findings before release.
Preserve the release hold until the selected production audit has no high or
critical findings and the complete release gates pass.

1. Record advisory IDs, affected lock versions and incoming owner paths from the
   fresh production audit. Ten package names account for the 37 records.
2. Add failing dependency-floor checks for each affected package/version line.
   Preserve public owner ranges and the reviewed TypeScript 6.0.2 implementation.
3. Refresh compatible dependency resolutions and maintenance versions of GraphQL
   Yoga 5 / defer-stream 3, whose current maintenance releases consume patched
   GraphQL utilities. Do not force a Yoga 6 migration into CopilotKit.
4. Upgrade the private website frontmatter plugin from 5 to 6, replacing its
   unmaintained TOML parser. Exercise the actual YAML MDX pipeline, exports,
   content index/feed/SEO checks and a production build.
5. Verify the installed graph, frozen installation, complete security suite,
   browser/runtime integration, build, typecheck, integrity, docs and lint.
   Record remaining lower-severity and development-only findings accurately.
6. Obtain independent review, then require fresh hosted CI, Windows, CopilotKit
   and Vercel checks before merging prerequisites and regenerating the minor.

The release blog remains a separate follow-up branch and must be reconciled
against the completed release artifact before its PR is published.

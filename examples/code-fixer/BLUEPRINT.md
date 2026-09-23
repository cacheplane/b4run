# Code-fixer installation blueprint

The authoritative [installation guide](../../apps/web/content/blueprints/agents/code-fixer.md)
is served through `b4 add code-fixer` and [the public Markdown route](https://b4.run/blueprints/code-fixer.md).
The command prints instructions for a coding agent to apply; it does not install
packages or run the application itself.

The guide installs ordinary B4 application files from source commit
`bfaf0c2b3030eebb572703c8f70f0e063593b1fa` with published B4 **0.10.0** packages.
See the [0.10.0 qualification record](../../docs/superpowers/runbooks/2026-09-22-code-fixer-0.10.0-qualification.md)
for the source, release, and acceptance evidence. Qualification uses scripted model
responses and real Docker workspaces. It does not claim live-model repair quality.

For development in this monorepo, use the [server README](./server/README.md).
The example remains a normal app; the blueprint is its installation guide.

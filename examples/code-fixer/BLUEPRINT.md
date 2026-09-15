# Code-fixer installation blueprint

The authoritative [installation guide](../../apps/web/content/blueprints/agents/code-fixer.md)
is served through `b4 add code-fixer` and [the public Markdown route](https://b4.run/blueprints/code-fixer.md).
The command prints instructions for a coding agent to apply; it does not install
packages or run the application itself.

The guide installs ordinary B4 application files from source commit
`0003db2802b718ed167c8266b09a2d00ae01a522` with published B4 **0.8.32** packages.
See the [standalone qualification record](../../docs/superpowers/runbooks/2026-09-15-code-fixer-standalone-qualification.md)
for the source, release and acceptance evidence. Qualification uses deterministic
replays and real Docker workspaces; it does not claim live-model repair quality.

For development in this monorepo, use the [server README](./server/README.md).
The example remains a normal app; the blueprint is its installation guide.

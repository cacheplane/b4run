---
"@b4run/devkit": patch
"create-b4-app": patch
"@b4run/testing": patch
---

The research template's web client renders media parts (images, audio, video, documents) in user messages and beside tool cards, shows a notice for each part the model did not receive (`b4.content_parts_dropped`), restores media when it hydrates a thread, and offers an image attachment when the route's capability document says its model takes images. The research server ships `renderChart`, a tool that returns a text summary and an inline SVG bar chart. `@b4run/testing`'s agent harness `run({ input })` accepts a list of content parts as well as a string.

---
"@b4run/devkit": patch
---

CopilotKit 1.76 hands `useAgent` a replacement agent instance for the same thread a beat after first render. The research web app applied a restored transcript to the first instance, so a reloaded thread came back empty in the browser. The app shell now carries an applied restore over to an empty, idle replacement instance for the same thread.

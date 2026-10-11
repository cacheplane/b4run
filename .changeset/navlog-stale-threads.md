---
"@b4run/devkit": patch
"create-b4-app": patch
---

The navlog template forgets a remembered thread the server no longer serves to this visitor. The sidebar's list lives in browser storage and ownership in the visitor cookie, so clearing the cookie left rows that opened empty and failed on the first message. Before a titled thread opens, the page asks the new guarded `GET /api/threads/:id` route (204 or 404, no thread data), and a 404 removes the thread and opens the next one. The web README explains how to reproduce it locally.

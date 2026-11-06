# App documentation demonstration storyboards

Prepared November 6, 2026. These are recording instructions, not claims that footage exists. The public pages remain complete as text and interactive replay until reviewed footage is available.

## Teaching sequence

For a conceptual lesson: show a short real demonstration, introduce the question it raises, teach the general concept, introduce Navlog and its recorded example, then teach through selected inspector moments. Setup and account pages use direct instructions rather than forcing this sequence onto every topic.

The first-conversation page already supplies the general explanation, Navlog introduction and guided inspection. Its introductory native video remains to be recorded. Do not add an empty player or label a browser replay as footage of the native app.

## First conversation: follow the evidence

Audience: someone already using a coding-agent runtime. Objective: distinguish a request, tool arguments, tool result and final answer, then recognize a new call in a follow-up turn. Navlog is the common example; running it is optional for the reader.

Target edit: approximately 60–90 seconds, adjusted to the real run. Use the beta build until the production build can be qualified. Display the actual build/flavor in the description. Footage and protocol capture must come from the same take.

| Shot | Show | Teaching point / proposed narration |
| --- | --- | --- |
| 1 | Native app, isolated Navlog conversation; submit the aircraft-profile request | “Let's ask a question we can check against a file.” Keep the prompt visible long enough to read. |
| 2 | Actual tool activity arriving | “A turn includes the work between our message and the answer. Here, the agent reads a file.” Do not promise which tool runs next before observing the take. |
| 3 | The read arguments and returned profile | “The argument tells us which file it asked for. The result tells us what came back.” Retain the real file name and values. |
| 4 | The actual final answer | “Now we can compare the answer with its source.” Preserve mismatches, missing fields and qualifications. |
| 5 | Submit the reserve/alternate-fuel follow-up in the same conversation | “This is another turn. It has its own tool calls and results.” |
| 6 | The actual response, then transition to the website inspector | “Let's slow down and inspect those steps.” Label the website segment as replay. Its lesson manifest must point to this take if presenting the footage and replay as the same run. |

Current admitted take: `navlog-aircraft`, first read at event 8, second read at event 72, completion at event 124. The request names N738ZU; the source profile names N734ST. It contains a reserve entry and no alternate-fuel entry. These are facts about the current take, not conditions to fake in a new recording. There was no weather lookup or flight-plan filing.

If the original native footage is unavailable, record a new take and qualify its protocol capture. Do not combine a new native run with the old replay while implying they are identical. A standalone walkthrough of the existing inspector is possible, but must be introduced as a recorded-conversation walkthrough.

## Overview: from a task to a result

Target edit: 30–45 seconds. Show a connected runtime, a small read-only request, real activity and its answer. Identify the runtime shown. A Navlog/B4 clip demonstrates B4; it does not demonstrate a working provider-specific login or connection. End with the relevant setup link. Include phone follow-up only after real-device qualification.

## Provider setup

Separate clips for each runtime. Begin with the actual installed runtime and authentication state, show Settings → Connections and the relevant connection flow, then a successful small request. Capture only controlled demo data. Never show a credential or private browser session. Verify labels against the recorded build; do not use the source-backed drafts as proof of an observed UI action.

## Approval: a separate lesson and take

Use an isolated Navlog workspace and a local flight-plan record. First qualify the required inputs so the agent can actually reach the approval. Show the requested action, the deliberate decision, and the resulting local record. The result must disclose that it was not transmitted. No external filing service is part of this lesson. Denial, expiry and cancellation need their own observed evidence before teaching them as demonstrated behavior.

## Edit and accessibility checklist

- Keep Hanken Grotesk and B4's warm neutral/relay palette for explanatory cards. Use JetBrains Mono for code and data. Follow the current LLA rules; no decorative effects or marketing overlays.
- Preserve meaningful waiting and decision context. Disclose cuts, sped-up waits or a browser replay; never manufacture agent output.
- Supply a readable poster, synchronized WebVTT captions, descriptive transcript and visible native video controls. No autoplay; preload none. Starting video must pause inspector playback and vice versa.
- Record app binary identity, runtime/example revisions, take identity, timestamps, edit intervals and narration separately from the observed output.
- Review every frame, caption, transcript and capture for account details, credentials, local paths and unrelated conversations. Validate and dry-run the explicit publisher allowlist before copying public assets.
- No public video reference until the asset, poster, captions and transcript exist and pass browser playback review.

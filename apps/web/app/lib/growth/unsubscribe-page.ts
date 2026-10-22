function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
${body}
</body>
</html>
`
}

export interface ConfirmPageCopy {
  readonly title: string
  readonly heading: string
  /** The form's POST target, a same-origin path. */
  readonly action: string
  readonly buttonLabel: string
}

export interface DonePageCopy {
  readonly title: string
  readonly heading: string
  readonly message: string
}

export const UNSUBSCRIBE_CONFIRM: ConfirmPageCopy = {
  title: "Unsubscribe",
  heading: "Unsubscribe from B4.run updates?",
  action: "/api/growth/unsubscribe",
  buttonLabel: "Unsubscribe",
}

export const UNSUBSCRIBE_DONE: DonePageCopy = {
  title: "Unsubscribed",
  heading: "You are unsubscribed.",
  message: "You will not receive further updates from B4.run.",
}

export const FOUNDER_STOP_CONFIRM: ConfirmPageCopy = {
  title: "Stop the sequence",
  heading: "Stop the founder sequence for this contact?",
  action: "/api/growth/founder-stop",
  buttonLabel: "Stop the sequence",
}

export const FOUNDER_STOP_DONE: DonePageCopy = {
  title: "Sequence stopped",
  heading: "The sequence is stopped.",
  message: "This contact will not receive further sequence emails.",
}

export function renderConfirmPage(input: { token: string } & Partial<ConfirmPageCopy>): string {
  const copy = { ...UNSUBSCRIBE_CONFIRM, ...input }
  return page(
    escapeHtml(copy.title),
    `<h1>${escapeHtml(copy.heading)}</h1>
<form method="post" action="${escapeHtml(copy.action)}">
<input type="hidden" name="token" value="${escapeHtml(input.token)}">
<button type="submit">${escapeHtml(copy.buttonLabel)}</button>
</form>`,
  )
}

export function renderDonePage(input: Partial<DonePageCopy> = {}): string {
  const copy = { ...UNSUBSCRIBE_DONE, ...input }
  return page(
    escapeHtml(copy.title),
    `<h1>${escapeHtml(copy.heading)}</h1>
<p>${escapeHtml(copy.message)}</p>`,
  )
}

export function renderFailurePage(): string {
  return page("Link not valid", `<h1>This link is not valid.</h1>`)
}

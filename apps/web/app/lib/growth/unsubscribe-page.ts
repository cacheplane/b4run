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

export function renderConfirmPage(input: { token: string }): string {
  return page(
    "Unsubscribe",
    `<h1>Unsubscribe from B4.run updates?</h1>
<form method="post" action="">
<input type="hidden" name="token" value="${escapeHtml(input.token)}">
<button type="submit">Unsubscribe</button>
</form>`,
  )
}

export function renderDonePage(): string {
  return page(
    "Unsubscribed",
    `<h1>You are unsubscribed.</h1>
<p>You will not receive further updates from B4.run.</p>`,
  )
}

export function renderFailurePage(): string {
  return page("Link not valid", `<h1>This link is not valid.</h1>`)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function renderApprovalPage(options: {
  request: string;
  clientName?: string;
  redirectUri: string;
  error?: string;
}): string {
  const redirect = new URL(options.redirectUri);
  const client = escapeHtml(options.clientName?.trim() || "An MCP client");
  const host = escapeHtml(redirect.host);
  const error = options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Authorize Mochi MCP</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --text: #1d1d1f; --muted: #6b6b70; --line: #d9d9de; --accent: #2f6fde; --danger: #c4372b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161618; --card: #222225; --text: #f2f2f4; --muted: #a0a0a8; --line: #3a3a40; --accent: #6b9cff; --danger: #ff7a6e; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px; }
  h1 { font-size: 1.25rem; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: var(--muted); }
  strong { color: var(--text); }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
  .actions { display: flex; flex-direction: row-reverse; gap: 12px; margin-top: 20px; }
  button { flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; cursor: pointer; }
  button[value=approve] { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .error { color: var(--danger); font-weight: 600; }
  .hidden { position: absolute; left: -9999px; }
</style>
</head>
<body>
<main>
  <h1>Authorize Mochi MCP</h1>
  <p><strong>${client}</strong> wants full access to your Mochi cards, decks and templates. After approval you will return to <strong>${host}</strong>.</p>
  ${error}
  <!-- Approve comes first so pressing Enter approves. -->
  <form method="post" action="/oauth/approve">
    <input type="hidden" name="request" value="${escapeHtml(options.request)}">
    <input class="hidden" type="text" name="username" value="owner" autocomplete="username" tabindex="-1" aria-hidden="true">
    <label for="password">Server secret</label>
    <input id="password" type="password" name="password" autocomplete="current-password" autofocus>
    <div class="actions">
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

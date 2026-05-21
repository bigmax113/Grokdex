# Continue Render Agent

Remote, protected Continue CLI web UI for Render.

The app is intentionally cloud-only:

- no LM Studio
- no local filesystem access
- no local browser access
- all agent work happens inside the Render container workspace
- login is controlled by a 4-digit code sent to `OTP_EMAIL`

## Security Model

1. User opens the Render URL.
2. App sends a 4-digit code to `OTP_EMAIL`, default `bigmax113@gmail.com`.
3. User enters the code.
4. A signed, HTTP-only cookie unlocks the UI.
5. Every agent action requires the signed cookie.

Codes expire after 10 minutes and are not printed in logs.

## Render Deploy

Create a new GitHub repo from this folder and deploy `render.yaml`.

Required Render environment variables:

- `XAI_API_KEY`
- `SESSION_SECRET`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `OTP_EMAIL`

For Gmail, use a Gmail app password for `SMTP_PASS`; the normal account password will not work.

Optional:

- `WORKSPACE_REPO_URL` - repo to clone into the remote workspace
- `WORKSPACE_BRANCH` - defaults to `main`

## Local Smoke Test

```powershell
cd .\continue-render-agent
npm install
npm run check
npm start
```

Open:

```text
http://localhost:3000
```

## Important Render Notes

Render free web services have ephemeral filesystems. If the agent changes code, commit and push during the session or the work can disappear after restart.

For private GitHub repos, provide credentials through a tokenized `WORKSPACE_REPO_URL` or configure Git inside the session.

The UI model selector uses:

- `continue-config.yaml` for `Grok Build 0.1 coding`
- `continue-config-grok43.yaml` for `Grok 4.3 long context`

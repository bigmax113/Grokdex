# Continue Render Agent

Protected Render web UI plus a local direct Continue worker.

The useful path is:

1. Open the Render URL from any computer.
2. Log in with the 4-digit owner code.
3. Upload documents and create a job.
4. Render stores the job and files in Google Drive.
5. This Windows laptop runs `local-worker.mjs`, polls Render, launches local Continue directly, and writes final files back to Google Drive.
6. Any logged-in browser can download the result from the Render UI.

`openclaw` is only a donor for already configured Google OAuth/keys. The worker does not call the OpenClaw gateway.

During testing, jobs use the default Drive folder owned by Maksym. A user can switch to their own Google Drive from the UI. That switch is one-way: after successful personal Drive authorization, new jobs for that email no longer use the default test folder, and the UI does not offer a way back to Maksym's Drive.

Personal LLM settings are prepared as hidden API plumbing, but they are not shown in the UI yet.

## Required Render Environment

- `XAI_API_KEY`
- `SESSION_SECRET`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `OTP_EMAIL`
- `REMOTE_WORKER_TOKEN`
- `GOOGLE_DRIVE_FOLDER_ID`
- `GOOGLE_DRIVE_AUTH_MODE`
- `GOOGLE_DRIVE_CONNECT_ENABLED`
- `GOOGLE_DRIVE_USE_PERSONAL_PROFILES`

The default Drive folder ID is:

```text
1WGbLfKoL8bYEi6fIXI2ktBPZmwAe86Pj
```

## Google Drive Auth

OAuth mode reuses the files already created by OpenClaw:

- `C:\Users\bigma\.openclaw\client_secret_653692761283-ajsu8chvcvqmsg80th5vpjmt8d9flk2m.apps.googleusercontent.com.json`
- `C:\Users\bigma\.openclaw\workspace\oauth-token.json`

For Render, base64-encode them and set:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.openclaw\client_secret_653692761283-ajsu8chvcvqmsg80th5vpjmt8d9flk2m.apps.googleusercontent.com.json"))
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.openclaw\workspace\oauth-token.json"))
```

Put the first value in `GOOGLE_DRIVE_OAUTH_CLIENT_JSON_B64`, and the second in `GOOGLE_DRIVE_OAUTH_TOKEN_JSON_B64`.

Service account mode is also supported with `GOOGLE_SERVICE_ACCOUNT_JSON_B64`, but then the Drive folder must be shared with the service account email.

## Personal Drive Profiles

The UI shows an optional `Use my Drive` control. By default, files go to:

```text
1WGbLfKoL8bYEi6fIXI2ktBPZmwAe86Pj
```

After the user connects their own Drive, Render creates a folder named `Continue Render Agent` in that Drive, stores the OAuth token encrypted with `SESSION_SECRET`, and routes new task metadata, inputs, and outputs to that personal folder. Old default-folder jobs are no longer listed for that user.

To enable it later:

1. Create a Google OAuth client suitable for the Render callback URL.
2. Set `GOOGLE_DRIVE_CONNECT_ENABLED=true` (already the default in `render.yaml`).
3. Set `GOOGLE_DRIVE_OAUTH_REDIRECT_URI=https://your-render-service.onrender.com/api/drive/callback`.
4. Set `GOOGLE_DRIVE_USE_PERSONAL_PROFILES=true`.
5. Provide `GOOGLE_DRIVE_OAUTH_CLIENT_JSON_B64` or `GOOGLE_DRIVE_OAUTH_CLIENT_JSON`.

Keep `SESSION_SECRET` stable; changing it makes saved personal Drive tokens unreadable.

Hidden endpoints:

- `GET /api/drive/profile`
- `POST /api/drive/connect/start`
- `GET /api/drive/callback`

## Personal LLM Profiles

The personal LLM API is also present but not displayed in the UI.

Hidden endpoints:

- `GET /api/llm/profile`
- `PUT /api/llm/profile`
- `DELETE /api/llm/profile`

Example payload for `PUT /api/llm/profile`:

```json
{
  "enabled": true,
  "name": "My OpenAI-compatible model",
  "provider": "openai",
  "model": "my-model",
  "apiBase": "https://example.com/v1",
  "apiKey": "user-api-key",
  "temperature": 0.2,
  "contextLength": 131072,
  "maxTokens": 8192
}
```

For local providers such as `lmstudio` or `ollama`, `apiKey` can be omitted. Saved API keys are encrypted with `SESSION_SECRET`. When a document job is claimed, the worker receives the decrypted profile and writes a temporary Continue config only for that task.

## Local Worker

Install dependencies once:

```powershell
cd "C:\Users\bigma\OneDrive\Документы\New project\continue-render-agent"
npm install
```

Run the worker:

```powershell
$env:RENDER_AGENT_URL="https://your-render-service.onrender.com"
$env:REMOTE_WORKER_TOKEN="same-long-token-as-render"
npm run worker
```

Defaults:

- workspace: `C:\Users\bigma\OneDrive\Документы\New project`
- Continue config: `local-agent-stack\continue-config.yaml`
- provider: `qwen`
- mode: `auto`

Optional worker env vars:

- `REMOTE_WORKER_PROVIDER=qwen|grok-build|grok-general`
- `REMOTE_WORKER_MODE=auto|readonly|normal`
- `REMOTE_WORKER_CONTINUE_CONFIG=C:\path\to\continue-config.yaml`
- `REMOTE_WORKER_TASK_ROOT=C:\path\to\remote-worker-tasks`
- `REMOTE_WORKER_ENV_FILES=C:\path\one.env;C:\path\two.env`

## Local Smoke Test

```powershell
cd "C:\Users\bigma\OneDrive\Документы\New project\continue-render-agent"
npm run check
npm start
```

Open:

```text
http://localhost:3000
```

## Notes

Render free web services have ephemeral filesystems. Google Drive storage is the durable layer for remote document jobs.

The direct chat panel still runs inside Render. The document jobs panel is for local laptop execution through direct Continue.

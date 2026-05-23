# Continue Render Agent

Protected Render web UI plus a local direct Continue worker.

The useful path is:

1. Open the Render URL from any computer.
2. Log in with the 4-digit owner code.
3. Upload documents and create a job.
4. Render stores the job and files in Google Drive.
5. This Windows laptop runs `local-worker.mjs`, polls Render, launches local Continue directly, and writes final files back to Google Drive.
6. Any logged-in browser can download `results.zip` from the Render UI.

`openclaw` is only a donor for already configured Google OAuth/keys. The worker does not call the OpenClaw gateway.

During testing, jobs use the default Drive folder owned by Maksym. A user can switch to one selected folder in their own Google Drive from the UI. That switch is one-way: after successful personal Drive authorization, new jobs for that email no longer use the default test folder, and the UI does not offer a way back to Maksym's Drive.

The visible model list is local-only by default: Qwen, Gemma 4 E2B Q4, and Gemma 4 E4B Q4 are active. Paid cloud models may still appear in the catalog, but they stay disabled unless explicitly enabled by environment variables.

Personal LLM settings are prepared as hidden API plumbing, but they are not shown in the UI yet.

## Dataset Jobs

The task form accepts files, archives, or a whole folder. Multiple selected files or a selected folder are packed as `dataset.zip` before storage so the worker receives a single dataset archive. A single uploaded archive (`.zip`, `.7z`, `.rar`, `.tar`, `.tar.gz`, `.tgz`, `.gz`, `.bz2`, `.xz`) is stored as-is. Worker output is always returned as `results.zip`.

## Translation Jobs

All document translation jobs must use an XLIFF roundtrip. When the prompt asks to translate/localize uploaded documents, the worker marks the task as XLIFF-required and injects a strict policy into the Continue run:

- Convert/extract each source document to XLIFF.
- Translate only XLIFF targets/trans-units while preserving tags, IDs, placeholders, numbers, and locked terms.
- Audit/repair the translated XLIFF.
- Reconstruct the final document from translated XLIFF and return it in `results.zip`.

Do not translate DOCX, PDF, XLSX, PPTX, HTML, or XML by directly reading document text and writing a translated document with generic Python libraries. Python libraries may be used only for XLIFF conversion, reconstruction, and validation.

Reference local implementation:

```text
C:\codex\agent_pipeline_translator_semantic_tuned_clean_core_v2_targetlock_allxml_onepass_fixed_pdf_mixed_pause_reload_new_relaod_LM_PROMPT_TAGS_STRICTEST_NUMERIC_TOC_TERMLOCK_TEST_P4_P8_POST_BATCH_AUDIT_CLEAN_UI_BATCH_A (2).py
```

## Required Render Environment

- `SESSION_SECRET`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `OTP_EMAIL`
- `REMOTE_WORKER_TOKEN`
- `REMOTE_ACTIVE_MODEL_IDS`
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

After the user connects their own Drive, Render verifies the folder URL/ID they entered, stores that selected folder ID plus the OAuth token encrypted with `SESSION_SECRET`, and routes new task metadata, inputs, and outputs only to that personal folder. Old default-folder jobs are no longer listed for that user.

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

`POST /api/drive/connect/start` expects a JSON body such as:

```json
{ "folder": "https://drive.google.com/drive/folders/..." }
```

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

- `REMOTE_WORKER_PROVIDER=qwen|gemma-e2b|gemma-e4b|grok-build|grok-general`
- `REMOTE_WORKER_MODE=auto|readonly|normal`
- `REMOTE_WORKER_PACKAGE_RESULTS=true`
- `REMOTE_WORKER_ACCESS_ENABLED=true|false`
- `REMOTE_WORKER_ACCESS_FILE=C:\path\to\remote-access.enabled`
- `XLIFF_TRANSLATOR_REFERENCE_SCRIPT=C:\path\to\translator.py`
- `REMOTE_WORKER_CONTINUE_CONFIG=C:\path\to\continue-config.yaml`
- `REMOTE_WORKER_TASK_ROOT=C:\path\to\remote-worker-tasks`
- `REMOTE_WORKER_ENV_FILES=C:\path\one.env;C:\path\two.env`

## Local Access Gate

The local worker checks `remote-access.enabled` before claiming a new Render job. Missing file means access is allowed.

```powershell
npm run access:pause
npm run access:allow
npm run access:status
```

The Local Agent Control panel also exposes this as `External Access -> Allow jobs / Pause jobs`. Pausing does not kill a currently running job; it prevents new external jobs from being claimed while the owner uses the laptop for personal Continue work.

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

The direct chat panel is disabled by default for the local-only test. The document jobs panel is for local laptop execution through direct Continue.

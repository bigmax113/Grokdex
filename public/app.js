const $ = (id) => document.getElementById(id);
let currentRunId = null;
let controller = null;

function setLoginStatus(text) {
  $("loginStatus").textContent = text || "";
}

function setRemoteStatus(text) {
  $("remoteStatus").textContent = text || "";
}

function setRunStatus(text, active = true) {
  const box = $("runStatus");
  $("runStatusText").textContent = text || "";
  box.classList.toggle("hidden", !text);
  box.querySelector(".spinner").classList.toggle("hidden", !active);
}

function clearDownloadLinks() {
  $("downloadBar").innerHTML = "";
  $("downloadBar").classList.add("hidden");
}

function showDownloadLinks(files) {
  const useful = (files || []).filter((file) => file.downloadUrl && file.name !== "transcript.txt");
  if (!useful.length) return;
  const preferred = useful.find((file) => file.name === "results.zip") || useful[0];
  const links = useful.map((file) => {
    const label = file.name === preferred.name
      ? `Download ${file.name}`
      : `${file.name} (${formatBytes(file.size)})`;
    return `<a href="${escapeHtml(file.downloadUrl)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  }).join("");
  $("downloadBar").innerHTML = `<strong>Result:</strong> ${links}`;
  $("downloadBar").classList.remove("hidden");
}

function append(text) {
  const output = $("output");
  output.textContent += text;
  output.scrollTop = output.scrollHeight;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function refreshMe() {
  const me = await api("/api/me");
  $("email").value = me.otpEmail || "";
  $("login").classList.toggle("hidden", me.authenticated);
  $("app").classList.toggle("hidden", !me.authenticated);
  if (me.authenticated) {
    await refreshStatus();
    await refreshDriveProfile().catch((error) => setRemoteStatus(error.message));
    await refreshRemoteTasks().catch((error) => setRemoteStatus(error.message));
  }
}

async function refreshStatus() {
  const status = await api("/api/status");
  const activeModels = (status.remote?.models || []).filter((model) => model.active).map((model) => model.id).join(", ");
  const mailer = status.mailer === "gmail-oauth" ? "Gmail OAuth" : status.smtp ? "SMTP" : "missing";
  $("runtime").textContent = `${status.email} - ${status.workspace} - local models: ${activeModels || "none"} - mail ${mailer}`;
}

async function sendCode() {
  setLoginStatus("Sending code...");
  try {
    await api("/api/auth/request", {
      method: "POST",
      body: JSON.stringify({ email: $("email").value }),
    });
    setLoginStatus("Code sent. Check the owner mailbox.");
    $("code").focus();
  } catch (error) {
    setLoginStatus(error.message);
  }
}

async function verifyCode() {
  setLoginStatus("Checking code...");
  try {
    await api("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ code: $("code").value }),
    });
    setLoginStatus("");
    await refreshMe();
  } catch (error) {
    setLoginStatus(error.message);
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  $("output").textContent = "";
  $("remoteTasks").innerHTML = "";
  await refreshMe();
}

async function readEventStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const event = frame.match(/^event: (.+)$/m)?.[1] || "message";
      const raw = frame.match(/^data: (.+)$/m)?.[1] || "{}";
      const data = JSON.parse(raw);
      if (event === "token" || event === "stderr") {
        setRunStatus("Receiving model output...");
        append(data.token || "");
      }
      if (event === "meta" && data.taskId) {
        setRunStatus(`Queued: ${data.taskId}`);
        setRemoteStatus(`Task ${data.taskId} queued.`);
      }
      if (event === "log") {
        const message = data.message || "";
        if (/claimed/i.test(message)) setRunStatus("Local worker claimed the task...");
        else if (/saved .*input/i.test(message)) setRunStatus("Preparing uploaded files...");
        else if (/continue started/i.test(message)) setRunStatus("LM Studio is processing...");
        else if (/image|vision/i.test(message)) setRunStatus(message);
        else setRunStatus("Working...");
        setRemoteStatus(message);
      }
      if (event === "result") showDownloadLinks(data.files || []);
      if (event === "error") {
        setRunStatus("Failed.", false);
        append(`\nERROR: ${data.error}\n`);
      }
      if (event === "done") setRunStatus(data.code === 0 ? "Done." : `Exit ${data.code}`, false);
    }
  }
}

async function runAgent(event) {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt || currentRunId) return;
  const selected = selectedRemoteInputs();
  currentRunId = `ui-${Date.now().toString(36)}`;
  controller = new AbortController();
  $("send").disabled = true;
  $("stop").disabled = false;
  clearDownloadLinks();
  setRunStatus(selected.length ? `Uploading ${selected.length} file(s)...` : "Creating task...");
  append(`\n> ${prompt}\n`);
  $("prompt").value = "";
  try {
    const files = await buildUploadFiles(selected);
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        runId: currentRunId,
        prompt,
        localModel: $("remoteModel").value,
        auto: $("auto").checked,
        files,
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) await refreshMe().catch(() => {});
      throw new Error(data.error || response.statusText);
    }
    if (selected.length) {
      $("remoteFiles").value = "";
      $("remoteFolder").value = "";
    }
    await readEventStream(response);
  } catch (error) {
    setRunStatus(error.name === "AbortError" ? "Stopped." : "Failed.", false);
    append(error.name === "AbortError" ? "\n[stopped]\n" : `\nERROR: ${error.message}\n`);
  } finally {
    currentRunId = null;
    controller = null;
    $("send").disabled = false;
    $("stop").disabled = true;
    await refreshStatus().catch(() => {});
    await refreshRemoteTasks().catch(() => {});
    $("prompt").focus();
  }
}

async function stopRun() {
  if (!currentRunId) return;
  const runId = currentRunId;
  controller?.abort();
  await api("/api/stop", {
    method: "POST",
    body: JSON.stringify({ runId }),
  }).catch(() => {});
}

async function refreshDriveProfile() {
  const data = await api("/api/drive/profile");
  const active = data.active || {};
  const button = $("connectDrive");
  if (active.mode === "personal") {
    $("driveProfile").textContent = `Using your Drive: ${active.folderName || active.folderId}`;
    button.textContent = "Connected";
    button.disabled = true;
    $("driveFolder").value = active.folderUrl || active.folderId || "";
    $("driveFolder").disabled = true;
    return;
  }
  if (active.mode === "personal_required") {
    $("driveProfile").textContent = "Your Drive is required";
    button.textContent = "Connect Drive";
    button.disabled = !data.connectEnabled;
    $("driveFolder").disabled = !data.connectEnabled;
    return;
  }
  $("driveProfile").textContent = "Using default test Drive";
  button.textContent = "Use my Drive";
  button.disabled = !data.connectEnabled;
  $("driveFolder").disabled = !data.connectEnabled;
}

async function connectDrive() {
  const folder = $("driveFolder").value.trim();
  if (!folder) {
    setRemoteStatus("Paste a Google Drive folder URL or folder ID first.");
    return;
  }
  setRemoteStatus("Preparing Google Drive authorization...");
  try {
    const data = await api("/api/drive/connect/start", {
      method: "POST",
      body: JSON.stringify({ folder }),
    });
    window.open(data.authUrl, "_blank", "noopener,noreferrer");
    setRemoteStatus("Google authorization opened. Refresh after approval.");
  } catch (error) {
    setRemoteStatus(error.message);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function selectedRemoteInputs() {
  return [
    ...Array.from($("remoteFiles").files || []),
    ...Array.from($("remoteFolder").files || []),
  ];
}

async function buildUploadFiles(files) {
  const uploads = [];
  for (const file of files) {
    uploads.push({
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      mime: file.type || "application/octet-stream",
      base64: await fileToBase64(file),
    });
  }
  return uploads;
}

async function createRemoteTask(event) {
  event.preventDefault();
  const prompt = $("remotePrompt").value.trim();
  const selected = selectedRemoteInputs();
  if (!prompt && !selected.length) return;

  $("createRemoteTask").disabled = true;
  setRemoteStatus("Uploading job...");
  try {
    const files = await buildUploadFiles(selected);
    await api("/api/remote/tasks", {
      method: "POST",
      body: JSON.stringify({ prompt, model: $("remoteModel").value, files }),
    });
    $("remotePrompt").value = "";
    $("remoteFiles").value = "";
    $("remoteFolder").value = "";
    setRemoteStatus("Job created.");
    await refreshRemoteTasks();
  } catch (error) {
    setRemoteStatus(error.message);
  } finally {
    $("createRemoteTask").disabled = false;
  }
}

function renderTask(task) {
  const statusClass = `status-${escapeHtml(task.status)}`;
  const created = task.createdAt ? new Date(task.createdAt).toLocaleString() : "";
  const model = task.model?.name ? `<div class="muted">Model: ${escapeHtml(task.model.name)}</div>` : "";
  const pipeline = task.pipeline?.xliffTranslationRequired ? `<div class="muted">Pipeline: XLIFF translation required</div>` : "";
  const inputs = (task.files || []).map((file) => `<span>${escapeHtml(file.relativePath || file.name)} (${formatBytes(file.size)})</span>`).join("");
  const results = (task.resultFiles || [])
    .map((file) => `<a href="${file.downloadUrl}" target="_blank" rel="noopener">${escapeHtml(file.name)} (${formatBytes(file.size)})</a>`)
    .join("");
  const logs = (task.logs || []).slice(-4).map((log) => `<div>${escapeHtml(log.message)}</div>`).join("");
  return `
    <article class="taskItem">
      <div class="taskTop">
        <strong>${escapeHtml(task.id)}</strong>
        <span class="pill ${statusClass}">${escapeHtml(task.status)}</span>
      </div>
      <p>${escapeHtml(task.prompt || "No prompt")}</p>
      <div class="muted">${escapeHtml(created)}${task.workerId ? ` - ${escapeHtml(task.workerId)}` : ""}</div>
      ${model}
      ${pipeline}
      ${inputs ? `<div class="chips">${inputs}</div>` : ""}
      ${task.error ? `<div class="taskError">${escapeHtml(task.error)}</div>` : ""}
      ${results ? `<div class="results">${results}</div>` : ""}
      ${logs ? `<details><summary>Logs</summary>${logs}</details>` : ""}
    </article>
  `;
}

async function refreshRemoteTasks() {
  setRemoteStatus("Refreshing...");
  const data = await api("/api/remote/tasks");
  const tasks = data.tasks || [];
  $("remoteTasks").innerHTML = tasks.length
    ? tasks.map(renderTask).join("")
    : '<div class="empty">No document jobs yet.</div>';
  setRemoteStatus(`${tasks.length} job(s).`);
}

$("sendCode").addEventListener("click", sendCode);
$("verifyCode").addEventListener("click", verifyCode);
$("logout").addEventListener("click", logout);
$("promptForm").addEventListener("submit", runAgent);
$("stop").addEventListener("click", stopRun);
$("remoteTaskForm").addEventListener("submit", createRemoteTask);
$("refreshRemoteTasks").addEventListener("click", () => refreshRemoteTasks().catch((error) => setRemoteStatus(error.message)));
$("connectDrive").addEventListener("click", connectDrive);
$("code").addEventListener("keydown", (event) => {
  if (event.key === "Enter") verifyCode();
});

setInterval(() => {
  if (!$("app").classList.contains("hidden")) refreshRemoteTasks().catch(() => {});
}, 15000);

refreshMe().catch((error) => setLoginStatus(error.message));

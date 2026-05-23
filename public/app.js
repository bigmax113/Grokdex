const $ = (id) => document.getElementById(id);

const state = {
  chats: [],
  chatId: localStorage.getItem("remoteContinueChatId") || null,
  messages: [],
  attachments: [],
  currentAssistantId: null,
};

let currentRunId = null;
let currentTaskId = null;
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

function titleFromText(text) {
  const value = String(text || "New chat").replace(/\s+/g, " ").trim();
  return value.length > 64 ? `${value.slice(0, 64)}...` : value || "New chat";
}

function messageTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function activeChatTitle() {
  const chat = state.chats.find((item) => item.id === state.chatId);
  const firstUser = state.messages.find((item) => item.role === "user");
  return chat?.title || titleFromText(firstUser?.content);
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

function renderMessages() {
  const output = $("output");
  const hint = $("dropHint");
  output.textContent = "";
  output.appendChild(hint);
  for (const message of state.messages.filter((item) => item.role !== "system")) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    article.dataset.id = message.id || "";
    const meta = document.createElement("div");
    meta.className = "messageMeta";
    meta.textContent = `${message.role === "user" ? "You" : "Agent"}${message.createdAt ? ` - ${messageTime(message.createdAt)}` : ""}`;
    const body = document.createElement("div");
    body.className = "messageBody";
    body.textContent = message.content || "";
    article.append(meta, body);
    output.appendChild(article);
  }
  output.scrollTop = output.scrollHeight;
  $("chatTitle").value = activeChatTitle();
}

function appendMessage(role, content, { id = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` } = {}) {
  const message = {
    id,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
  state.messages.push(message);
  renderMessages();
  return message;
}

function appendAssistantToken(token) {
  if (!state.currentAssistantId) {
    const message = appendMessage("assistant", "", { id: `assistant-${Date.now().toString(36)}` });
    state.currentAssistantId = message.id;
  }
  const message = state.messages.find((item) => item.id === state.currentAssistantId);
  if (!message) return;
  message.content += token;
  renderMessages();
}

function renderChats() {
  const list = $("chatList");
  list.textContent = "";
  for (const chat of state.chats) {
    const row = document.createElement("div");
    row.className = `chatRow ${chat.id === state.chatId ? "active" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chatItem";
    button.onclick = () => loadChat(chat.id);
    const name = document.createElement("div");
    name.className = "chatName";
    name.textContent = chat.title || "New chat";
    name.title = name.textContent;
    const meta = document.createElement("div");
    meta.className = "chatMeta";
    meta.textContent = `${messageTime(chat.updatedAt)} - ${chat.messageCount || 0} msg`;
    button.append(name, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chatDelete";
    remove.textContent = "Del";
    remove.onclick = async (event) => {
      event.stopPropagation();
      if (currentRunId) return;
      await api(`/api/chats/${encodeURIComponent(chat.id)}`, { method: "DELETE" });
      if (state.chatId === chat.id) newChat();
      await refreshChats();
    };
    row.append(button, remove);
    list.appendChild(row);
  }
}

async function refreshChats() {
  const data = await api("/api/chats");
  state.chats = data.chats || [];
  renderChats();
}

async function loadChat(id) {
  const data = await api(`/api/chats/${encodeURIComponent(id)}`);
  state.chatId = data.chat.id;
  localStorage.setItem("remoteContinueChatId", state.chatId);
  state.messages = (data.chat.messages || []).map((message) => ({ ...message, id: `loaded-${Math.random().toString(36).slice(2)}` }));
  state.currentAssistantId = null;
  renderMessages();
  renderChats();
}

function newChat() {
  state.chatId = null;
  localStorage.removeItem("remoteContinueChatId");
  state.messages = [];
  state.currentAssistantId = null;
  clearDownloadLinks();
  renderMessages();
  renderChats();
}

function renderAttachments() {
  const bar = $("attachmentBar");
  bar.textContent = "";
  bar.classList.toggle("hidden", !state.attachments.length);
  state.attachments.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "attachmentChip";
    const label = document.createElement("span");
    label.textContent = `${file.webkitRelativePath || file.name} (${formatBytes(file.size)})`;
    label.title = label.textContent;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.onclick = () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    };
    chip.append(label, remove);
    bar.appendChild(chip);
  });
}

function addAttachments(files) {
  for (const file of Array.from(files || [])) {
    const key = `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
    const exists = state.attachments.some((item) => `${item.webkitRelativePath || item.name}:${item.size}:${item.lastModified}` === key);
    if (!exists) state.attachments.push(file);
  }
  renderAttachments();
}

async function refreshMe() {
  const me = await api("/api/me");
  $("email").value = me.otpEmail || "";
  $("login").classList.toggle("hidden", me.authenticated);
  $("app").classList.toggle("hidden", !me.authenticated);
  if (me.authenticated) {
    await refreshStatus();
    await refreshChats().catch((error) => setRemoteStatus(error.message));
    if (state.chatId && state.chats.some((chat) => chat.id === state.chatId)) {
      await loadChat(state.chatId).catch(() => newChat());
    } else {
      newChat();
    }
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
  newChat();
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
        appendAssistantToken(data.token || "");
      }
      if (event === "meta") {
        if (data.chatId) {
          state.chatId = data.chatId;
          localStorage.setItem("remoteContinueChatId", state.chatId);
        }
        if (data.taskId) {
          currentTaskId = data.taskId;
          setRunStatus(`Queued: ${data.taskId}`);
          setRemoteStatus(`Task ${data.taskId} queued.`);
        }
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
        appendAssistantToken(`\nERROR: ${data.error}\n`);
      }
      if (event === "done") setRunStatus(data.code === 0 ? "Done." : `Exit ${data.code}`, false);
    }
  }
}

async function runAgent(event) {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if ((!prompt && !state.attachments.length) || currentRunId) return;
  const selected = [...state.attachments];
  currentRunId = `ui-${Date.now().toString(36)}`;
  currentTaskId = null;
  controller = new AbortController();
  $("send").disabled = true;
  $("stop").disabled = false;
  clearDownloadLinks();
  state.currentAssistantId = null;
  const attachmentLine = selected.length
    ? `\n\nAttached: ${selected.map((file) => file.webkitRelativePath || file.name).join(", ")}`
    : "";
  if (prompt) appendMessage("user", `${prompt}${attachmentLine}`);
  else appendMessage("user", `Process attached files.${attachmentLine}`);
  $("prompt").value = "";
  setRunStatus(selected.length ? `Uploading ${selected.length} file(s)...` : "Creating task...");
  try {
    const files = await buildUploadFiles(selected);
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        runId: currentRunId,
        chatId: state.chatId,
        prompt: prompt || "Process the attached files.",
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
    state.attachments = [];
    renderAttachments();
    $("remoteFiles").value = "";
    $("remoteFolder").value = "";
    await readEventStream(response);
  } catch (error) {
    setRunStatus(error.name === "AbortError" ? "Stopped." : "Failed.", false);
    appendAssistantToken(error.name === "AbortError" ? "\n[stopped]\n" : `\nERROR: ${error.message}\n`);
  } finally {
    currentRunId = null;
    currentTaskId = null;
    controller = null;
    $("send").disabled = false;
    $("stop").disabled = true;
    await refreshStatus().catch(() => {});
    await refreshChats().catch(() => {});
    await refreshRemoteTasks().catch(() => {});
    renderChats();
    $("prompt").focus();
  }
}

async function stopRun() {
  if (!currentRunId) return;
  const runId = currentRunId;
  const taskId = currentTaskId;
  controller?.abort();
  await api("/api/stop", {
    method: "POST",
    body: JSON.stringify({ runId, taskId }),
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

function setupDropZone() {
  const output = $("output");
  const hint = $("dropHint");
  const show = (event) => {
    event.preventDefault();
    output.classList.add("dragging");
    hint.classList.remove("hidden");
  };
  const hide = (event) => {
    event.preventDefault();
    output.classList.remove("dragging");
    hint.classList.add("hidden");
  };
  output.addEventListener("dragover", show);
  output.addEventListener("dragenter", show);
  output.addEventListener("dragleave", (event) => {
    if (!output.contains(event.relatedTarget)) hide(event);
  });
  output.addEventListener("drop", (event) => {
    hide(event);
    addAttachments(event.dataTransfer?.files || []);
    $("prompt").focus();
  });
  document.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;
    addAttachments(files);
    $("prompt").focus();
  });
}

$("sendCode").addEventListener("click", sendCode);
$("verifyCode").addEventListener("click", verifyCode);
$("logout").addEventListener("click", logout);
$("promptForm").addEventListener("submit", runAgent);
$("stop").addEventListener("click", stopRun);
$("remoteTaskForm").addEventListener("submit", createRemoteTask);
$("refreshRemoteTasks").addEventListener("click", () => refreshRemoteTasks().catch((error) => setRemoteStatus(error.message)));
$("connectDrive").addEventListener("click", connectDrive);
$("newChat").addEventListener("click", newChat);
$("attachFiles").addEventListener("click", () => $("chatFiles").click());
$("chatFiles").addEventListener("change", () => {
  addAttachments($("chatFiles").files);
  $("chatFiles").value = "";
});
$("remoteFiles").addEventListener("change", () => addAttachments($("remoteFiles").files));
$("remoteFolder").addEventListener("change", () => addAttachments($("remoteFolder").files));
$("code").addEventListener("keydown", (event) => {
  if (event.key === "Enter") verifyCode();
});

setInterval(() => {
  if (!$("app").classList.contains("hidden")) refreshRemoteTasks().catch(() => {});
}, 15000);

setupDropZone();
renderMessages();
refreshMe().catch((error) => setLoginStatus(error.message));

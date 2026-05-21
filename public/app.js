const $ = (id) => document.getElementById(id);
let currentRunId = null;
let controller = null;

function setLoginStatus(text) {
  $("loginStatus").textContent = text || "";
}

function append(text) {
  const output = $("output");
  output.textContent += text;
  output.scrollTop = output.scrollHeight;
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
  if (me.authenticated) await refreshStatus();
}

async function refreshStatus() {
  const status = await api("/api/status");
  $("runtime").textContent = `${status.email} · ${status.workspace} · XAI ${status.xaiKey ? "ready" : "missing"} · SMTP ${status.smtp ? "ready" : "missing"}`;
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
      if (event === "token" || event === "stderr") append(data.token || "");
      if (event === "meta") append(`\n[${data.stage}] ${data.mode || ""}\n`);
      if (event === "error") append(`\nERROR: ${data.error}\n`);
      if (event === "done") append(`\n[exit ${data.code}]\n`);
    }
  }
}

async function runAgent(event) {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt || currentRunId) return;
  currentRunId = `ui-${Date.now().toString(36)}`;
  controller = new AbortController();
  $("send").disabled = true;
  $("stop").disabled = false;
  append(`\n> ${prompt}\n`);
  try {
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        runId: currentRunId,
        prompt,
        model: $("model").value,
        auto: $("auto").checked,
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || response.statusText);
    }
    await readEventStream(response);
  } catch (error) {
    append(error.name === "AbortError" ? "\n[stopped]\n" : `\nERROR: ${error.message}\n`);
  } finally {
    currentRunId = null;
    controller = null;
    $("send").disabled = false;
    $("stop").disabled = true;
    await refreshStatus().catch(() => {});
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

$("sendCode").addEventListener("click", sendCode);
$("verifyCode").addEventListener("click", verifyCode);
$("logout").addEventListener("click", logout);
$("promptForm").addEventListener("submit", runAgent);
$("stop").addEventListener("click", stopRun);
$("code").addEventListener("keydown", (event) => {
  if (event.key === "Enter") verifyCode();
});

refreshMe().catch((error) => setLoginStatus(error.message));

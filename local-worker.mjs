import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(process.env.REMOTE_WORKER_WORKSPACE || path.dirname(__dirname));
const localStackRoot = path.join(projectRoot, "local-agent-stack");
const renderUrl = String(process.env.RENDER_AGENT_URL || process.env.BASE_URL || "").replace(/\/+$/, "");
const workerToken = process.env.REMOTE_WORKER_TOKEN || "";
const workerId = process.env.REMOTE_WORKER_ID || `${os.hostname()}-${process.pid}`;
const pollIntervalMs = Number(process.env.REMOTE_WORKER_INTERVAL_MS || 5000);
const taskRoot = path.resolve(process.env.REMOTE_WORKER_TASK_ROOT || path.join(__dirname, "remote-worker-tasks"));
const provider = process.env.REMOTE_WORKER_PROVIDER || "qwen";
const mode = process.env.REMOTE_WORKER_MODE || "auto";
const showThinking = String(process.env.REMOTE_WORKER_SHOW_THINKING || "false") === "true";
const maxResultBytes = Number(process.env.REMOTE_WORKER_MAX_RESULT_BYTES || 60 * 1024 * 1024);
const taskTimeoutMs = Number(process.env.REMOTE_WORKER_TASK_TIMEOUT_MS || 2 * 60 * 60 * 1000);
const envFiles = String(process.env.REMOTE_WORKER_ENV_FILES || [
  path.join(localStackRoot, ".env"),
  path.join(__dirname, ".env"),
  path.join(os.homedir(), ".continue", ".env"),
  path.join(os.homedir(), ".openclaw", ".env"),
  path.join(os.homedir(), ".openclaw", "config", ".env"),
  path.join(os.homedir(), ".openclaw", "credentials", ".env"),
].join(path.delimiter)).split(path.delimiter).filter(Boolean);

if (!renderUrl) throw new Error("RENDER_AGENT_URL or BASE_URL is required");
if (!workerToken) throw new Error("REMOTE_WORKER_TOKEN is required");

loadEnvFiles(envFiles);

function loadEnvFiles(files) {
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key]) continue;
        process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
      }
    } catch {
      // Missing or unreadable donor env files are optional.
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(name) {
  return String(name || "file")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "file";
}

function mimeFromName(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".txt" || ext === ".md" || ext === ".log") return "text/plain; charset=utf-8";
  if (ext === ".json") return "application/json";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".csv") return "text/csv; charset=utf-8";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".zip") return "application/zip";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function baseContinueConfigPath() {
  if (process.env.REMOTE_WORKER_CONTINUE_CONFIG) return path.resolve(process.env.REMOTE_WORKER_CONTINUE_CONFIG);
  if (provider === "grok-build" || provider === "grok") return path.join(localStackRoot, "continue-config-grok.yaml");
  if (provider === "grok-general") return path.join(localStackRoot, "continue-config-grok-general.yaml");
  return path.join(localStackRoot, "continue-config.yaml");
}

function continueConfigPath() {
  return baseContinueConfigPath();
}

function personalContinueConfig(profile) {
  const providerName = profile.provider || "openai";
  const apiKeyLine = profile.apiKey ? "    apiKey: ${{ secrets.REMOTE_TASK_LLM_API_KEY }}\n" : "";
  return [
    "name: Remote Personal LLM",
    "version: 1.0.0",
    "schema: v1",
    "",
    "models:",
    `  - name: ${yamlString(profile.name || profile.model || "Personal LLM")}`,
    `    provider: ${yamlString(providerName)}`,
    `    model: ${yamlString(profile.model)}`,
    `    apiBase: ${yamlString(profile.apiBase)}`,
    apiKeyLine.trimEnd(),
    "    requestOptions:",
    "      timeout: 600000",
    "    capabilities:",
    "      - tool_use",
    "    roles:",
    "      - chat",
    "      - edit",
    "      - apply",
    "      - summarize",
    "    defaultCompletionOptions:",
    `      temperature: ${Number.isFinite(Number(profile.temperature)) ? Number(profile.temperature) : 0.2}`,
    `      contextLength: ${Number.isFinite(Number(profile.contextLength)) ? Number(profile.contextLength) : 131072}`,
    `      maxTokens: ${Number.isFinite(Number(profile.maxTokens)) ? Number(profile.maxTokens) : 8192}`,
    "",
    "context:",
    "  - provider: file",
    "  - provider: code",
    "  - provider: codebase",
    "    params:",
    "      nRetrieve: 30",
    "      nFinal: 8",
    "  - provider: diff",
    "  - provider: terminal",
    "  - provider: docs",
    "",
    "rules:",
    "  - Prefer Russian for explanations when the user writes in Russian.",
    "  - Inspect relevant files first and follow the repository style.",
    "  - Put requested downloadable deliverables into the output directory named in the prompt.",
    "  - Never print secrets or API keys.",
    "",
  ].filter((line) => line !== "").join("\n");
}

async function prepareContinueRun(task, taskDir) {
  const profile = task.llmProfile;
  if (profile?.model && profile?.apiBase) {
    const config = path.join(taskDir, "continue-personal.yaml");
    await fsp.writeFile(config, personalContinueConfig(profile), "utf8");
    return {
      config,
      env: profile.apiKey ? { REMOTE_TASK_LLM_API_KEY: profile.apiKey } : {},
      label: `personal:${profile.model}`,
    };
  }
  const config = baseContinueConfigPath();
  return { config, env: {}, label: path.basename(config) };
}

function continueExecutable() {
  if (process.env.CONTINUE_CLI) return process.env.CONTINUE_CLI;
  if (process.platform === "win32") {
    const appDataCmd = path.join(process.env.APPDATA || "", "npm", "cn.cmd");
    if (fs.existsSync(appDataCmd)) return appDataCmd;
    return "cn.cmd";
  }
  return "cn";
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already stopped.
    }
  }
}

async function remoteJson(apiPath, options = {}) {
  const response = await fetch(`${renderUrl}${apiPath}`, {
    ...options,
    headers: {
      authorization: `Bearer ${workerToken}`,
      "x-worker-id": workerId,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function logRemote(taskId, message) {
  console.log(`[${taskId}] ${message}`);
  await remoteJson(`/api/worker/tasks/${encodeURIComponent(taskId)}/log`, {
    method: "POST",
    body: JSON.stringify({ message }),
  }).catch((error) => console.warn(`[${taskId}] remote log failed: ${error.message}`));
}

async function saveInputFiles(task, inputDir) {
  await fsp.mkdir(inputDir, { recursive: true });
  const files = [];
  for (const file of task.files || []) {
    const name = safeName(file.name);
    const target = path.join(inputDir, name);
    await fsp.writeFile(target, Buffer.from(String(file.base64 || ""), "base64"));
    files.push({ ...file, name, path: target });
  }
  return files;
}

function buildPrompt(task, inputDir, outputDir, inputFiles) {
  const fileList = inputFiles.length
    ? inputFiles.map((file) => `- ${file.name}: ${file.path}`).join("\n")
    : "- no files";
  return [
    `Remote task ${task.id}.`,
    `Workspace: ${projectRoot}`,
    `Input directory: ${inputDir}`,
    `Output directory: ${outputDir}`,
    "",
    "Use the input files and the local filesystem directly.",
    "Put every final downloadable deliverable into the output directory.",
    "If the task is pure analysis, create result.md in the output directory with the final answer.",
    "Do not put secrets into outputs or logs.",
    "Answer in Russian unless the task explicitly asks for another language.",
    "",
    "Input files:",
    fileList,
    "",
    "User request:",
    task.prompt || "Process the attached documents and produce the requested result.",
  ].join("\n");
}

function spawnContinue(prompt, runConfig) {
  const config = runConfig.config;
  const cn = continueExecutable();
  const args = ["--config", config, "-p"];
  if (!showThinking) args.push("--silent");
  else args.push("--verbose");
  if (mode === "readonly") args.unshift("--readonly");
  if (mode === "auto") args.unshift("--auto");

  if (process.platform === "win32") {
    const command = `& ${psQuote(cn)} ${args.map(psQuote).join(" ")}`;
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: projectRoot,
      env: { ...process.env, ...runConfig.env, NO_COLOR: "1" },
      windowsHide: true,
    });
    child.stdin.end(prompt);
    return { child, config, args };
  }

  const child = spawn(cn, args, {
    cwd: projectRoot,
    env: { ...process.env, ...runConfig.env, NO_COLOR: "1" },
    detached: true,
  });
  child.stdin.end(prompt);
  return { child, config, args };
}

async function runContinue(taskId, prompt, runConfig) {
  const { child, config, args } = spawnContinue(prompt, runConfig);
  let transcript = "";
  let settled = false;
  let lastLogAt = Date.now();

  await logRemote(taskId, `Continue started with ${runConfig.label || path.basename(config)} (${args.join(" ")})`);

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid);
      reject(new Error(`Continue task timed out after ${Math.round(taskTimeoutMs / 1000)} seconds`));
    }, taskTimeoutMs);

    const collect = (chunk, streamName) => {
      const text = chunk.toString("utf8");
      transcript += text;
      const now = Date.now();
      if (now - lastLogAt > 30000) {
        lastLogAt = now;
        logRemote(taskId, `${streamName}: ${Buffer.byteLength(text)} bytes; total transcript ${Buffer.byteLength(transcript)} bytes`);
      }
    };

    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, transcript });
    });
  });
}

async function collectResultFiles(dir) {
  const out = [];
  let total = 0;

  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      const stat = await fsp.stat(fullPath);
      if (!stat.size) continue;
      total += stat.size;
      if (total > maxResultBytes) throw new Error(`Result files exceed ${maxResultBytes} bytes`);
      const relative = path.relative(dir, fullPath).replace(/\\/g, "/");
      out.push({
        name: safeName(relative),
        mime: mimeFromName(relative),
        base64: (await fsp.readFile(fullPath)).toString("base64"),
      });
    }
  }

  await walk(dir);
  return out;
}

async function completeTask(taskId, payload) {
  await remoteJson(`/api/worker/tasks/${encodeURIComponent(taskId)}/complete`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function processTask(task) {
  const taskDir = path.join(taskRoot, task.id);
  const inputDir = path.join(taskDir, "inputs");
  const outputDir = path.join(taskDir, "outputs");
  let transcript = "";

  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await logRemote(task.id, `Worker ${workerId} started direct Continue runner`);
    const inputFiles = await saveInputFiles(task, inputDir);
    await logRemote(task.id, `Saved ${inputFiles.length} input file(s) locally`);

    const prompt = buildPrompt(task, inputDir, outputDir, inputFiles);
    const runConfig = await prepareContinueRun(task, taskDir);
    const result = await runContinue(task.id, prompt, runConfig);
    transcript = result.transcript || "";
    if (result.code !== 0) throw new Error(`Continue exited with code ${result.code}`);

    let files = await collectResultFiles(outputDir);
    if (!files.length) {
      const fallback = transcript.trim() ? transcript.trim() : "Continue finished without creating files.";
      await fsp.writeFile(path.join(outputDir, "result.md"), `${fallback}\n`, "utf8");
      files = await collectResultFiles(outputDir);
    }

    await completeTask(task.id, { status: "done", transcript, files });
    await logRemote(task.id, `Completed with ${files.length} result file(s)`);
  } catch (error) {
    await completeTask(task.id, {
      status: "failed",
      error: error.message,
      transcript,
      files: [],
    }).catch((completeError) => {
      console.error(`[${task.id}] failed to report failure: ${completeError.message}`);
    });
    console.error(`[${task.id}] failed: ${error.stack || error.message}`);
  }
}

async function pollOnce() {
  const data = await remoteJson("/api/worker/next");
  if (!data.task) return false;
  await processTask(data.task);
  return true;
}

console.log(`Remote worker ${workerId} polling ${renderUrl}`);
console.log(`Direct Continue workspace: ${projectRoot}`);
console.log(`Continue config: ${continueConfigPath()}`);

while (true) {
  try {
    const hadTask = await pollOnce();
    if (!hadTask) await sleep(pollIntervalMs);
  } catch (error) {
    console.error(`poll failed: ${error.message}`);
    await sleep(pollIntervalMs);
  }
}

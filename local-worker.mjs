import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(process.env.REMOTE_WORKER_WORKSPACE || path.dirname(__dirname));
const localStackRoot = path.join(projectRoot, "local-agent-stack");
const envFiles = String(process.env.REMOTE_WORKER_ENV_FILES || [
  path.join(localStackRoot, ".env"),
  path.join(__dirname, ".env"),
  path.join(os.homedir(), ".continue", ".env"),
  path.join(os.homedir(), ".openclaw", ".env"),
  path.join(os.homedir(), ".openclaw", "config", ".env"),
  path.join(os.homedir(), ".openclaw", "credentials", ".env"),
].join(path.delimiter)).split(path.delimiter).filter(Boolean);

loadEnvFiles(envFiles);

const renderUrl = String(process.env.RENDER_AGENT_URL || process.env.BASE_URL || "").replace(/\/+$/, "");
const workerToken = process.env.REMOTE_WORKER_TOKEN || "";
const workerId = process.env.REMOTE_WORKER_ID || `${os.hostname()}-${process.pid}`;
const pollIntervalMs = Number(process.env.REMOTE_WORKER_INTERVAL_MS || 5000);
const taskRoot = path.resolve(process.env.REMOTE_WORKER_TASK_ROOT || path.join(__dirname, "remote-worker-tasks"));
const provider = process.env.REMOTE_WORKER_PROVIDER || "qwen";
const mode = process.env.REMOTE_WORKER_MODE || "auto";
const showThinking = String(process.env.REMOTE_WORKER_SHOW_THINKING || "false") === "true";
const packageResults = String(process.env.REMOTE_WORKER_PACKAGE_RESULTS || "true").toLowerCase() !== "false";
const maxResultBytes = Number(process.env.REMOTE_WORKER_MAX_RESULT_BYTES || 60 * 1024 * 1024);
const taskTimeoutMs = Number(process.env.REMOTE_WORKER_TASK_TIMEOUT_MS || 2 * 60 * 60 * 1000);
const accessFile = path.resolve(process.env.REMOTE_WORKER_ACCESS_FILE || path.join(__dirname, "remote-access.enabled"));
const lmStudioAdminBase = String(process.env.LMSTUDIO_ADMIN_BASE || "http://127.0.0.1:1234/api/v1").replace(/\/+$/, "");
const lmStudioSwitchBase = String(process.env.LMSTUDIO_SWITCH_BASE || "http://127.0.0.1:1235/v1").replace(/\/+$/, "");
const lmStudioVisionModel = process.env.REMOTE_WORKER_VISION_MODEL || "google/gemma-4-e4b";
const xliffTranslationContextWindow = Number(process.env.REMOTE_XLIFF_CONTEXT_WINDOW || process.env.LM_CONTEXT_WINDOW || 40000);
const xliffTranslationSourceTokens = Number(process.env.REMOTE_XLIFF_BATCH_SOURCE_TOKENS || process.env.LM_BATCH_SOURCE_TOKENS || 20000);
const xliffTranslationOutputTokens = Number(process.env.REMOTE_XLIFF_TARGET_OUTPUT_TOKENS || process.env.LM_FULL_CONTEXT_TARGET_OUTPUT_TOKENS || 40000);
const xliffTranslationMinOutputTokens = Number(process.env.REMOTE_XLIFF_MIN_OUTPUT_TOKENS || process.env.LM_FULL_CONTEXT_MIN_OUTPUT_TOKENS || 8000);
const xliffTranslationMaxUnits = Number(process.env.REMOTE_XLIFF_MAX_UNITS_PER_BLOCK || process.env.LM_MAX_UNITS_PER_BLOCK || 200);
const ensureProxyScript = path.join(projectRoot, "ensure-lmstudio-switch-proxy.ps1");
const xliffReferenceScript = process.env.XLIFF_TRANSLATOR_REFERENCE_SCRIPT
  || "C:\\codex\\agent_pipeline_translator_semantic_tuned_clean_core_v2_targetlock_allxml_onepass_fixed_pdf_mixed_pause_reload_new_relaod_LM_PROMPT_TAGS_STRICTEST_NUMERIC_TOC_TERMLOCK_TEST_P4_P8_POST_BATCH_AUDIT_CLEAN_UI_BATCH_A (2).py";
const directXliffTranslation = String(process.env.REMOTE_WORKER_DIRECT_XLIFF_TRANSLATION || "true").toLowerCase() !== "false";

if (!renderUrl) throw new Error("RENDER_AGENT_URL or BASE_URL is required");
if (!workerToken) throw new Error("REMOTE_WORKER_TOKEN is required");

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

function safeRelativePath(name) {
  const parts = String(name || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => safeName(part))
    .filter((part) => part && part !== "." && part !== "..");
  return parts.length ? parts.join("/") : "file";
}

function envBool(value, fallback = true) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on", "enabled", "allow"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled", "pause", "paused", "deny"].includes(normalized)) return false;
  return fallback;
}

async function remoteAccessStatus() {
  const envEnabled = envBool(process.env.REMOTE_WORKER_ACCESS_ENABLED, true);
  if (!envEnabled) {
    return { enabled: false, reason: "REMOTE_WORKER_ACCESS_ENABLED=false", file: accessFile };
  }
  try {
    const raw = (await fsp.readFile(accessFile, "utf8")).trim().toLowerCase();
    if (!raw) return { enabled: true, reason: "empty access file", file: accessFile };
    const enabled = envBool(raw, true);
    return { enabled, reason: `${path.basename(accessFile)}=${raw}`, file: accessFile };
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: true, reason: "access file missing", file: accessFile };
    return { enabled: false, reason: `cannot read access file: ${error.message}`, file: accessFile };
  }
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFilesBuffer(files) {
  const chunks = [];
  const central = [];
  const { dosTime, dosDate } = dosDateTime();
  let offset = 0;

  for (const file of files) {
    const name = safeRelativePath(file.relativePath || file.name);
    const nameBuffer = Buffer.from(name, "utf8");
    const body = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || "");
    const checksum = crc32(body);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    chunks.push(localHeader, nameBuffer, body);
    central.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + body.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
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

function normalizeWorkerProvider(value) {
  if (value === "grok" || value === "grok-build") return "grok-build";
  if (value === "grok-general") return "grok-general";
  if (value === "gemma-e2b" || value === "gemma-e4b") return value;
  return "qwen";
}

function baseContinueConfigPath(providerId = provider) {
  if (process.env.REMOTE_WORKER_CONTINUE_CONFIG) return path.resolve(process.env.REMOTE_WORKER_CONTINUE_CONFIG);
  const normalized = normalizeWorkerProvider(providerId);
  if (normalized === "gemma-e2b") return path.join(localStackRoot, "continue-config-gemma-e2b.yaml");
  if (normalized === "gemma-e4b") return path.join(localStackRoot, "continue-config-gemma-e4b.yaml");
  if (normalized === "grok-build") return path.join(localStackRoot, "continue-config-grok.yaml");
  if (normalized === "grok-general") return path.join(localStackRoot, "continue-config-grok-general.yaml");
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
    "  - If the user asks to translate or localize any uploaded document or archive, use an XLIFF roundtrip only: convert/extract to XLIFF, translate XLIFF targets while preserving tags/ids/placeholders, audit/repair, then reconstruct outputs from translated XLIFF.",
    "  - Do not translate DOCX/PDF/XLSX/PPTX/HTML/XML text by directly reading it and writing a translated file with generic Python libraries; such libraries are allowed only for XLIFF conversion, reconstruction, and validation.",
    "  - Put requested downloadable deliverables into the output directory named in the prompt.",
    "  - Never print secrets or API keys.",
    "",
  ].filter((line) => line !== "").join("\n");
}

function xliffTranslatorEnv() {
  const embeddingMemoryEnabled =
    process.env.REMOTE_XLIFF_EMBEDDING_MEMORY_ENABLED
    || process.env.LM_EMBEDDING_MEMORY_ENABLED
    || "0";
  const embeddingCacheEnabled =
    process.env.REMOTE_XLIFF_EMBEDDING_CACHE_ENABLED
    || process.env.LM_EMBEDDING_CACHE_ENABLED
    || "0";
  const tmxDriveEnabled = process.env.REMOTE_XLIFF_TMX_GOOGLE_DRIVE_ENABLED || "0";
  return {
    LM_CONTEXT_WINDOW: String(xliffTranslationContextWindow),
    LM_BATCH_SOURCE_TOKENS: String(xliffTranslationSourceTokens),
    LM_MAX_UNITS_PER_BLOCK: String(xliffTranslationMaxUnits),
    LM_ENABLE_FULL_CONTEXT_WINDOWS: process.env.REMOTE_XLIFF_ENABLE_FULL_CONTEXT_WINDOWS || "1",
    LM_FULL_CONTEXT_MIN_OUTPUT_TOKENS: String(xliffTranslationMinOutputTokens),
    LM_FULL_CONTEXT_TARGET_OUTPUT_TOKENS: String(xliffTranslationOutputTokens),
    LM_FULL_CONTEXT_MAX_UNITS_PER_REQUEST: String(xliffTranslationMaxUnits),
    XLIFF_TERMINOLOGY_LOCK_ENABLED: process.env.XLIFF_TERMINOLOGY_LOCK_ENABLED || "1",
    XLIFF_TERMINOLOGY_AUTO_DOCUMENT_TERMS: process.env.XLIFF_TERMINOLOGY_AUTO_DOCUMENT_TERMS || "1",
    XLIFF_TERMINOLOGY_AUDIT_ONLY: process.env.XLIFF_TERMINOLOGY_AUDIT_ONLY || "0",
    XLIFF_TERMINOLOGY_MAX_TERMS_PER_BLOCK: process.env.REMOTE_XLIFF_TERMINOLOGY_MAX_TERMS_PER_BLOCK || "30",
    XLIFF_TERMINOLOGY_MAX_BASE_TERMS: process.env.REMOTE_XLIFF_TERMINOLOGY_MAX_BASE_TERMS || "1200",
    XLIFF_TERMINOLOGY_DOCUMENT_CANDIDATE_LIMIT: process.env.REMOTE_XLIFF_TERMINOLOGY_DOCUMENT_CANDIDATE_LIMIT || "60",
    XLIFF_TERMINOLOGY_PLANNING_MAX_TOKENS: process.env.REMOTE_XLIFF_TERMINOLOGY_PLANNING_MAX_TOKENS || "2500",
    XLIFF_POST_BATCH_AUDIT_ENABLED: process.env.REMOTE_XLIFF_POST_BATCH_AUDIT_ENABLED || process.env.XLIFF_POST_BATCH_AUDIT_ENABLED || "0",
    XLIFF_TAG_THINKING_REPAIR_ENABLED: process.env.REMOTE_XLIFF_TAG_THINKING_REPAIR_ENABLED || process.env.XLIFF_TAG_THINKING_REPAIR_ENABLED || "0",
    TMX_GOOGLE_DRIVE_ENABLED: tmxDriveEnabled,
    TMX_FOLDER: process.env.REMOTE_XLIFF_TMX_FOLDER || "",
    TMX_APPLY_EXACT_MATCHES: process.env.REMOTE_XLIFF_TMX_APPLY_EXACT_MATCHES || "0",
    LM_EMBEDDING_MEMORY_ENABLED: embeddingMemoryEnabled,
    LM_EMBEDDING_CACHE_ENABLED: embeddingCacheEnabled,
    LM_EMBEDDING_MAX_TMX_REFERENCES: process.env.REMOTE_XLIFF_EMBEDDING_MAX_TMX_REFERENCES || "0",
    DOCUMENT_TRANSLATION_CACHE_ENABLED: process.env.DOCUMENT_TRANSLATION_CACHE_ENABLED || "1",
  };
}

async function prepareContinueRun(task, taskDir) {
  const profile = task.llmProfile;
  if (profile?.model && profile?.apiBase) {
    const config = path.join(taskDir, "continue-personal.yaml");
    await fsp.writeFile(config, personalContinueConfig(profile), "utf8");
    return {
      config,
      env: { ...xliffTranslatorEnv(), ...(profile.apiKey ? { REMOTE_TASK_LLM_API_KEY: profile.apiKey } : {}) },
      label: `personal:${profile.model}`,
    };
  }
  const selectedProvider = normalizeWorkerProvider(task.model?.id || task.provider || provider);
  const config = baseContinueConfigPath(selectedProvider);
  return {
    config,
    env: { ...xliffTranslatorEnv(), LMSTUDIO_API_TOKEN: process.env.LMSTUDIO_API_TOKEN || "lmstudio" },
    label: `${selectedProvider}:${path.basename(config)}`,
  };
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

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

function promptArgument(prompt, runConfig) {
  if (!runConfig.promptPath) return String(prompt || "");
  return `Read the UTF-8 task prompt from this file and follow it exactly: ${runConfig.promptPath}`;
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

async function waitForHttp(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {
      // Keep waiting until timeout.
    }
    await sleep(500);
  }
  return false;
}

async function ensureLmStudioSwitchProxy() {
  if (String(process.env.REMOTE_WORKER_ENSURE_LMSTUDIO_PROXY || "true").toLowerCase() === "false") return;
  if (await waitForHttp(`${lmStudioSwitchBase}/models`, 1500)) return;
  if (!fs.existsSync(ensureProxyScript)) return;
  await new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      ensureProxyScript,
    ], {
      cwd: projectRoot,
      windowsHide: true,
    });
    child.on("close", resolve);
    child.on("error", resolve);
  });
  await waitForHttp(`${lmStudioSwitchBase}/models`, 10000);
}

async function lmStudioAdminJson(method, apiPath, payload) {
  const response = await fetch(`${lmStudioAdminBase}${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.LMSTUDIO_API_TOKEN || "lmstudio"}`,
      "content-type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `${response.status} ${response.statusText}`);
  return data;
}

function lmStudioUnloadOnCancelEnabled() {
  return String(process.env.REMOTE_WORKER_UNLOAD_LMSTUDIO_ON_CANCEL || "true").toLowerCase() !== "false";
}

async function unloadLoadedLmStudioModels({ includeEmbeddings = false, onlyEmbeddings = false } = {}) {
  const data = await lmStudioAdminJson("GET", "/models");
  let unloaded = 0;
  for (const model of data.models || []) {
    const type = String(model.type || "").toLowerCase();
    const isEmbedding = type === "embedding" || type === "embeddings";
    if (onlyEmbeddings && !isEmbedding) continue;
    if (!includeEmbeddings && isEmbedding) continue;
    for (const instance of model.loaded_instances || []) {
      if (!instance.id) continue;
      await lmStudioAdminJson("POST", "/models/unload", { instance_id: instance.id });
      unloaded += 1;
    }
  }
  return unloaded;
}

async function unloadLoadedEmbeddingModels() {
  if (String(process.env.REMOTE_WORKER_UNLOAD_EMBEDDINGS_AFTER || "true").toLowerCase() === "false") return 0;
  return unloadLoadedLmStudioModels({ includeEmbeddings: true, onlyEmbeddings: true });
}

async function hardStopLmStudioGeneration(taskId, reason) {
  if (!lmStudioUnloadOnCancelEnabled()) return;
  try {
    const unloaded = await unloadLoadedLmStudioModels({ includeEmbeddings: false });
    if (unloaded) await logRemote(taskId, `Unloaded ${unloaded} LM Studio LLM instance(s) after ${reason}`);
  } catch (error) {
    await logRemote(taskId, `LM Studio hard stop skipped: ${error.message}`);
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

async function streamRemoteOutput(taskId, chunk) {
  if (!chunk) return;
  await remoteJson(`/api/worker/tasks/${encodeURIComponent(taskId)}/output`, {
    method: "POST",
    body: JSON.stringify({ chunk }),
  }).catch(() => {});
}

async function remoteTaskStatus(taskId) {
  return remoteJson(`/api/worker/tasks/${encodeURIComponent(taskId)}/status`);
}

async function saveInputFiles(task, inputDir) {
  await fsp.mkdir(inputDir, { recursive: true });
  const files = [];
  for (const file of task.files || []) {
    const relativePath = safeRelativePath(file.relativePath || file.name);
    const name = safeName(path.basename(relativePath));
    const target = path.join(inputDir, relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, Buffer.from(String(file.base64 || ""), "base64"));
    files.push({ ...file, name, relativePath, path: target });
  }
  return files;
}

function isImageFile(file) {
  const mime = String(file.mime || "").toLowerCase();
  const name = String(file.relativePath || file.name || "").toLowerCase();
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name);
}

function imageMime(file) {
  const mime = String(file.mime || "").toLowerCase();
  if (mime.startsWith("image/")) return mime;
  const name = String(file.relativePath || file.name || "").toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".bmp")) return "image/bmp";
  if (name.endsWith(".tif") || name.endsWith(".tiff")) return "image/tiff";
  return "image/png";
}

async function describeImages(task, inputFiles) {
  const images = inputFiles.filter(isImageFile);
  if (!images.length) return [];
  await ensureLmStudioSwitchProxy();
  const maxImageBytes = Number(process.env.REMOTE_WORKER_INLINE_IMAGE_MAX_BYTES || 20 * 1024 * 1024);
  const descriptions = [];
  for (const file of images) {
    try {
      const buffer = await fsp.readFile(file.path);
      if (buffer.length > maxImageBytes) {
        descriptions.push({
          file,
          error: `Image is too large for inline LM Studio vision payload (${buffer.length} bytes).`,
        });
        continue;
      }
      const response = await fetch(`${lmStudioSwitchBase}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.LMSTUDIO_API_TOKEN || "lmstudio"}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: lmStudioVisionModel,
          temperature: 0.1,
          max_tokens: 1400,
          messages: [
            {
              role: "system",
              content: "You are a vision-capable assistant. Describe screenshots and images precisely for a downstream local agent. Transcribe visible text, UI labels, objects, layout, errors, and anything relevant to the user's request. Answer in Russian.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `User request: ${task.prompt || "Analyze the image."}\nImage file: ${file.relativePath || file.name}`,
                },
                {
                  type: "image_url",
                  image_url: { url: `data:${imageMime(file)};base64,${buffer.toString("base64")}` },
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.error || `${response.status} ${response.statusText}`);
      descriptions.push({
        file,
        description: String(data.choices?.[0]?.message?.content || "").trim(),
      });
    } catch (error) {
      descriptions.push({ file, error: error.message });
    }
  }
  return descriptions;
}

function hasTranslationIntent(text) {
  return /\b(translate|translation|translated|locali[sz]e|locali[sz]ation)\b|перевод|перевести|переведи|локализ/i.test(String(text || ""));
}

function requiresXliffTranslation(task, inputFiles) {
  if (task.pipeline?.xliffTranslationRequired) return true;
  if (!hasTranslationIntent(task.prompt)) return false;
  if (!inputFiles.length) return true;
  return inputFiles.some((file) => {
    const name = String(file.relativePath || file.name || "").toLowerCase();
    return /\.(docx?|pdf|pptx?|xlsx?|odt|ods|odp|rtf|html?|xml|xlf|xliff|zip|7z|rar|tar|tgz|gz|bz2|xz)$/.test(name);
  });
}

function targetLanguagesFromPrompt(text) {
  const value = String(text || "").toLowerCase();
  const matches = [
    [/\u0444\u0440\u0430\u043d\u0446\u0443\u0437|french|fran[cç]ais/, "fr"],
    [/\u0447\u0435\u0448|czech|cest|cs\b/, "cs"],
    [/\u043d\u0435\u043c\u0435\u0446|german|deutsch|de\b/, "de"],
    [/\u0430\u043d\u0433\u043b|english|en\b/, "en"],
    [/\u0440\u0443\u0441|russian|ru\b/, "ru"],
    [/\u0443\u043a\u0440\u0430\u0438\u043d|ukrainian|uk\b/, "uk"],
    [/\u043f\u043e\u043b\u044c\u0441\u043a|polish|pl\b/, "pl"],
    [/\u0440\u0443\u043c\u044b\u043d|romanian|ro\b/, "ro"],
    [/\u0438\u0441\u043f\u0430\u043d|spanish|es\b/, "es"],
    [/\u0438\u0442\u0430\u043b|italian|it\b/, "it"],
    [/француз|french|français|francais/, "fr"],
    [/чеш|czech|češt|cest|cs\b/, "cs"],
    [/немец|german|deutsch|de\b/, "de"],
    [/англий|english|en\b/, "en"],
    [/русск|russian|ru\b/, "ru"],
    [/украин|ukrainian|uk\b/, "uk"],
    [/польск|polish|pl\b/, "pl"],
    [/румын|romanian|ro\b/, "ro"],
    [/испан|spanish|es\b/, "es"],
    [/итальян|italian|it\b/, "it"],
  ];
  const langs = [];
  for (const [pattern, lang] of matches) {
    if (pattern.test(value) && !langs.includes(lang)) langs.push(lang);
  }
  return langs.length ? langs : [process.env.REMOTE_XLIFF_DEFAULT_TARGET_LANG || "ru"];
}

function sourceLanguageFromPrompt(text, targetLangs = []) {
  const value = String(text || "").toLowerCase();
  if (/\u0441\s+\u0430\u043d\u0433\u043b|from\s+english|en\s*[-\u2192>]/.test(value)) return "en";
  if (/\u0441\s+\u0440\u0443\u0441|from\s+russian|ru\s*[-\u2192>]/.test(value)) return "ru";
  if (/\u0441\s+\u043d\u0435\u043c|from\s+german|de\s*[-\u2192>]/.test(value)) return "de";
  if (targetLangs.includes("en") && /[\u0400-\u04ff]/.test(value)) return "ru";
  return process.env.REMOTE_XLIFF_SOURCE_LANG || "en";
}

function directXliffSupportedFiles(inputFiles) {
  return inputFiles.filter((file) => {
    const name = String(file.relativePath || file.name || "").toLowerCase();
    return /\.(docx|pdf|zip)$/.test(name) && !path.basename(name).startsWith("~$");
  });
}

function xliffTranslationPolicyBlock(task, inputFiles) {
  if (!requiresXliffTranslation(task, inputFiles)) return [];
  return [
    "STRICT XLIFF TRANSLATION REQUIREMENT:",
    "The user is asking to translate/localize uploaded documents. Every document translation must go through XLIFF.",
    "Required path: source document/archive -> extracted working files -> XLIFF trans-units -> document-level terminology/memory collection -> locked terminology index -> large batched translation -> post-batch audit/repair -> reconstruct final document from the translated XLIFF.",
    `Reference implementation on this machine: ${xliffReferenceScript}`,
    "Use the reference implementation behavior, not a simplified translator. It first collects document terminology candidates and terminology locks for the whole XLIFF/document set, then translates unconfirmed units in large token-budgeted batches.",
    `Runtime XLIFF budget for this worker: LM_CONTEXT_WINDOW=${xliffTranslationContextWindow}, LM_BATCH_SOURCE_TOKENS=${xliffTranslationSourceTokens}, LM_MAX_UNITS_PER_BLOCK=${xliffTranslationMaxUnits}, LM_FULL_CONTEXT_MIN_OUTPUT_TOKENS=${xliffTranslationMinOutputTokens}, LM_FULL_CONTEXT_TARGET_OUTPUT_TOKENS=${xliffTranslationOutputTokens}.`,
    "This applies to every document format: DOCX paragraphs, PDF lines, XLSX cells/rows/sheets, PPTX text boxes/shapes/slides, HTML/XML nodes, and archives of mixed documents must all be converted to XLIFF first and translated as batched trans-units.",
    "Do not translate line-by-line, row-by-row, cell-by-cell, paragraph-by-paragraph, textbox-by-textbox, slide-by-slide, page-by-page, or one trans-unit per model call unless the reference implementation's fallback split is triggered by marker failure or post-batch audit failure.",
    "Do not skip terminology unification. Keep XLIFF_TERMINOLOGY_LOCK_ENABLED=1, XLIFF_TERMINOLOGY_AUTO_DOCUMENT_TERMS=1, and DOCUMENT_TRANSLATION_CACHE_ENABLED=1. In the remote test mode, avoid recursive post-batch retranslation and model-based smart tag repair unless the user explicitly enables them.",
    "For DOCX use the reference-style flow: docx_to_xliff -> translate_xliff_file -> xliff_to_docx.",
    "For PDF use the reference-style flow: pdf_to_xliff -> translate_xliff_file -> xliff_to_pdf_page_aware.",
    "For a mixed folder/archive, unpack it first, process every supported document through the XLIFF flow, preserve relative paths, and put all final documents plus useful XLIFF/audit artifacts into the output directory.",
    "Do not translate document prose by directly reading it and writing a new DOCX/PDF/XLSX/PPTX with generic Python libraries. Libraries such as python-docx, PyMuPDF, openpyxl, or XML/ZIP helpers may only be used for XLIFF conversion, reconstruction, and validation.",
    "If a format cannot be reconstructed safely, still create and translate an intermediate XLIFF, include the translated XLIFF in results.zip, and write a short note explaining the reconstruction blocker.",
    "",
  ];
}

function visionAnalysisBlock(visionDescriptions) {
  if (!visionDescriptions.length) return [];
  const lines = ["LM Studio vision analysis for attached images:"];
  for (const item of visionDescriptions) {
    const label = item.file.relativePath || item.file.name;
    lines.push(`- ${label}:`);
    if (item.description) lines.push(item.description);
    if (item.error) lines.push(`Vision analysis error: ${item.error}`);
  }
  lines.push("");
  return lines;
}

function conversationHistoryBlock(history) {
  const messages = Array.isArray(history)
    ? history.filter((message) => message?.content && ["user", "assistant", "system"].includes(message.role))
    : [];
  if (!messages.length) return [];
  const lines = [
    "Current chat history:",
    "Use this history as the conversation context for follow-up questions. If the current request refers to a previous file, answer, presentation, screenshot, or conclusion, resolve that reference from this history before claiming missing inputs.",
    "",
  ];
  for (const message of messages) {
    const role = message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User";
    lines.push(`${role}:`);
    lines.push(String(message.content).trim());
    lines.push("");
  }
  return lines;
}

function buildPrompt(task, inputDir, outputDir, inputFiles, visionDescriptions = []) {
  const fileList = inputFiles.length
    ? inputFiles.map((file) => `- ${file.relativePath || file.name}: ${file.path}`).join("\n")
    : "- no files";
  return [
    `Remote task ${task.id}.`,
    `Workspace: ${projectRoot}`,
    `Input directory: ${inputDir}`,
    `Output directory: ${outputDir}`,
    `Selected local model: ${task.model?.name || task.model?.id || provider}.`,
    "",
    "Use the input files and the local filesystem directly. Archives may contain full datasets; unpack them when needed.",
    "For dataset/RAG/conversion tasks, process every relevant input file, preserve useful relative paths, and write machine-readable outputs into the output directory.",
    "Write final artifacts into the output directory; the worker will always package them as results.zip.",
    "If the task is pure analysis, create result.md in the output directory with the final answer.",
    "Do not put secrets into outputs or logs.",
    "Answer in Russian unless the task explicitly asks for another language.",
    "",
    ...xliffTranslationPolicyBlock(task, inputFiles),
    ...conversationHistoryBlock(task.chatHistory),
    ...visionAnalysisBlock(visionDescriptions),
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
  const invocationArgs = [...args, promptArgument(prompt, runConfig)];

  const env = { ...process.env, ...runConfig.env, NO_COLOR: "1" };

  if (process.platform === "win32") {
    const command = [cn, ...invocationArgs].map(cmdQuote).join(" ");
    const child = spawn(command, {
      cwd: projectRoot,
      env,
      shell: process.env.ComSpec || true,
      windowsHide: true,
    });
    child.stdin.end();
    return { child, config, args };
  }

  const child = spawn(cn, invocationArgs, {
    cwd: projectRoot,
    env,
    detached: true,
    windowsHide: true,
  });
  child.stdin.end();
  return { child, config, args };
}

async function runContinue(taskId, prompt, runConfig) {
  await ensureLmStudioSwitchProxy();
  const { child, config, args } = spawnContinue(prompt, runConfig);
  let transcript = "";
  let settled = false;
  let lastLogAt = Date.now();

  await logRemote(taskId, `Continue started with ${runConfig.label || path.basename(config)} (${args.join(" ")})`);

  return await new Promise((resolve, reject) => {
    let cancelPollInFlight = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid);
      void hardStopLmStudioGeneration(taskId, "timeout");
      reject(new Error(`Continue task timed out after ${Math.round(taskTimeoutMs / 1000)} seconds`));
    }, taskTimeoutMs);
    const cancelTimer = setInterval(async () => {
      if (settled || cancelPollInFlight) return;
      cancelPollInFlight = true;
      try {
        const status = await remoteTaskStatus(taskId);
        if (status.cancelRequested) {
          settled = true;
          clearTimeout(timer);
          clearInterval(cancelTimer);
          await logRemote(taskId, "Cancellation received; stopping Continue/LM Studio task");
          killProcessTree(child.pid);
          await hardStopLmStudioGeneration(taskId, "user cancellation");
          reject(new Error("Stopped by user"));
        }
      } catch {
        // Cancellation polling is best-effort; the next poll or final task state will catch up.
      } finally {
        cancelPollInFlight = false;
      }
    }, 1500);

    const collect = (chunk, streamName) => {
      const text = chunk.toString("utf8");
      transcript += text;
      if (streamName === "stdout") streamRemoteOutput(taskId, text);
      const now = Date.now();
      if (streamName !== "stdout" && now - lastLogAt > 30000) {
        lastLogAt = now;
        logRemote(taskId, `${streamName}: ${Buffer.byteLength(text)} bytes; total transcript ${Buffer.byteLength(transcript)} bytes`);
      }
    };

    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelTimer);
      resolve({ code, transcript });
    });
  });
}

function directXliffRunnerScript() {
  return String.raw`
import json
import html
import os
import re
import shutil
import sys
import traceback
import types
import zipfile
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

translator_path = Path(sys.argv[1])
input_dir = Path(sys.argv[2])
output_dir = Path(sys.argv[3])
source_lang = sys.argv[4]
target_langs = [item.strip() for item in sys.argv[5].split(",") if item.strip()]
files = [Path(item) for item in json.loads(sys.argv[6])]

output_dir.mkdir(parents=True, exist_ok=True)

source = translator_path.read_text(encoding="utf-8-sig")
gui_marker = "\n# =====================\n# GUI actions"
if gui_marker in source:
    source = source.split(gui_marker, 1)[0]

module = types.ModuleType("xliff_translator_core")
module.__file__ = str(translator_path)
sys.modules[module.__name__] = module
exec(compile(source, str(translator_path), "exec"), module.__dict__)

def apply_pdf_runtime_overrides():
    try:
        import pymupdf as pymupdf_fitz
    except Exception:
        try:
            import fitz as pymupdf_fitz
        except Exception:
            return
    try:
        if not hasattr(pymupdf_fitz, "open"):
            return
        module.fitz = pymupdf_fitz
        module._require_fitz = lambda: None
    except Exception:
        pass

def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return bool(default)
    return str(value).strip().lower() not in {"0", "false", "no", "off", "disabled"}

def apply_direct_runtime_overrides():
    embedding_enabled = env_flag("LM_EMBEDDING_MEMORY_ENABLED", False)
    embedding_cache_enabled = env_flag("LM_EMBEDDING_CACHE_ENABLED", False)
    post_batch_audit_enabled = env_flag("XLIFF_POST_BATCH_AUDIT_ENABLED", False)
    tag_thinking_repair_enabled = env_flag("XLIFF_TAG_THINKING_REPAIR_ENABLED", False)
    try:
        module.EMBEDDING_MEMORY_ENABLED = embedding_enabled
        module.EMBEDDING_CACHE_ENABLED = embedding_cache_enabled
        module._RUNTIME_EMBEDDING_MEMORY_ENABLED = embedding_enabled
        module.use_embedding_memory = lambda: embedding_enabled
        module.XLIFF_POST_BATCH_AUDIT_ENABLED = post_batch_audit_enabled
        module._RUNTIME_XLIFF_POST_BATCH_AUDIT_ENABLED = post_batch_audit_enabled
        module.XLIFF_TAG_THINKING_REPAIR_ENABLED = tag_thinking_repair_enabled
        module._RUNTIME_XLIFF_TAG_THINKING_REPAIR_ENABLED = tag_thinking_repair_enabled
    except Exception:
        pass

    original_sync = getattr(module, "sync_runtime_options_from_gui", None)
    if callable(original_sync):
        def sync_runtime_options_from_env():
            original_sync()
            try:
                module.EMBEDDING_MEMORY_ENABLED = embedding_enabled
                module.EMBEDDING_CACHE_ENABLED = embedding_cache_enabled
                module._RUNTIME_EMBEDDING_MEMORY_ENABLED = embedding_enabled
                module.use_embedding_memory = lambda: embedding_enabled
                module.XLIFF_POST_BATCH_AUDIT_ENABLED = post_batch_audit_enabled
                module._RUNTIME_XLIFF_POST_BATCH_AUDIT_ENABLED = post_batch_audit_enabled
                module.XLIFF_TAG_THINKING_REPAIR_ENABLED = tag_thinking_repair_enabled
                module._RUNTIME_XLIFF_TAG_THINKING_REPAIR_ENABLED = tag_thinking_repair_enabled
            except Exception:
                pass
        module.sync_runtime_options_from_gui = sync_runtime_options_from_env

    if env_flag("REMOTE_XLIFF_AVOID_FORCE_MODEL_RELOAD", True):
        def keep_translation_model_ready(reason=""):
            model_name = module.active_translation_model()
            module._ACTIVE_MODEL_ID = ""
            module._ACTIVE_TRANSLATION_MODEL_NAME = model_name
            module._FORCED_MODEL_READY = True
            return model_name

        def keep_loaded_models(reason=""):
            return []

        module.reload_forced_translation_model = keep_translation_model_ready
        module.load_forced_translation_model = keep_translation_model_ready
        module.unload_loaded_models = keep_loaded_models

apply_pdf_runtime_overrides()
apply_direct_runtime_overrides()

def log(message, level="INFO"):
    safe_message = str(message).encode("utf-8", errors="replace").decode("utf-8", errors="replace")
    print(f"[{level}] {safe_message}", flush=True)

module.pump_ui_events = lambda: None
module.wait_if_paused = lambda reason="": None
module.set_status = lambda message: log(message, "STATUS")
module.set_progress = lambda pct: log(f"progress={float(pct):.1f}%", "PROGRESS")
module.log_to_shell = log

produced = []

def is_supported_document(path):
    return path.suffix.lower() in {".docx", ".pdf"} and not path.name.lower().startswith("~$")

def safe_archive_extract(zip_path, destination):
    extracted = []
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            raw_name = info.filename.replace("\\\\", "/")
            raw_parts = raw_name.split("/")
            parts = [part for part in raw_parts if part and part not in {".", ".."}]
            if not parts or len(parts) != len([part for part in raw_parts if part]):
                continue
            target = destination.joinpath(*parts)
            resolved = target.resolve()
            if not str(resolved).lower().startswith(str(root).lower()):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source_stream, target.open("wb") as target_stream:
                shutil.copyfileobj(source_stream, target_stream)
            extracted.append(target)
    return extracted

def expand_input_files(paths):
    expanded = []
    extract_root = input_dir / "_direct_xliff_extracted"
    for file_path in paths:
        file_path = Path(file_path)
        if is_supported_document(file_path):
            expanded.append(file_path)
            continue
        if file_path.suffix.lower() == ".zip":
            archive_root = extract_root / re.sub(r"[^A-Za-z0-9_.-]+", "_", file_path.stem or "archive")
            log(f"Extracting archive {file_path.name} for XLIFF document translation")
            safe_archive_extract(file_path, archive_root)
            docs = sorted(path for path in archive_root.rglob("*") if path.is_file() and is_supported_document(path))
            log(f"Archive {file_path.name}: found {len(docs)} supported DOCX/PDF file(s)")
            expanded.extend(docs)
            continue
        log(f"Ignoring unsupported uploaded file for direct XLIFF: {file_path.name}", "WARNING")
    return expanded

def output_prefix_for(file_path):
    try:
        rel = Path(file_path).relative_to(input_dir)
    except ValueError:
        rel = Path(file_path).name
    parent = Path(rel).parent
    if str(parent) in {"", "."}:
        return ""
    parts = [part for part in parent.parts if part not in {"_direct_xliff_extracted"}]
    if not parts:
        return ""
    prefix = "__".join(re.sub(r"[^A-Za-z0-9_.-]+", "_", part).strip("._") for part in parts[-4:])
    return f"{prefix}__" if prefix else ""

def docx_text_sample(path, limit=60000):
    chunks = []
    try:
        with zipfile.ZipFile(path) as archive:
            names = [
                name for name in archive.namelist()
                if name.startswith("word/") and name.endswith(".xml")
            ]
            for name in names:
                raw = archive.read(name).decode("utf-8", errors="ignore")
                text = re.sub(r"<[^>]+>", " ", raw)
                text = html.unescape(re.sub(r"\s+", " ", text)).strip()
                if text:
                    chunks.append(text)
                if sum(len(item) for item in chunks) >= limit:
                    break
    except Exception:
        return ""
    return " ".join(chunks)[:limit]

def pdf_text_sample(path, limit=60000):
    try:
        import pymupdf as fitz
    except Exception:
        try:
            import fitz
        except Exception:
            return ""
    chunks = []
    try:
        with fitz.open(str(path)) as document:
            for page in document[: min(5, len(document))]:
                text = page.get_text("text") or ""
                if text:
                    chunks.append(text)
                if sum(len(item) for item in chunks) >= limit:
                    break
    except Exception:
        return ""
    return " ".join(chunks)[:limit]

def text_sample_for_language(path):
    if path.suffix.lower() == ".docx":
        return docx_text_sample(path)
    if path.suffix.lower() == ".pdf":
        return pdf_text_sample(path)
    return ""

def detect_source_language(path, fallback):
    lower_name = path.name.lower()
    if re.search(r"(^|[\\s_.()\\-])en([\\s_.()\\-]|$)|english", lower_name):
        return "en"
    if re.search(r"(^|[\\s_.()\\-])ru([\\s_.()\\-]|$)|russian", lower_name):
        return "ru"
    sample = text_sample_for_language(path)
    cyrillic = len(re.findall(r"[\u0400-\u04ff]", sample))
    latin = len(re.findall(r"[A-Za-z]", sample))
    if cyrillic >= 30 and cyrillic >= latin * 0.18:
        return "ru"
    if latin >= 80 and cyrillic < 30:
        return "en"
    return fallback

def copy_result(path, prefix=""):
    path = Path(path)
    if not path.exists() or not path.is_file():
        return None
    name = f"{prefix}{path.name}" if prefix else path.name
    target = output_dir / name
    if path.resolve() != target.resolve():
        shutil.copy2(path, target)
    produced.append(str(target))
    return target

try:
    if not target_langs:
        raise RuntimeError("No target languages were detected for direct XLIFF translation")
    if not files:
        raise RuntimeError("No supported DOCX/PDF files were found for direct XLIFF translation")
    files = expand_input_files(files)
    if not files:
        raise RuntimeError("No DOCX/PDF files were found inside the uploaded files or archives")

    for target_lang in target_langs:
        log(f"Direct XLIFF translation started: {source_lang}->{target_lang}; files={len(files)}")
        for file_path in files:
            suffix = file_path.suffix.lower()
            prefix = output_prefix_for(file_path)
            file_source_lang = detect_source_language(file_path, source_lang)
            if file_source_lang == target_lang:
                log(f"Skipping {file_path.name}: detected source language is already {target_lang}; copying original to results")
                copy_result(file_path, prefix)
                continue
            log(f"Processing {file_path.name} via reference XLIFF pipeline ({file_source_lang}->{target_lang})")
            if suffix == ".docx":
                translated_xliff, translated_doc = module.process_docx_pipeline(str(file_path), file_source_lang, target_lang, work_root=output_dir)
                copy_result(translated_xliff, prefix)
                copy_result(translated_doc, prefix)
            elif suffix == ".pdf":
                translated_xliff, translated_pdf = module.process_pdf_pipeline(str(file_path), file_source_lang, target_lang, work_root=output_dir)
                copy_result(translated_xliff, prefix)
                copy_result(translated_pdf, prefix)
            else:
                raise RuntimeError(f"Unsupported file for direct XLIFF runner: {file_path}")

    summary = output_dir / "result.md"
    summary.write_text(
        "# Direct XLIFF translation\n\n"
        f"Source language: {source_lang}\n\n"
        f"Target languages: {', '.join(target_langs)}\n\n"
        "Generated files:\n"
        + "\n".join(f"- {Path(item).name}" for item in produced)
        + "\n",
        encoding="utf-8",
    )
    print("DIRECT_XLIFF_DONE " + json.dumps({"files": produced}, ensure_ascii=False), flush=True)
except Exception:
    traceback.print_exc()
    raise
`;
}

async function runDirectXliffTranslation(taskId, task, inputFiles, taskDir, outputDir) {
  await ensureLmStudioSwitchProxy();
  const supported = directXliffSupportedFiles(inputFiles);
  if (!supported.length) {
    throw new Error("Direct XLIFF runner currently supports DOCX/PDF inputs for translation jobs");
  }

  const targetLangs = targetLanguagesFromPrompt(task.prompt);
  const sourceLang = sourceLanguageFromPrompt(task.prompt, targetLangs);
  const scriptPath = path.join(taskDir, "direct-xliff-runner.py");
  await fsp.writeFile(scriptPath, directXliffRunnerScript(), "utf8");

  const env = {
    ...process.env,
    ...xliffTranslatorEnv(),
    LM_STUDIO_API_URL: process.env.REMOTE_XLIFF_LM_STUDIO_API_URL || `${lmStudioSwitchBase}/chat/completions`,
    LM_STUDIO_API_TOKEN: process.env.LMSTUDIO_API_TOKEN || process.env.LM_STUDIO_API_TOKEN || "lmstudio",
    LM_STUDIO_FULL_RESTART: process.env.LM_STUDIO_FULL_RESTART || "0",
    LM_STUDIO_STOP_AFTER_SESSION: process.env.LM_STUDIO_STOP_AFTER_SESSION || "0",
    LM_MODEL_CLEAN_START_DELAY_SECONDS: process.env.LM_MODEL_CLEAN_START_DELAY_SECONDS || "0",
    REMOTE_XLIFF_AVOID_FORCE_MODEL_RELOAD: process.env.REMOTE_XLIFF_AVOID_FORCE_MODEL_RELOAD || "1",
    TMX_GOOGLE_DRIVE_ENABLED: process.env.REMOTE_XLIFF_TMX_GOOGLE_DRIVE_ENABLED || "0",
    TMX_FOLDER: process.env.REMOTE_XLIFF_TMX_FOLDER || "",
    TMX_APPLY_EXACT_MATCHES: process.env.REMOTE_XLIFF_TMX_APPLY_EXACT_MATCHES || "0",
    LM_EMBEDDING_MEMORY_ENABLED: process.env.REMOTE_XLIFF_EMBEDDING_MEMORY_ENABLED || "0",
    LM_EMBEDDING_CACHE_ENABLED: process.env.REMOTE_XLIFF_EMBEDDING_CACHE_ENABLED || "0",
    LM_EMBEDDING_MAX_TMX_REFERENCES: process.env.REMOTE_XLIFF_EMBEDDING_MAX_TMX_REFERENCES || "0",
    XLIFF_POST_BATCH_AUDIT_ENABLED: process.env.REMOTE_XLIFF_POST_BATCH_AUDIT_ENABLED || "0",
    XLIFF_TAG_THINKING_REPAIR_ENABLED: process.env.REMOTE_XLIFF_TAG_THINKING_REPAIR_ENABLED || "0",
    XLIFF_SMART_TAG_REPAIR_CLEAN_LOCAL_SESSION: process.env.REMOTE_XLIFF_SMART_TAG_REPAIR_CLEAN_LOCAL_SESSION || "0",
    XLIFF_TERMINOLOGY_MAX_TERMS_PER_BLOCK: process.env.REMOTE_XLIFF_TERMINOLOGY_MAX_TERMS_PER_BLOCK || "30",
    XLIFF_TERMINOLOGY_MAX_BASE_TERMS: process.env.REMOTE_XLIFF_TERMINOLOGY_MAX_BASE_TERMS || "1200",
    XLIFF_TERMINOLOGY_DOCUMENT_CANDIDATE_LIMIT: process.env.REMOTE_XLIFF_TERMINOLOGY_DOCUMENT_CANDIDATE_LIMIT || "60",
    XLIFF_TERMINOLOGY_PLANNING_MAX_TOKENS: process.env.REMOTE_XLIFF_TERMINOLOGY_PLANNING_MAX_TOKENS || "2500",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    NO_COLOR: "1",
  };
  const args = [
    "-3.11",
    scriptPath,
    xliffReferenceScript,
    path.join(taskDir, "inputs"),
    outputDir,
    sourceLang,
    targetLangs.join(","),
    JSON.stringify(supported.map((file) => file.path)),
  ];

  await logRemote(
    taskId,
    `Direct XLIFF runner started (${sourceLang}->${targetLangs.join(", ")}; files=${supported.length}; context=${xliffTranslationContextWindow}; batch_source=${xliffTranslationSourceTokens}; target_output=${xliffTranslationOutputTokens}; tmx=${env.TMX_GOOGLE_DRIVE_ENABLED === "1" ? "on" : "off"}; embedding=${env.LM_EMBEDDING_MEMORY_ENABLED === "1" ? "on" : "off"})`,
  );

  return await new Promise((resolve, reject) => {
    const child = spawn("py", args, {
      cwd: projectRoot,
      env,
      windowsHide: true,
    });
    let transcript = "";
    let settled = false;
    let cancelPollInFlight = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid);
      void hardStopLmStudioGeneration(taskId, "direct XLIFF timeout");
      reject(new Error(`Direct XLIFF task timed out after ${Math.round(taskTimeoutMs / 1000)} seconds`));
    }, taskTimeoutMs);
    const cancelTimer = setInterval(async () => {
      if (settled || cancelPollInFlight) return;
      cancelPollInFlight = true;
      try {
        const status = await remoteTaskStatus(taskId);
        if (status.cancelRequested) {
          settled = true;
          clearTimeout(timer);
          clearInterval(cancelTimer);
          await logRemote(taskId, "Cancellation received; stopping direct XLIFF translation");
          killProcessTree(child.pid);
          await hardStopLmStudioGeneration(taskId, "direct XLIFF cancellation");
          reject(new Error("Stopped by user"));
        }
      } catch {
        // Best-effort cancellation polling.
      } finally {
        cancelPollInFlight = false;
      }
    }, 1500);

    const collect = (chunk, streamName) => {
      const text = chunk.toString("utf8");
      transcript += text;
      streamRemoteOutput(taskId, text);
      for (const line of text.split(/\r?\n/)) {
        const clean = line.trim();
        if (clean) logRemote(taskId, clean).catch(() => {});
      }
      if (streamName === "stderr") console.warn(`[${taskId}] ${text}`);
    };

    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelTimer);
      if (code !== 0) reject(new Error(`Direct XLIFF runner exited with code ${code}`));
      else resolve({ code, transcript });
    });
  });
}

async function listResultFiles(dir) {
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
        name: safeName(path.basename(relative)),
        relativePath: safeRelativePath(relative),
        mime: mimeFromName(relative),
        path: fullPath,
        size: stat.size,
      });
    }
  }

  await walk(dir);
  return out;
}

function openXmlPackageInfo(dir) {
  if (!fs.existsSync(path.join(dir, "[Content_Types].xml"))) return null;
  if (fs.existsSync(path.join(dir, "ppt", "presentation.xml"))) {
    return { ext: ".pptx", defaultName: "repaired-presentation.pptx", roots: ["[Content_Types].xml", "_rels", "docProps", "ppt"] };
  }
  if (fs.existsSync(path.join(dir, "word", "document.xml"))) {
    return { ext: ".docx", defaultName: "repaired-document.docx", roots: ["[Content_Types].xml", "_rels", "docProps", "word", "customXml"] };
  }
  if (fs.existsSync(path.join(dir, "xl", "workbook.xml"))) {
    return { ext: ".xlsx", defaultName: "repaired-workbook.xlsx", roots: ["[Content_Types].xml", "_rels", "docProps", "xl", "customXml"] };
  }
  return null;
}

async function collectOpenXmlPackageEntries(packageDir, roots) {
  const entries = [];

  async function addPath(relative) {
    const fullPath = path.join(packageDir, relative);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat) return;
    if (stat.isDirectory()) {
      const children = await fsp.readdir(fullPath, { withFileTypes: true });
      for (const child of children) await addPath(path.join(relative, child.name));
      return;
    }
    if (!stat.isFile() || !stat.size) return;
    entries.push({
      relativePath: relative.replace(/\\/g, "/"),
      buffer: await fsp.readFile(fullPath),
    });
  }

  for (const root of roots) await addPath(root);
  return entries;
}

function repairedOpenXmlName(task, info, packageDir, outputDir) {
  if (packageDir !== outputDir) {
    return `${safeName(path.basename(packageDir).replace(/\.[^.]+$/, ""))}${info.ext}`;
  }
  const source = (task.files || []).find((file) => path.extname(file.name).toLowerCase() === info.ext);
  if (!source) return info.defaultName;
  return `${safeName(path.basename(source.name, info.ext))}_processed${info.ext}`;
}

async function repairOpenXmlPackageOutputs(task, outputDir) {
  const candidates = [outputDir];
  const firstLevel = await fsp.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  for (const entry of firstLevel) {
    if (entry.isDirectory()) candidates.push(path.join(outputDir, entry.name));
  }

  const repaired = [];
  for (const dir of candidates) {
    const info = openXmlPackageInfo(dir);
    if (!info) continue;
    const entries = await collectOpenXmlPackageEntries(dir, info.roots);
    if (!entries.length) continue;
    const fileName = repairedOpenXmlName(task, info, dir, outputDir);
    const target = path.join(outputDir, fileName);
    const buffer = zipFilesBuffer(entries);
    await fsp.writeFile(target, buffer);
    repaired.push(fileName);
  }
  return repaired;
}

function isRawOpenXmlPackagePart(relativePath) {
  const value = String(relativePath || "").replace(/\\/g, "/");
  return value === "[Content_Types].xml"
    || value.startsWith("_rels/")
    || value.startsWith("docProps/")
    || value.startsWith("ppt/")
    || value.startsWith("word/")
    || value.startsWith("xl/")
    || value.startsWith("customXml/");
}

async function collectResultFiles(dir, { onlyArchive = false } = {}) {
  if (onlyArchive) {
    const archivePath = path.join(dir, "results.zip");
    const stat = await fsp.stat(archivePath);
    return [{
      name: "results.zip",
      relativePath: "results.zip",
      mime: "application/zip",
      base64: (await fsp.readFile(archivePath)).toString("base64"),
      size: stat.size,
    }];
  }
  const listed = await listResultFiles(dir);
  return await Promise.all(listed.map(async (file) => ({
    name: file.name,
    relativePath: file.relativePath,
    mime: file.mime,
    base64: (await fsp.readFile(file.path)).toString("base64"),
  })));
}

async function packageOutputArchive(outputDir, { excludeRawOpenXmlParts = false } = {}) {
  if (!packageResults) return false;
  const files = (await listResultFiles(outputDir))
    .filter((file) => file.relativePath !== "results.zip")
    .filter((file) => !excludeRawOpenXmlParts || !isRawOpenXmlPackagePart(file.relativePath));
  if (!files.length) return false;
  const zipEntries = await Promise.all(files.map(async (file) => ({
    name: file.name,
    relativePath: file.relativePath,
    buffer: await fsp.readFile(file.path),
  })));
  const buffer = zipFilesBuffer(zipEntries);
  if (buffer.length > maxResultBytes) throw new Error(`results.zip exceeds ${maxResultBytes} bytes`);
  await fsp.writeFile(path.join(outputDir, "results.zip"), buffer);
  return true;
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
    await logRemote(task.id, `Worker ${workerId} started`);
    const inputFiles = await saveInputFiles(task, inputDir);
    await logRemote(task.id, `Saved ${inputFiles.length} input file(s) locally`);

    if (directXliffTranslation && requiresXliffTranslation(task, inputFiles)) {
      const result = await runDirectXliffTranslation(task.id, task, inputFiles, taskDir, outputDir);
      transcript = "";
      let outputFiles = await listResultFiles(outputDir);
      if (!outputFiles.length) throw new Error("Direct XLIFF runner finished without creating files");
      const archived = await packageOutputArchive(outputDir);
      const files = await collectResultFiles(outputDir, { onlyArchive: archived });
      await completeTask(task.id, { status: "done", transcript, files });
      await logRemote(task.id, `Completed direct XLIFF translation with ${files.length} result file(s)`);
      return;
    }

    const imageCount = inputFiles.filter(isImageFile).length;
    if (imageCount) await logRemote(task.id, `Analyzing ${imageCount} image file(s) with LM Studio vision (${lmStudioVisionModel})`);
    const visionDescriptions = imageCount ? await describeImages(task, inputFiles) : [];
    if (imageCount) await logRemote(task.id, `Image vision analysis completed for ${imageCount} file(s)`);

    const prompt = buildPrompt(task, inputDir, outputDir, inputFiles, visionDescriptions);
    const runConfig = await prepareContinueRun(task, taskDir);
    runConfig.promptPath = path.join(taskDir, "continue-prompt.md");
    await fsp.writeFile(runConfig.promptPath, prompt, "utf8");
    const result = await runContinue(task.id, prompt, runConfig);
    transcript = result.transcript || "";
    if (result.code !== 0) throw new Error(`Continue exited with code ${result.code}`);

    let outputFiles = await listResultFiles(outputDir);
    if (!outputFiles.length) {
      const fallback = transcript.trim() ? transcript.trim() : "Continue finished without creating files.";
      await fsp.writeFile(path.join(outputDir, "result.md"), `${fallback}\n`, "utf8");
      outputFiles = await listResultFiles(outputDir);
    }
    const repairedOpenXml = await repairOpenXmlPackageOutputs(task, outputDir);
    if (repairedOpenXml.length) {
      await logRemote(task.id, `Repaired OpenXML package output(s): ${repairedOpenXml.join(", ")}`);
      outputFiles = await listResultFiles(outputDir);
    }
    const archived = await packageOutputArchive(outputDir, { excludeRawOpenXmlParts: repairedOpenXml.length > 0 });
    const files = await collectResultFiles(outputDir, { onlyArchive: archived });

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
  } finally {
    try {
      const unloaded = await unloadLoadedEmbeddingModels();
      if (unloaded) await logRemote(task.id, `Unloaded ${unloaded} embedding model instance(s)`);
    } catch (error) {
      console.warn(`[${task.id}] embedding unload skipped: ${error.message}`);
    }
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
console.log(`Remote access gate: ${accessFile}`);

let accessWasDisabled = false;
while (true) {
  try {
    const access = await remoteAccessStatus();
    if (!access.enabled) {
      if (!accessWasDisabled) {
        console.log(`Remote access disabled; worker will not claim external jobs (${access.reason})`);
        accessWasDisabled = true;
      }
      await sleep(pollIntervalMs);
      continue;
    }
    if (accessWasDisabled) {
      console.log(`Remote access enabled; worker is polling again (${access.reason})`);
      accessWasDisabled = false;
    }
    const hadTask = await pollOnce();
    if (!hadTask) await sleep(pollIntervalMs);
  } catch (error) {
    console.error(`poll failed: ${error.message}`);
    await sleep(pollIntervalMs);
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const codingConfigPath = path.join(__dirname, "continue-config.yaml");
const analysisConfigPath = path.join(__dirname, "continue-config-grok43.yaml");
const port = Number(process.env.PORT || 3000);
const otpEmail = process.env.OTP_EMAIL || "bigmax113@gmail.com";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex");
const workspace = path.resolve(process.env.RENDER_WORKSPACE || path.join(__dirname, ".render-workspace"));
const chatStoreFile = path.join(__dirname, "sessions", "chats.json");
const chatStoreRepo = process.env.CHAT_STORE_REPO || "bigmax113/Grodex";
const chatStoreBranch = process.env.CHAT_STORE_BRANCH || "main";
const chatStorePath = process.env.CHAT_STORE_PATH || "data/chats.json";
const chatHistoryMaxChars = Number(process.env.CHAT_HISTORY_MAX_CHARS || 180000);
const chatMessageMaxChars = Number(process.env.CHAT_MESSAGE_MAX_CHARS || 120000);
const driveProfilesFile = path.join(__dirname, "sessions", "drive-profiles.json");
const llmProfilesFile = path.join(__dirname, "sessions", "llm-profiles.json");
const remoteJobsDir = path.join(__dirname, "remote-jobs");
const defaultGoogleDriveFolderId = "1WGbLfKoL8bYEi6fIXI2ktBPZmwAe86Pj";
const remoteWorkerToken = process.env.REMOTE_WORKER_TOKEN || "";
const remoteFileLimitBytes = Number(process.env.REMOTE_FILE_LIMIT_BYTES || 100 * 1024 * 1024);
const remoteTotalLimitBytes = Number(process.env.REMOTE_TOTAL_LIMIT_BYTES || 250 * 1024 * 1024);
const remoteAllowPersonalLlm = String(process.env.REMOTE_ALLOW_PERSONAL_LLM || "false").toLowerCase() === "true";
const renderDirectAgentEnabled = String(process.env.ENABLE_RENDER_DIRECT_AGENT || "false").toLowerCase() === "true";
const remoteModelCatalog = [
  {
    id: "qwen",
    name: "LM Studio Qwen 3.6 35B A3B",
    provider: "lmstudio",
    model: "qwen/qwen3.6-35b-a3b",
    contextLength: 262144,
    maxTokens: 20000,
  },
  {
    id: "gemma-e2b",
    name: "LM Studio Gemma 4 E2B Q4",
    provider: "lmstudio",
    model: "google/gemma-4-e2b",
    contextLength: 131072,
    maxTokens: 8192,
  },
  {
    id: "gemma-e4b",
    name: "LM Studio Gemma 4 E4B Q4",
    provider: "lmstudio",
    model: "google/gemma-4-e4b",
    contextLength: 131072,
    maxTokens: 8192,
  },
  {
    id: "grok-build",
    name: "Grok Build 0.1",
    provider: "xai",
    model: "grok-build-0.1",
    contextLength: 131072,
    maxTokens: 8192,
  },
  {
    id: "grok-general",
    name: "Grok 4.3 long context",
    provider: "xai",
    model: "grok-4.3",
    contextLength: 1000000,
    maxTokens: 20000,
  },
];
const remoteActiveModelIds = new Set(
  String(process.env.REMOTE_ACTIVE_MODEL_IDS || "qwen,gemma-e2b,gemma-e4b")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const googleDriveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || defaultGoogleDriveFolderId;
const googleDriveAuthMode = String(process.env.GOOGLE_DRIVE_AUTH_MODE || "").trim().toLowerCase();
const googleServiceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const googleServiceAccountJsonB64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || "";
const googleDriveOAuthClientJson = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_JSON || "";
const googleDriveOAuthClientJsonB64 = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_JSON_B64 || "";
const googleDriveOAuthClientFile = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_FILE || "";
const googleDriveOAuthTokenJson = process.env.GOOGLE_DRIVE_OAUTH_TOKEN_JSON || "";
const googleDriveOAuthTokenJsonB64 = process.env.GOOGLE_DRIVE_OAUTH_TOKEN_JSON_B64 || "";
const googleDriveOAuthTokenFile = process.env.GOOGLE_DRIVE_OAUTH_TOKEN_FILE || "";
const googleDriveConnectEnabled = String(process.env.GOOGLE_DRIVE_CONNECT_ENABLED || "true").toLowerCase() === "true";
const googleDriveUsePersonalProfiles = String(process.env.GOOGLE_DRIVE_USE_PERSONAL_PROFILES || "true").toLowerCase() !== "false";
const ownerResourceFallbackEnabled = String(process.env.OWNER_RESOURCE_FALLBACK_ENABLED || "true").toLowerCase() !== "false";
const googleDriveOAuthRedirectUri = process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI || "";
const googleDriveProfileFolderName = process.env.GOOGLE_DRIVE_PROFILE_FOLDER_NAME || "Continue Render Agent";
const googleDriveProfileStateTtlMs = Number(process.env.GOOGLE_DRIVE_PROFILE_STATE_TTL_MS || 15 * 60 * 1000);
const codeTtlMs = Number(process.env.OTP_TTL_MS || 10 * 60 * 1000);
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const activeRuns = new Map();
const localAgentStreams = new Map();
const localAgentRunTasks = new Map();
const pendingCodes = new Map();
const sessions = new Map();
const requestBuckets = new Map();
let continueStatus = { ok: false, checkedAt: null, error: "not checked" };
let chatStoreCache = null;
let chatStoreSha = null;
let driveProfilesCache = null;
let llmProfilesCache = null;
let driveClient = null;
const driveClients = new Map();
const driveFolderCache = new Map();
const driveConnectStates = new Map();

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sse(res, event, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function hashCode(code, nonce) {
  return crypto.createHmac("sha256", sessionSecret).update(`${nonce}:${code}`).digest("base64url");
}

function secureCookie(req) {
  return req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production";
}

function sessionCookie(req, value, maxAgeSeconds) {
  const parts = [
    `continue_session=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secureCookie(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(req) {
  return sessionCookie(req, "", 0);
}

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function checkRateLimit(req, key, limit, windowMs) {
  const bucketKey = `${key}:${getClientIp(req)}`;
  const now = Date.now();
  const bucket = requestBuckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt < now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  requestBuckets.set(bucketKey, bucket);
  return bucket.count <= limit;
}

function timingEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function makeSession(email) {
  const id = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionTtlMs;
  sessions.set(id, { email, expiresAt });
  const payload = Buffer.from(JSON.stringify({
    id,
    email: normalizedEmail(email),
    expiresAt,
  }), "utf8").toString("base64url");
  const signedValue = `v2.${payload}`;
  return `${signedValue}.${sign(signedValue)}`;
}

function readSession(req) {
  const cookie = parseCookies(req).continue_session;
  if (!cookie) return null;
  const [version, payload, payloadMac] = cookie.split(".");
  if (version === "v2" && payload && payloadMac) {
    const signedValue = `v2.${payload}`;
    if (!timingEqual(payloadMac, sign(signedValue))) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!session.email || Number(session.expiresAt || 0) < Date.now()) return null;
      return {
        id: String(session.id || ""),
        email: normalizedEmail(session.email),
        expiresAt: Number(session.expiresAt),
      };
    } catch {
      return null;
    }
  }
  const [id, mac] = cookie.split(".");
  if (!id || !mac || !timingEqual(mac, sign(id))) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return { id, ...session };
}

function requireSession(req, res) {
  const session = readSession(req);
  if (session) return session;
  json(res, 401, { error: "Authentication required" });
  return null;
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function gmailOAuthMailerConfigured() {
  return authModeUsesOAuth() && hasGoogleOAuthCredentials();
}

function mailerMode() {
  if (smtpConfigured()) return "smtp";
  if (gmailOAuthMailerConfigured()) return "gmail-oauth";
  return "missing";
}

function transporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!smtpConfigured()) {
    throw new Error("SMTP is not configured");
  }
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user, pass },
  });
}

function rfc2822(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendGmailOAuthMail({ to, subject, text }) {
  if (!gmailOAuthMailerConfigured()) throw new Error("Gmail OAuth mailer is not configured");
  const { google } = await import("googleapis");
  const clientSource = parseGoogleOAuthClient();
  const client = clientSource.installed || clientSource.web || clientSource;
  const authClient = new google.auth.OAuth2(
    client.client_id,
    client.client_secret,
    googleDriveOAuthRedirectUri || (Array.isArray(client.redirect_uris) ? client.redirect_uris[0] : undefined),
  );
  authClient.setCredentials(parseGoogleOAuthToken());
  const gmail = google.gmail({ version: "v1", auth: authClient });
  const raw = [
    `To: ${rfc2822(to)}`,
    `From: ${rfc2822(process.env.SMTP_FROM || otpEmail)}`,
    `Subject: ${rfc2822(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n");
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(raw, "utf8").toString("base64url") },
  });
}

async function sendOtpMail(code) {
  const subject = "Continue Render Agent login code";
  const text = `Your Continue Render Agent login code is ${code}. It expires in 10 minutes.`;
  if (smtpConfigured()) {
    await transporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: otpEmail,
      subject,
      text,
    });
    return;
  }
  await sendGmailOAuthMail({ to: otpEmail, subject, text });
}

async function sendLoginCode(req, res) {
  if (!checkRateLimit(req, "otp-send", 5, 15 * 60 * 1000)) {
    json(res, 429, { error: "Too many code requests. Try again later." });
    return;
  }
  const body = await readBody(req);
  const requestedEmail = String(body.email || otpEmail).trim().toLowerCase();
  const allowedEmail = otpEmail.toLowerCase();
  if (requestedEmail !== allowedEmail) {
    json(res, 200, { ok: true, message: "If this email is allowed, a code was sent." });
    return;
  }

  const code = String(crypto.randomInt(0, 10000)).padStart(4, "0");
  const nonce = crypto.randomBytes(16).toString("base64url");
  pendingCodes.set(allowedEmail, {
    nonce,
    codeHash: hashCode(code, nonce),
    expiresAt: Date.now() + codeTtlMs,
    attempts: 0,
  });

  await sendOtpMail(code);

  json(res, 200, { ok: true, message: "Code sent." });
}

async function verifyLoginCode(req, res) {
  if (!checkRateLimit(req, "otp-verify", 10, 15 * 60 * 1000)) {
    json(res, 429, { error: "Too many attempts. Try again later." });
    return;
  }
  const body = await readBody(req);
  const email = otpEmail.toLowerCase();
  const code = String(body.code || "").replace(/\D/g, "");
  const pending = pendingCodes.get(email);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingCodes.delete(email);
    json(res, 400, { error: "Code expired. Request a new one." });
    return;
  }
  pending.attempts += 1;
  if (pending.attempts > 5) {
    pendingCodes.delete(email);
    json(res, 400, { error: "Too many wrong attempts. Request a new code." });
    return;
  }
  if (!/^\d{4}$/.test(code) || !timingEqual(hashCode(code, pending.nonce), pending.codeHash)) {
    json(res, 400, { error: "Wrong code." });
    return;
  }

  pendingCodes.delete(email);
  const session = makeSession(email);
  json(res, 200, { ok: true, email }, {
    "set-cookie": sessionCookie(req, session, Math.floor(sessionTtlMs / 1000)),
  });
}

async function logout(req, res) {
  const session = readSession(req);
  if (session) sessions.delete(session.id);
  json(res, 200, { ok: true }, { "set-cookie": clearSessionCookie(req) });
}

function cnExecutable() {
  const bin = process.platform === "win32" ? "cn.cmd" : "cn";
  return path.join(__dirname, "node_modules", ".bin", bin);
}

function chatStoreUsesGithub() {
  return Boolean(process.env.CHAT_STORE_GITHUB_TOKEN && chatStoreRepo);
}

function normalizeChatStore(value) {
  const sessionsList = Array.isArray(value?.sessions) ? value.sessions : [];
  return {
    version: 1,
    sessions: sessionsList.map((session) => ({
      id: String(session.id),
      title: String(session.title || "New chat"),
      ownerEmail: normalizedEmail(session.ownerEmail || ""),
      createdAt: session.createdAt || new Date().toISOString(),
      updatedAt: session.updatedAt || session.createdAt || new Date().toISOString(),
      messages: Array.isArray(session.messages) ? session.messages : [],
    })),
  };
}

function titleFromText(text) {
  const value = String(text || "New chat").replace(/\s+/g, " ").trim();
  return value.length > 64 ? `${value.slice(0, 64)}...` : value || "New chat";
}

async function loadChatStore({ force = false } = {}) {
  if (chatStoreCache && !force) return chatStoreCache;

  if (chatStoreUsesGithub()) {
    const url = `https://api.github.com/repos/${chatStoreRepo}/contents/${encodeURIComponent(chatStorePath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(chatStoreBranch)}`;
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${process.env.CHAT_STORE_GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.ok) {
      const data = await response.json();
      chatStoreSha = data.sha;
      const jsonText = Buffer.from(String(data.content || ""), "base64").toString("utf8");
      chatStoreCache = normalizeChatStore(JSON.parse(jsonText));
      return chatStoreCache;
    }
    if (response.status !== 404) {
      throw new Error(`GitHub chat store load failed: HTTP ${response.status}`);
    }
  }

  try {
    chatStoreCache = normalizeChatStore(JSON.parse(await fsp.readFile(chatStoreFile, "utf8")));
  } catch {
    chatStoreCache = normalizeChatStore({ sessions: [] });
  }
  return chatStoreCache;
}

async function saveChatStore(store) {
  chatStoreCache = normalizeChatStore(store);
  await fsp.mkdir(path.dirname(chatStoreFile), { recursive: true });
  await fsp.writeFile(chatStoreFile, `${JSON.stringify(chatStoreCache, null, 2)}\n`, "utf8");

  if (!chatStoreUsesGithub()) return;
  const url = `https://api.github.com/repos/${chatStoreRepo}/contents/${encodeURIComponent(chatStorePath).replace(/%2F/g, "/")}`;
  const payload = {
    message: "chore: sync remote agent chats",
    branch: chatStoreBranch,
    content: Buffer.from(`${JSON.stringify(chatStoreCache, null, 2)}\n`, "utf8").toString("base64"),
  };
  if (chatStoreSha) payload.sha = chatStoreSha;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${process.env.CHAT_STORE_GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || `GitHub chat store save failed: HTTP ${response.status}`);
  }
  chatStoreSha = data.content?.sha || chatStoreSha;
}

function chatVisibleTo(session, email) {
  const owner = normalizedEmail(session.ownerEmail || "");
  return !owner || owner === normalizedEmail(email);
}

function publicChatSummary(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.filter((message) => message.role !== "system").length,
  };
}

function sanitizeChatMessage(message) {
  const role = ["system", "user", "assistant"].includes(message?.role) ? message.role : "user";
  const content = String(message?.content || "").slice(0, chatMessageMaxChars);
  return {
    role,
    content,
    createdAt: message?.createdAt || new Date().toISOString(),
  };
}

function compactChatHistory(messages, maxChars = chatHistoryMaxChars) {
  const selected = [];
  let total = 0;
  const usable = (Array.isArray(messages) ? messages : [])
    .map(sanitizeChatMessage)
    .filter((message) => message.content.trim());
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const message = usable[index];
    const size = message.content.length + message.role.length + 16;
    if (selected.length && total + size > maxChars) break;
    selected.unshift(message);
    total += size;
  }
  return selected;
}

async function listChats(email) {
  const store = await loadChatStore({ force: chatStoreUsesGithub() });
  return [...store.sessions]
    .filter((session) => chatVisibleTo(session, email))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(publicChatSummary);
}

async function getChat(id, email = "") {
  const store = await loadChatStore();
  const session = store.sessions.find((item) => item.id === id) || null;
  if (!session || !chatVisibleTo(session, email)) return null;
  return session;
}

async function ensureChat(id, firstPrompt = "", ownerEmail = "") {
  const store = await loadChatStore();
  const existing = id ? store.sessions.find((session) => session.id === id) : null;
  if (existing) {
    if (!chatVisibleTo(existing, ownerEmail)) throw new Error("Chat not found");
    if (!existing.ownerEmail && ownerEmail) {
      existing.ownerEmail = normalizedEmail(ownerEmail);
      await saveChatStore(store);
    }
    return existing;
  }

  const now = new Date().toISOString();
  const session = {
    id: id || `chat-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
    title: titleFromText(firstPrompt),
    ownerEmail: normalizedEmail(ownerEmail),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  store.sessions.push(session);
  await saveChatStore(store);
  return session;
}

async function appendChatMessage(chatId, message) {
  const store = await loadChatStore();
  const session = store.sessions.find((item) => item.id === chatId);
  if (!session) return;
  session.messages.push(sanitizeChatMessage({ ...message, createdAt: new Date().toISOString() }));
  if (!session.title || session.title === "New chat") {
    const firstUser = session.messages.find((item) => item.role === "user");
    session.title = titleFromText(firstUser?.content);
  }
  session.updatedAt = new Date().toISOString();
  await saveChatStore(store);
}

async function deleteChat(id, email = "") {
  const store = await loadChatStore();
  store.sessions = store.sessions.filter((session) => session.id !== id || !chatVisibleTo(session, email));
  await saveChatStore(store);
}

function safeChatId(id) {
  const value = String(id || "");
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new Error("Invalid chat id");
  return value;
}

async function handleChatList(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  json(res, 200, { chats: await listChats(session.email) });
}

async function handleChatGet(req, res, id) {
  const session = requireSession(req, res);
  if (!session) return;
  const chat = await getChat(safeChatId(id), session.email);
  if (!chat) {
    json(res, 404, { error: "Chat not found" });
    return;
  }
  json(res, 200, {
    chat: {
      ...publicChatSummary(chat),
      messages: compactChatHistory(chat.messages, chatHistoryMaxChars),
    },
  });
}

async function handleChatCreate(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const body = await readBody(req);
  const chat = await ensureChat(body.id ? safeChatId(body.id) : "", body.title || "New chat", session.email);
  json(res, 201, { chat: { ...publicChatSummary(chat), messages: compactChatHistory(chat.messages) } });
}

async function handleChatDelete(req, res, id) {
  const session = requireSession(req, res);
  if (!session) return;
  await deleteChat(safeChatId(id), session.email);
  json(res, 200, { ok: true });
}

function safeRemoteId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(id)) {
    throw new Error("Invalid task id");
  }
  return id;
}

function remoteTaskId() {
  return `task-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function safeFileName(name) {
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
    .map((part) => safeFileName(part))
    .filter((part) => part && part !== "." && part !== "..");
  return parts.length ? parts.join("/") : "file";
}

function isArchiveName(name) {
  return /\.(zip|7z|rar|tar|tgz|tar\.gz|gz|bz2|xz)$/i.test(String(name || ""));
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

function packageDatasetIfNeeded(files) {
  if (files.length === 1 && isArchiveName(files[0].name)) return files;
  if (files.length <= 1 && !files.some((file) => String(file.relativePath || "").includes("/"))) return files;
  const buffer = zipFilesBuffer(files);
  if (buffer.length > remoteTotalLimitBytes) throw new Error("Packed dataset archive is too large");
  return [{
    name: "dataset.zip",
    relativePath: "dataset.zip",
    mime: "application/zip",
    buffer,
  }];
}

function publicRemoteModel(model) {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    model: model.model,
    contextLength: model.contextLength,
    maxTokens: model.maxTokens,
    active: remoteActiveModelIds.has(model.id),
  };
}

function remoteModelForRequest(value) {
  const id = String(value || "qwen").trim() || "qwen";
  const model = remoteModelCatalog.find((item) => item.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  if (!remoteActiveModelIds.has(model.id)) {
    throw new Error(`${model.name} is visible but disabled for the local-only test`);
  }
  return model;
}

function hasTranslationIntent(text) {
  return /\b(translate|translation|translated|locali[sz]e|locali[sz]ation)\b|перевод|перевести|переведи|локализ/i.test(String(text || ""));
}

function uploadLooksLikeDocument(input) {
  const name = String(input?.relativePath || input?.path || input?.name || "").toLowerCase();
  return /\.(docx?|pdf|pptx?|xlsx?|odt|ods|odp|rtf|html?|xml|xlf|xliff|zip|7z|rar|tar|tgz|gz|bz2|xz)$/.test(name);
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function encryptionKey() {
  return crypto.createHash("sha256").update(sessionSecret).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptSecret(value) {
  const [ivRaw, tagRaw, encryptedRaw] = String(value || "").split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid encrypted secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function loadDriveProfiles() {
  if (driveProfilesCache) return driveProfilesCache;
  try {
    const raw = JSON.parse(await fsp.readFile(driveProfilesFile, "utf8"));
    driveProfilesCache = {
      version: 1,
      profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    };
  } catch {
    driveProfilesCache = { version: 1, profiles: [] };
  }
  return driveProfilesCache;
}

async function saveDriveProfiles(store) {
  driveProfilesCache = {
    version: 1,
    profiles: Array.isArray(store.profiles) ? store.profiles : [],
  };
  await fsp.mkdir(path.dirname(driveProfilesFile), { recursive: true });
  await fsp.writeFile(driveProfilesFile, `${JSON.stringify(driveProfilesCache, null, 2)}\n`, "utf8");
}

async function getDriveProfile(email) {
  const target = normalizedEmail(email);
  if (!target) return null;
  const store = await loadDriveProfiles();
  return store.profiles.find((profile) => normalizedEmail(profile.email) === target) || null;
}

async function upsertDriveProfile(profile) {
  const store = await loadDriveProfiles();
  const target = normalizedEmail(profile.email);
  const existing = store.profiles.find((item) => normalizedEmail(item.email) === target) || {};
  store.profiles = store.profiles.filter((item) => normalizedEmail(item.email) !== target);
  store.profiles.push({ ...existing, ...profile, email: target, updatedAt: new Date().toISOString() });
  await saveDriveProfiles(store);
}

async function activeBlobDriveProfile(email) {
  if (!googleDriveUsePersonalProfiles) return null;
  const profile = await getDriveProfile(email);
  if (!profile?.folderId || !profile?.tokenCipher) return null;
  return profile;
}

function publicDriveProfile(profile) {
  if (!profile) {
    if (!ownerResourceFallbackEnabled) {
      return {
        mode: "personal_required",
        connected: false,
        defaultAvailable: false,
      };
    }
    return {
      mode: "default",
      connected: false,
      defaultAvailable: true,
      folderId: googleDriveFolderId,
      folderName: "Default test Drive",
    };
  }
  const connected = Boolean(profile.folderId && profile.tokenCipher);
  if (!connected && (profile.defaultDriveDisabledAt || !ownerResourceFallbackEnabled)) {
    return {
      mode: "personal_required",
      connected: false,
      defaultAvailable: false,
      defaultDisabledAt: profile.defaultDriveDisabledAt,
    };
  }
  return {
    mode: connected ? "personal" : "default",
    connected,
    defaultAvailable: ownerResourceFallbackEnabled && !profile.defaultDriveDisabledAt,
    email: profile.email,
    folderId: connected ? profile.folderId : googleDriveFolderId,
    folderName: profile.folderName || googleDriveProfileFolderName,
    folderUrl: profile.folderUrl || null,
    defaultDisabledAt: profile.defaultDriveDisabledAt || null,
    connectedAt: profile.connectedAt || null,
    updatedAt: profile.updatedAt || null,
  };
}

async function loadLlmProfiles() {
  if (llmProfilesCache) return llmProfilesCache;
  try {
    const raw = JSON.parse(await fsp.readFile(llmProfilesFile, "utf8"));
    llmProfilesCache = {
      version: 1,
      profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    };
  } catch {
    llmProfilesCache = { version: 1, profiles: [] };
  }
  return llmProfilesCache;
}

async function saveLlmProfiles(store) {
  llmProfilesCache = {
    version: 1,
    profiles: Array.isArray(store.profiles) ? store.profiles : [],
  };
  await fsp.mkdir(path.dirname(llmProfilesFile), { recursive: true });
  await fsp.writeFile(llmProfilesFile, `${JSON.stringify(llmProfilesCache, null, 2)}\n`, "utf8");
}

async function getLlmProfile(email) {
  const target = normalizedEmail(email);
  if (!target) return null;
  const store = await loadLlmProfiles();
  return store.profiles.find((profile) => normalizedEmail(profile.email) === target) || null;
}

function normalizeLlmProfileInput(email, body) {
  const provider = String(body.provider || "openai").trim().toLowerCase();
  const model = String(body.model || "").trim();
  const apiBase = String(body.apiBase || "").trim();
  const apiKey = String(body.apiKey || "").trim();
  const name = String(body.name || model || "Personal LLM").trim().slice(0, 80);
  if (!model) throw new Error("model is required");
  if (!apiBase) throw new Error("apiBase is required");
  const keylessProvider = ["lmstudio", "ollama"].includes(provider) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(apiBase);
  if (!keylessProvider && apiKey.length < 8 && !body.keepExistingKey) throw new Error("apiKey is required");
  const temperature = Number(body.temperature ?? 0.2);
  const contextLength = Number(body.contextLength || 131072);
  const maxTokens = Number(body.maxTokens || 8192);
  return {
    email: normalizedEmail(email),
    enabled: body.enabled !== false,
    name,
    provider,
    model,
    apiBase,
    apiKey,
    keepExistingKey: Boolean(body.keepExistingKey),
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
    contextLength: Number.isFinite(contextLength) ? contextLength : 131072,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 8192,
  };
}

function publicLlmProfile(profile) {
  if (!profile) return { mode: "default", connected: false };
  return {
    mode: "personal",
    connected: true,
    enabled: profile.enabled !== false,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    apiBase: profile.apiBase,
    contextLength: profile.contextLength,
    maxTokens: profile.maxTokens,
    temperature: profile.temperature,
    updatedAt: profile.updatedAt || null,
  };
}

function workerLlmProfile(profile) {
  if (!profile || profile.enabled === false) return null;
  return {
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    apiBase: profile.apiBase,
    apiKey: profile.apiKeyCipher ? decryptSecret(profile.apiKeyCipher) : "",
    contextLength: profile.contextLength,
    maxTokens: profile.maxTokens,
    temperature: profile.temperature,
  };
}

async function upsertLlmProfile(email, body) {
  const input = normalizeLlmProfileInput(email, body);
  const existing = await getLlmProfile(email);
  const apiKeyCipher = input.keepExistingKey && existing?.apiKeyCipher
    ? existing.apiKeyCipher
    : input.apiKey
      ? encryptSecret(input.apiKey)
      : "";
  const profile = {
    email: input.email,
    enabled: input.enabled,
    name: input.name,
    provider: input.provider,
    model: input.model,
    apiBase: input.apiBase,
    apiKeyCipher,
    temperature: input.temperature,
    contextLength: input.contextLength,
    maxTokens: input.maxTokens,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const store = await loadLlmProfiles();
  store.profiles = store.profiles.filter((item) => normalizedEmail(item.email) !== input.email);
  store.profiles.push(profile);
  await saveLlmProfiles(store);
  return profile;
}

async function deleteLlmProfile(email) {
  const target = normalizedEmail(email);
  const store = await loadLlmProfiles();
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((item) => normalizedEmail(item.email) !== target);
  await saveLlmProfiles(store);
  return before !== store.profiles.length;
}

async function handleLlmProfileGet(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const profile = await getLlmProfile(session.email);
  json(res, 200, { email: session.email, active: publicLlmProfile(profile) });
}

async function handleLlmProfilePut(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const body = await readBody(req);
  const profile = await upsertLlmProfile(session.email, body);
  json(res, 200, { ok: true, active: publicLlmProfile(profile) });
}

async function handleLlmProfileDelete(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const deleted = await deleteLlmProfile(session.email);
  json(res, 200, { ok: true, deleted });
}

function useDriveStorage() {
  if (!googleDriveFolderId) return false;
  if (authModeUsesOAuth()) return hasGoogleOAuthCredentials();
  return hasGoogleServiceAccountCredentials();
}

function authModeUsesOAuth() {
  if (googleDriveAuthMode) return googleDriveAuthMode === "oauth";
  return hasGoogleOAuthCredentials() && !hasGoogleServiceAccountCredentials();
}

function hasGoogleServiceAccountCredentials() {
  return Boolean(googleServiceAccountJson || googleServiceAccountJsonB64);
}

function hasGoogleOAuthCredentials() {
  return Boolean(
    (googleDriveOAuthClientJson || googleDriveOAuthClientJsonB64 || googleDriveOAuthClientFile) &&
    (googleDriveOAuthTokenJson || googleDriveOAuthTokenJsonB64 || googleDriveOAuthTokenFile)
  );
}

function readCredentialFile(filePath) {
  if (!filePath) return "";
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
  if (!fs.existsSync(resolved)) return "";
  return fs.readFileSync(resolved, "utf8");
}

function parseJsonCredential({ jsonText = "", jsonB64 = "", filePath = "" }) {
  const raw = (jsonText || (jsonB64 ? Buffer.from(jsonB64, "base64").toString("utf8") : "") || readCredentialFile(filePath))
    .replace(/^\uFEFF/, "");
  if (!raw) throw new Error("Google Drive credentials are not configured");
  return JSON.parse(raw);
}

function parseGoogleCredentials() {
  const raw = googleServiceAccountJson || Buffer.from(googleServiceAccountJsonB64, "base64").toString("utf8");
  return JSON.parse(raw);
}

function parseGoogleOAuthClient() {
  return parseJsonCredential({
    jsonText: googleDriveOAuthClientJson,
    jsonB64: googleDriveOAuthClientJsonB64,
    filePath: googleDriveOAuthClientFile,
  });
}

function parseGoogleOAuthToken() {
  return normalizeGoogleOAuthToken(parseJsonCredential({
    jsonText: googleDriveOAuthTokenJson,
    jsonB64: googleDriveOAuthTokenJsonB64,
    filePath: googleDriveOAuthTokenFile,
  }));
}

function normalizeGoogleOAuthToken(token) {
  const normalized = { ...token };
  if (!normalized.access_token && normalized.token) normalized.access_token = normalized.token;
  if (!normalized.expiry_date && normalized.expiry) {
    const expiryDate = Date.parse(normalized.expiry);
    if (Number.isFinite(expiryDate)) normalized.expiry_date = expiryDate;
  }
  if (!normalized.scope && Array.isArray(normalized.scopes)) normalized.scope = normalized.scopes.join(" ");
  return normalized;
}

function isDriveAuthError(error) {
  const status = error?.code || error?.status || error?.response?.status;
  const data = error?.response?.data;
  const text = [
    error?.message,
    typeof data === "string" ? data : "",
    data?.error,
    data?.error_description,
  ].filter(Boolean).join(" ");
  return status === 401 || /invalid_grant|invalid_credentials|unauthorized_client/i.test(text);
}

function fsStorage(ownerEmail = "", folderName = "Local Render filesystem") {
  return {
    kind: "fs",
    mode: "local",
    rootId: "",
    profile: null,
    ownerEmail: normalizedEmail(ownerEmail),
    folderName,
  };
}

function warnStorageSkip(storage, error) {
  const message = error?.message || String(error);
  console.warn(`Skipping ${storage.mode || storage.kind} storage: ${message}`);
}

async function googleDrive(profile = null) {
  const { google } = await import("googleapis");
  if (profile?.tokenCipher) {
    const key = `profile:${normalizedEmail(profile.email)}:${profile.updatedAt || ""}`;
    if (driveClients.has(key)) return driveClients.get(key);
    const clientSource = parseGoogleOAuthClient();
    const client = clientSource.installed || clientSource.web || clientSource;
    const authClient = new google.auth.OAuth2(
      client.client_id,
      client.client_secret,
      Array.isArray(client.redirect_uris) ? client.redirect_uris[0] : undefined,
    );
    authClient.setCredentials(normalizeGoogleOAuthToken(JSON.parse(decryptSecret(profile.tokenCipher))));
    const drive = google.drive({ version: "v3", auth: authClient });
    driveClients.set(key, drive);
    return drive;
  }
  if (driveClient) return driveClient;
  let auth;
  if (authModeUsesOAuth()) {
    const clientSource = parseGoogleOAuthClient();
    const client = clientSource.installed || clientSource.web || clientSource;
    const authClient = new google.auth.OAuth2(
      client.client_id,
      client.client_secret,
      Array.isArray(client.redirect_uris) ? client.redirect_uris[0] : undefined,
    );
    authClient.setCredentials(parseGoogleOAuthToken());
    auth = authClient;
  } else {
    auth = new google.auth.GoogleAuth({
      credentials: parseGoogleCredentials(),
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
  }
  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

function driveLiteral(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveFindChild(parentId, name, mimeType = "", profile = null) {
  const drive = await googleDrive(profile);
  const parts = [
    `'${driveLiteral(parentId)}' in parents`,
    `name = '${driveLiteral(name)}'`,
    "trashed = false",
  ];
  if (mimeType) parts.push(`mimeType = '${driveLiteral(mimeType)}'`);
  const response = await drive.files.list({
    q: parts.join(" and "),
    fields: "files(id,name,mimeType,size,modifiedTime)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return response.data.files?.[0] || null;
}

async function driveEnsureFolder(parentId, name, profile = null) {
  const key = `${profile?.email || "default"}:${parentId}:${name}`;
  if (driveFolderCache.has(key)) return driveFolderCache.get(key);
  const existing = await driveFindChild(parentId, name, "application/vnd.google-apps.folder", profile);
  if (existing?.id) {
    driveFolderCache.set(key, existing.id);
    return existing.id;
  }
  const drive = await googleDrive(profile);
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  driveFolderCache.set(key, response.data.id);
  return response.data.id;
}

async function driveUploadBuffer(parentId, name, mime, buffer, profile = null) {
  const drive = await googleDrive(profile);
  const response = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: {
      mimeType: mime || "application/octet-stream",
      body: Readable.from(buffer),
    },
    fields: "id,size,modifiedTime",
    supportsAllDrives: true,
  });
  return response.data.id;
}

async function driveUpdateBuffer(fileId, mime, buffer, profile = null) {
  const drive = await googleDrive(profile);
  await drive.files.update({
    fileId,
    media: {
      mimeType: mime || "application/octet-stream",
      body: Readable.from(buffer),
    },
    supportsAllDrives: true,
  });
}

async function driveDownloadBuffer(fileId, profile = null) {
  const drive = await googleDrive(profile);
  const response = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(response.data);
}

function driveRedirectUri(req) {
  if (googleDriveOAuthRedirectUri) return googleDriveOAuthRedirectUri;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${req.headers.host}/api/drive/callback`;
}

function parseDriveFolderId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const fromPath = parsed.pathname.match(/\/folders\/([^/?#]+)/i)?.[1];
    if (fromPath) return decodeURIComponent(fromPath);
    const fromQuery = parsed.searchParams.get("id");
    if (fromQuery) return fromQuery.trim();
  } catch {
    // Raw folder IDs are accepted below.
  }
  return raw.match(/^[-\w]{10,}$/) ? raw : "";
}

function assertDriveConnectReady() {
  if (!googleDriveConnectEnabled) throw new Error("Personal Google Drive connect is disabled");
  if (!hasGoogleOAuthClientCredentials()) throw new Error("Google Drive OAuth client is not configured");
}

function hasGoogleOAuthClientCredentials() {
  return Boolean(googleDriveOAuthClientJson || googleDriveOAuthClientJsonB64 || googleDriveOAuthClientFile);
}

async function handleDriveProfile(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const profile = await getDriveProfile(session.email);
  json(res, 200, {
    email: session.email,
    connectEnabled: googleDriveConnectEnabled && hasGoogleOAuthClientCredentials(),
    usePersonalProfiles: googleDriveUsePersonalProfiles,
    ownerResourceFallbackEnabled,
    defaultFolderId: googleDriveFolderId,
    active: publicDriveProfile(profile),
  });
}

async function handleDriveConnectStart(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    assertDriveConnectReady();
  } catch (error) {
    json(res, 400, { error: error.message });
    return;
  }
  const body = await readBody(req);
  const folderInput = String(body.folderId || body.folderUrl || body.folder || "").trim();
  const folderId = parseDriveFolderId(folderInput);
  if (!folderId) {
    json(res, 400, { error: "Google Drive folder URL or ID is required" });
    return;
  }
  const { google } = await import("googleapis");
  const clientSource = parseGoogleOAuthClient();
  const client = clientSource.installed || clientSource.web || clientSource;
  const redirectUri = driveRedirectUri(req);
  const authClient = new google.auth.OAuth2(client.client_id, client.client_secret, redirectUri);
  const state = crypto.randomBytes(24).toString("base64url");
  driveConnectStates.set(state, {
    email: normalizedEmail(session.email),
    redirectUri,
    folderId,
    folderInput,
    expiresAt: Date.now() + googleDriveProfileStateTtlMs,
  });
  const authUrl = authClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"],
    state,
  });
  json(res, 200, { authUrl, redirectUri });
}

async function handleDriveCallback(req, res, url) {
  const state = String(url.searchParams.get("state") || "");
  const code = String(url.searchParams.get("code") || "");
  const error = String(url.searchParams.get("error") || "");
  if (error) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Google OAuth error: ${error}`);
    return;
  }
  const pending = driveConnectStates.get(state);
  if (!pending || pending.expiresAt < Date.now()) {
    driveConnectStates.delete(state);
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Google OAuth state expired. Start Drive connection again.");
    return;
  }
  if (!code) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Missing Google OAuth code.");
    return;
  }

  const { google } = await import("googleapis");
  const clientSource = parseGoogleOAuthClient();
  const client = clientSource.installed || clientSource.web || clientSource;
  const authClient = new google.auth.OAuth2(client.client_id, client.client_secret, pending.redirectUri);
  const tokenResponse = await authClient.getToken(code);
  const tokens = tokenResponse.tokens || {};
  authClient.setCredentials(tokens);
  const drive = google.drive({ version: "v3", auth: authClient });
  let folder;
  try {
    const folderResponse = await drive.files.get({
      fileId: pending.folderId,
      fields: "id,name,mimeType,webViewLink",
      supportsAllDrives: true,
    });
    folder = folderResponse.data;
    if (folder.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("Selected Google Drive item is not a folder");
    }
  } catch (error) {
    driveConnectStates.delete(state);
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Cannot use selected Google Drive folder: ${error.message}`);
    return;
  }

  await upsertDriveProfile({
    email: pending.email,
    authMode: "oauth",
    folderId: folder.id,
    folderName: folder.name || googleDriveProfileFolderName,
    folderUrl: folder.webViewLink || null,
    folderInput: pending.folderInput,
    tokenCipher: encryptSecret(JSON.stringify(tokens)),
    defaultDriveDisabledAt: new Date().toISOString(),
    connectedAt: new Date().toISOString(),
  });
  driveConnectStates.delete(state);

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Drive connected</title><body style="font-family:Segoe UI,Arial,sans-serif;padding:24px"><h1>Google Drive connected</h1><p>Storage for ${pending.email} is ready. You can close this tab and refresh the Render UI.</p></body>`);
}

function remoteTaskDir(id) {
  return path.join(remoteJobsDir, safeRemoteId(id));
}

function remoteTaskFile(id) {
  return path.join(remoteTaskDir(id), "task.json");
}

function connectedDriveProfiles() {
  const store = driveProfilesCache || { profiles: [] };
  return store.profiles.filter((profile) => profile?.folderId && profile?.tokenCipher);
}

async function ownerStorage(email) {
  const profile = await getDriveProfile(email);
  if (profile?.folderId && profile?.tokenCipher) {
    return {
      kind: "drive",
      mode: "personal",
      rootId: profile.folderId,
      profile,
      ownerEmail: normalizedEmail(email),
      folderName: profile.folderName || googleDriveProfileFolderName,
    };
  }
  if (profile?.defaultDriveDisabledAt) {
    throw new Error("Personal Google Drive must be connected before creating new jobs");
  }
  if (!ownerResourceFallbackEnabled) {
    throw new Error("Personal Google Drive must be connected in release mode");
  }
  if (useDriveStorage()) {
    return {
      kind: "drive",
      mode: "default",
      rootId: googleDriveFolderId,
      profile: null,
      ownerEmail: normalizedEmail(email),
      folderName: "Default test Drive",
    };
  }
  return fsStorage(email);
}

async function writableOwnerStorage(email) {
  const storage = await ownerStorage(email);
  if (storage.kind !== "drive" || storage.mode === "personal") return storage;
  try {
    await driveFindChild(storage.rootId, "__continue_render_agent_probe__", "", storage.profile);
    return storage;
  } catch (error) {
    if (!isDriveAuthError(error)) throw error;
    warnStorageSkip(storage, error);
    return fsStorage(email, "Local Render filesystem (default Drive needs reconnect)");
  }
}

async function taskStorage(task) {
  const ownerEmail = task.storage?.ownerEmail || task.ownerEmail || "";
  if (task.storage?.mode === "local") return fsStorage(ownerEmail);
  if (task.storage?.mode === "personal") {
    const profile = await getDriveProfile(ownerEmail);
    if (!profile?.folderId || !profile?.tokenCipher) throw new Error(`Drive profile not found for ${ownerEmail}`);
    return {
      kind: "drive",
      mode: "personal",
      rootId: profile.folderId,
      profile,
      ownerEmail: normalizedEmail(ownerEmail),
    };
  }
  if (useDriveStorage()) {
    return {
      kind: "drive",
      mode: "default",
      rootId: googleDriveFolderId,
      profile: null,
      ownerEmail: normalizedEmail(ownerEmail),
    };
  }
  return fsStorage(ownerEmail);
}

async function storageCandidates({ email = "", includeAll = false } = {}) {
  await loadDriveProfiles();
  if (includeAll) {
    const candidates = [];
    if (useDriveStorage()) {
      candidates.push({ kind: "drive", mode: "default", rootId: googleDriveFolderId, profile: null, ownerEmail: "" });
    }
    candidates.push(fsStorage(""));
    for (const profile of connectedDriveProfiles()) {
      candidates.push({
        kind: "drive",
        mode: "personal",
        rootId: profile.folderId,
        profile,
        ownerEmail: normalizedEmail(profile.email),
      });
    }
    return candidates;
  }

  const target = normalizedEmail(email);
  const profile = await getDriveProfile(target);
  if (profile?.folderId && profile?.tokenCipher) {
    return [{ kind: "drive", mode: "personal", rootId: profile.folderId, profile, ownerEmail: target }];
  }
  if (!ownerResourceFallbackEnabled) return [];
  if (profile?.defaultDriveDisabledAt) return [];
  if (useDriveStorage()) {
    return [
      { kind: "drive", mode: "default", rootId: googleDriveFolderId, profile: null, ownerEmail: target },
      fsStorage(target),
    ];
  }
  return [fsStorage(target)];
}

async function readRemoteTaskFromStorage(id, storage) {
  if (storage.kind === "drive") {
    const taskFolder = await driveFindChild(storage.rootId, safeRemoteId(id), "application/vnd.google-apps.folder", storage.profile);
    if (!taskFolder?.id) throw new Error("Task not found");
    const taskFile = await driveFindChild(taskFolder.id, "task.json", "", storage.profile);
    if (!taskFile?.id) throw new Error("Task not found");
    return JSON.parse((await driveDownloadBuffer(taskFile.id, storage.profile)).toString("utf8"));
  }
  return JSON.parse(await fsp.readFile(remoteTaskFile(id), "utf8"));
}

async function readRemoteTask(id, options = {}) {
  for (const storage of await storageCandidates(options)) {
    try {
      const task = await readRemoteTaskFromStorage(id, storage);
      if (options.email && normalizedEmail(task.storage?.ownerEmail || task.ownerEmail) !== normalizedEmail(options.email)) {
        continue;
      }
      return task;
    } catch {
      // Try the next storage root.
    }
  }
  throw new Error("Task not found");
}

async function writeRemoteTask(task) {
  task.updatedAt = new Date().toISOString();
  const storage = await taskStorage(task);
  if (storage.kind === "drive") {
    const taskFolderId = await driveEnsureFolder(storage.rootId, task.id, storage.profile);
    const buffer = Buffer.from(`${JSON.stringify(task, null, 2)}\n`, "utf8");
    const existing = await driveFindChild(taskFolderId, "task.json", "", storage.profile);
    if (existing?.id) await driveUpdateBuffer(existing.id, "application/json", buffer, storage.profile);
    else await driveUploadBuffer(taskFolderId, "task.json", "application/json", buffer, storage.profile);
    return;
  }
  await fsp.mkdir(remoteTaskDir(task.id), { recursive: true });
  await fsp.writeFile(remoteTaskFile(task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
}

async function saveRemoteBlobInStorage(taskId, folderName, storageName, mime, buffer, storage) {
  if (storage.kind === "drive") {
    const taskFolderId = await driveEnsureFolder(storage.rootId, safeRemoteId(taskId), storage.profile);
    const folderId = await driveEnsureFolder(taskFolderId, folderName, storage.profile);
    const driveFileId = await driveUploadBuffer(folderId, storageName, mime, buffer, storage.profile);
    return storage.mode === "personal"
      ? { driveFileId, driveProfileEmail: storage.ownerEmail }
      : { driveFileId };
  }
  const targetDir = path.join(remoteTaskDir(taskId), folderName);
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(path.join(targetDir, storageName), buffer);
  return { path: `${folderName}/${storageName}` };
}

async function saveRemoteBlob(taskId, folderName, storageName, mime, buffer, ownerEmail = "") {
  return saveRemoteBlobInStorage(taskId, folderName, storageName, mime, buffer, await ownerStorage(ownerEmail));
}

async function saveRemoteBlobForTask(task, folderName, storageName, mime, buffer) {
  return saveRemoteBlobInStorage(task.id, folderName, storageName, mime, buffer, await taskStorage(task));
}

async function readRemoteBlob(taskId, file) {
  if (file.driveProfileEmail) {
    const profile = await getDriveProfile(file.driveProfileEmail);
    if (!profile) throw new Error(`Drive profile not found for ${file.driveProfileEmail}`);
    return driveDownloadBuffer(file.driveFileId, profile);
  }
  if (file.driveFileId) return driveDownloadBuffer(file.driveFileId);
  return fsp.readFile(path.join(remoteTaskDir(taskId), file.path));
}

function publicRemoteTask(task) {
  return {
    id: task.id,
    status: task.status,
    prompt: task.prompt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    claimedAt: task.claimedAt || null,
    completedAt: task.completedAt || null,
    error: task.error || null,
    workerId: task.workerId || null,
    storage: task.storage || { mode: "default", ownerEmail: task.ownerEmail || null },
    model: task.model ? publicRemoteModel(task.model) : publicRemoteModel(remoteModelCatalog[0]),
    pipeline: task.pipeline || { xliffTranslationRequired: false },
    logs: Array.isArray(task.logs) ? task.logs.slice(-80) : [],
    files: (task.files || []).map((file) => ({
      id: file.id,
      name: file.name,
      relativePath: file.relativePath || file.name,
      mime: file.mime,
      size: file.size,
    })),
    resultFiles: (task.resultFiles || []).map((file) => ({
      id: file.id,
      name: file.name,
      relativePath: file.relativePath || file.name,
      mime: file.mime,
      size: file.size,
      downloadUrl: `/api/remote/tasks/${encodeURIComponent(task.id)}/download?file=${encodeURIComponent(file.id)}`,
    })),
  };
}

async function listRemoteTasksFromStorage(storage) {
  if (storage.kind === "drive") {
    const drive = await googleDrive(storage.profile);
    const response = await drive.files.list({
      q: `'${driveLiteral(storage.rootId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id,name,modifiedTime)",
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const tasks = [];
    for (const folder of response.data.files || []) {
      try {
        const taskFile = await driveFindChild(folder.id, "task.json", "", storage.profile);
        if (!taskFile?.id) continue;
        tasks.push(JSON.parse((await driveDownloadBuffer(taskFile.id, storage.profile)).toString("utf8")));
      } catch {
        // Ignore incomplete task folders.
      }
    }
    return tasks;
  }

  await fsp.mkdir(remoteJobsDir, { recursive: true });
  const entries = await fsp.readdir(remoteJobsDir, { withFileTypes: true });
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      tasks.push(await readRemoteTaskFromStorage(entry.name, storage));
    } catch {
      // Ignore incomplete task folders.
    }
  }
  return tasks;
}

async function listRemoteTasks(options = {}) {
  const tasksById = new Map();
  for (const storage of await storageCandidates(options)) {
    try {
      for (const task of await listRemoteTasksFromStorage(storage)) {
        if (options.email && normalizedEmail(task.storage?.ownerEmail || task.ownerEmail) !== normalizedEmail(options.email)) {
          continue;
        }
        tasksById.set(task.id, task);
      }
    } catch (error) {
      if (!isDriveAuthError(error)) throw error;
      warnStorageSkip(storage, error);
    }
  }
  return [...tasksById.values()].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function requireWorker(req, res) {
  if (!remoteWorkerToken) {
    json(res, 503, { error: "REMOTE_WORKER_TOKEN is not configured" });
    return false;
  }
  const header = String(req.headers.authorization || "");
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || !timingEqual(token, remoteWorkerToken)) {
    json(res, 401, { error: "Worker authentication required" });
    return false;
  }
  return true;
}

function decodeUploadFile(input, runningTotal) {
  const name = safeFileName(input?.name);
  const relativePath = safeRelativePath(input?.relativePath || input?.path || input?.name || name);
  const mime = String(input?.mime || "application/octet-stream").slice(0, 120);
  const base64 = String(input?.base64 || "");
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw new Error(`File is empty: ${name}`);
  if (buffer.length > remoteFileLimitBytes) throw new Error(`File is too large: ${name}`);
  if (runningTotal + buffer.length > remoteTotalLimitBytes) throw new Error("Task upload is too large");
  return { name, relativePath, mime, buffer };
}

async function createRemoteTaskRecord(session, body) {
  const prompt = String(body.prompt || "").trim();
  const uploads = Array.isArray(body.files) ? body.files : [];
  const selectedModel = remoteModelForRequest(body.model || body.provider || "qwen");
  if (!prompt && !uploads.length) {
    throw new Error("Prompt or at least one file is required");
  }
  const xliffTranslationRequired = hasTranslationIntent(prompt)
    && (!uploads.length || uploads.some(uploadLooksLikeDocument));
  const id = remoteTaskId();
  const selectedStorage = await writableOwnerStorage(session.email);
  const llmProfile = remoteAllowPersonalLlm ? await getLlmProfile(session.email) : null;
  const storage = selectedStorage.mode === "personal"
    ? {
      mode: "personal",
      ownerEmail: normalizedEmail(session.email),
      folderId: selectedStorage.rootId,
      folderName: selectedStorage.folderName,
    }
    : selectedStorage.mode === "local"
      ? {
        mode: "local",
        ownerEmail: normalizedEmail(session.email),
        folderId: null,
        folderName: selectedStorage.folderName,
      }
      : {
      mode: selectedStorage.mode,
      ownerEmail: normalizedEmail(session.email),
      folderId: selectedStorage.rootId || null,
      folderName: selectedStorage.folderName,
    };

  let totalBytes = 0;
  const decodedUploads = [];
  let preparedUploads;
  try {
    for (const upload of uploads) {
      const decoded = decodeUploadFile(upload, totalBytes);
      totalBytes += decoded.buffer.length;
      decodedUploads.push(decoded);
    }
    preparedUploads = packageDatasetIfNeeded(decodedUploads);
  } catch (error) {
    throw new Error(error.message);
  }
  const files = [];
  totalBytes = 0;
  for (const [index, decoded] of preparedUploads.entries()) {
    totalBytes += decoded.buffer.length;
    if (totalBytes > remoteTotalLimitBytes) throw new Error("Task upload is too large");
    const fileId = `in-${index + 1}-${crypto.randomBytes(4).toString("hex")}`;
    const storageName = `${fileId}-${decoded.name}`;
    const stored = await saveRemoteBlob(id, "inputs", storageName, decoded.mime, decoded.buffer, session.email);
    files.push({
      id: fileId,
      name: decoded.name,
      relativePath: decoded.relativePath,
      mime: decoded.mime,
      size: decoded.buffer.length,
      ...stored,
    });
  }

  const now = new Date().toISOString();
  const task = {
    id,
    status: "queued",
    prompt,
    ownerEmail: session.email,
    storage,
    model: selectedModel,
    llmProfile: publicLlmProfile(llmProfile),
    chatId: body.chatId ? safeChatId(body.chatId) : null,
    chatHistory: compactChatHistory(body.chatHistory || [], chatHistoryMaxChars),
    pipeline: {
      xliffTranslationRequired,
    },
    files,
    resultFiles: [],
    logs: [{
      at: now,
      message: `Task created for ${selectedModel.name} using ${storage.mode === "personal" ? "personal Google Drive" : useDriveStorage() ? "default Google Drive" : "local Render filesystem"} storage${xliffTranslationRequired ? " with XLIFF translation pipeline required" : ""}`,
    }],
    createdAt: now,
    updatedAt: now,
  };
  await writeRemoteTask(task);
  return task;
}

async function handleRemoteTaskCreate(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const body = await readBody(req);
  let task;
  try {
    task = await createRemoteTaskRecord(session, body);
  } catch (error) {
    json(res, 400, { error: error.message });
    return;
  }
  json(res, 201, { task: publicRemoteTask(task) });
}

async function handleRemoteTaskList(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const tasks = await listRemoteTasks({ email: session.email });
  json(res, 200, { tasks: tasks.map(publicRemoteTask) });
}

async function handleRemoteTaskGet(req, res, id) {
  const session = requireSession(req, res);
  if (!session) return;
  const task = await readRemoteTask(id, { email: session.email });
  json(res, 200, { task: publicRemoteTask(task) });
}

async function handleRemoteTaskDownload(req, res, id, url) {
  const session = requireSession(req, res);
  if (!session) return;
  const task = await readRemoteTask(id, { email: session.email });
  const fileId = String(url.searchParams.get("file") || "");
  const file = (task.resultFiles || []).find((item) => item.id === fileId);
  if (!file) {
    json(res, 404, { error: "Result file not found" });
    return;
  }
  const body = await readRemoteBlob(id, file);
  res.writeHead(200, {
    "content-type": file.mime || "application/octet-stream",
    "content-length": body.length,
    "content-disposition": `attachment; filename="${safeFileName(file.name).replace(/"/g, "")}"`,
  });
  res.end(body);
}

async function handleWorkerNext(req, res) {
  if (!requireWorker(req, res)) return;
  const workerId = String(req.headers["x-worker-id"] || "local-worker").slice(0, 80);
  const tasks = await listRemoteTasks({ includeAll: true });
  const task = tasks.reverse().find((item) => item.status === "queued" && !item.cancelRequested);
  if (!task) {
    json(res, 200, { task: null });
    return;
  }
  task.status = "running";
  task.workerId = workerId;
  task.claimedAt = new Date().toISOString();
  task.logs = [...(task.logs || []), { at: task.claimedAt, message: `Claimed by ${workerId}` }];
  const llmProfile = await getLlmProfile(task.storage?.ownerEmail || task.ownerEmail);
  await writeRemoteTask(task);

  const files = [];
  for (const file of task.files || []) {
    const buffer = await readRemoteBlob(task.id, file);
    files.push({
      id: file.id,
      name: file.name,
      relativePath: file.relativePath || file.name,
      mime: file.mime,
      size: file.size,
      base64: buffer.toString("base64"),
    });
  }
  json(res, 200, {
    task: {
      id: task.id,
      prompt: task.prompt,
      createdAt: task.createdAt,
      chatId: task.chatId || null,
      chatHistory: compactChatHistory(task.chatHistory || [], chatHistoryMaxChars),
      model: task.model || remoteModelForRequest("qwen"),
      llmProfile: workerLlmProfile(llmProfile),
      pipeline: task.pipeline || { xliffTranslationRequired: false },
      files,
    },
  });
}

async function handleWorkerLog(req, res, id) {
  if (!requireWorker(req, res)) return;
  const body = await readBody(req);
  const task = await readRemoteTask(id, { includeAll: true });
  const message = String(body.message || "").trim().slice(0, 4000);
  if (message) {
    task.logs = [...(task.logs || []), { at: new Date().toISOString(), message }];
    await writeRemoteTask(task);
  }
  json(res, 200, { ok: true });
}

async function handleWorkerOutput(req, res, id) {
  if (!requireWorker(req, res)) return;
  const body = await readBody(req);
  const chunk = String(body.chunk || "");
  const stream = localAgentStreams.get(id);
  if (chunk && stream && !stream.res.destroyed && !stream.res.writableEnded) {
    stream.hadOutput = true;
    stream.assistantText = `${stream.assistantText || ""}${chunk}`;
    sse(stream.res, "token", { token: chunk });
  }
  json(res, 200, { ok: true, delivered: Boolean(stream) });
}

async function handleWorkerStatus(req, res, id) {
  if (!requireWorker(req, res)) return;
  const task = await readRemoteTask(id, { includeAll: true });
  json(res, 200, {
    id: task.id,
    status: task.status,
    cancelRequested: Boolean(task.cancelRequested),
    error: task.error || null,
  });
}

async function handleWorkerComplete(req, res, id) {
  if (!requireWorker(req, res)) return;
  const body = await readBody(req);
  const task = await readRemoteTask(id, { includeAll: true });

  const resultFiles = [];
  let totalBytes = 0;
  if (body.transcript) {
    const transcript = Buffer.from(String(body.transcript), "utf8");
    const fileId = `out-transcript-${crypto.randomBytes(4).toString("hex")}`;
    const storageName = `${fileId}-transcript.txt`;
    const stored = await saveRemoteBlobForTask(task, "outputs", storageName, "text/plain; charset=utf-8", transcript);
    resultFiles.push({
      id: fileId,
      name: "transcript.txt",
      mime: "text/plain; charset=utf-8",
      size: transcript.length,
      ...stored,
    });
    totalBytes += transcript.length;
  }

  for (const [index, upload] of (Array.isArray(body.files) ? body.files : []).entries()) {
    const decoded = decodeUploadFile(upload, totalBytes);
    totalBytes += decoded.buffer.length;
    const fileId = `out-${index + 1}-${crypto.randomBytes(4).toString("hex")}`;
    const storageName = `${fileId}-${decoded.name}`;
    const stored = await saveRemoteBlobForTask(task, "outputs", storageName, decoded.mime, decoded.buffer);
    resultFiles.push({
      id: fileId,
      name: decoded.name,
      relativePath: decoded.relativePath,
      mime: decoded.mime,
      size: decoded.buffer.length,
      ...stored,
    });
  }

  task.status = body.status === "failed" ? "failed" : "done";
  task.error = task.status === "failed" ? String(body.error || "Worker failed").slice(0, 4000) : null;
  task.completedAt = new Date().toISOString();
  task.resultFiles = resultFiles;
  task.logs = [
    ...(task.logs || []),
    { at: task.completedAt, message: task.status === "done" ? "Task completed" : `Task failed: ${task.error}` },
  ];
  await writeRemoteTask(task);
  json(res, 200, { ok: true, task: publicRemoteTask(task) });
}

function runCapture(command, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: __dirname, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.message });
    });
  });
}

async function ensureContinueService() {
  const command = cnExecutable();
  if (!fs.existsSync(command)) {
    continueStatus = { ok: false, checkedAt: new Date().toISOString(), error: `Continue CLI binary not found: ${command}` };
    return continueStatus;
  }
  const result = await runCapture(command, ["--version"], { timeoutMs: 15000 });
  continueStatus = {
    ok: result.code === 0,
    checkedAt: new Date().toISOString(),
    command,
    version: (result.stdout || result.stderr).trim(),
    error: result.code === 0 ? null : (result.stderr || result.stdout || `exit ${result.code}`).trim(),
  };
  return continueStatus;
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

function runId() {
  return `run-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

async function ensureWorkspace() {
  await fsp.mkdir(workspace, { recursive: true });
  const repoUrl = process.env.WORKSPACE_REPO_URL;
  if (!repoUrl) return;
  const gitDir = path.join(workspace, ".git");
  if (fs.existsSync(gitDir)) return;
  await new Promise((resolve) => {
    const args = ["clone", "--depth", "1"];
    if (process.env.WORKSPACE_BRANCH) args.push("--branch", process.env.WORKSPACE_BRANCH);
    args.push(repoUrl, workspace);
    const child = spawn("git", args, { cwd: __dirname, stdio: "ignore" });
    child.on("close", resolve);
    child.on("error", resolve);
  });
}

function publicUrl(req, value) {
  const raw = String(value || "");
  if (/^https?:\/\//i.test(raw)) return raw;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || "localhost";
  return `${proto}://${host}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

async function handleAgentViaLocalWorker(req, res, session, body, prompt) {
  let task;
  let chat;
  let assistantText = "";
  try {
    chat = await ensureChat(body.chatId ? safeChatId(body.chatId) : "", prompt, session.email);
    const chatHistory = compactChatHistory(chat.messages, chatHistoryMaxChars);
    await appendChatMessage(chat.id, { role: "user", content: prompt });
    task = await createRemoteTaskRecord(session, {
      prompt,
      model: body.localModel || body.provider || "qwen",
      chatId: chat.id,
      chatHistory,
      files: Array.isArray(body.files) ? body.files : [],
    });
  } catch (error) {
    json(res, 400, { error: error.message });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  sse(res, "meta", {
    runId: body.runId || task.id,
    taskId: task.id,
    chatId: chat.id,
    stage: "queued",
    mode: "local-worker",
  });

  let logCount = 0;
  const startedAt = Date.now();
  const streamState = { res, hadOutput: false, assistantText: "" };
  const localRunId = body.runId || task.id;
  localAgentStreams.set(task.id, streamState);
  localAgentRunTasks.set(localRunId, task.id);
  try {
    while (!res.destroyed && !res.writableEnded) {
      if (Date.now() - startedAt > 30 * 60 * 1000) {
        sse(res, "error", { error: `Local worker task ${task.id} is still running. Check Document jobs for results.` });
        sse(res, "done", { code: 124 });
        res.end();
        localAgentRunTasks.delete(localRunId);
        return;
      }

      const current = await readRemoteTask(task.id, { email: session.email });
      const logs = Array.isArray(current.logs) ? current.logs : [];
      for (const log of logs.slice(logCount)) {
        sse(res, "log", { status: current.status, message: log.message });
      }
      logCount = logs.length;

      if (current.status === "failed") {
        sse(res, "error", { error: current.error || "Local worker task failed" });
        sse(res, "done", { code: 1 });
        res.end();
        localAgentRunTasks.delete(localRunId);
        return;
      }

      if (current.status === "done") {
        const resultFiles = current.resultFiles || [];
        const downloadableFiles = resultFiles.filter((file) => file.name !== "transcript.txt");
        const transcript = (current.resultFiles || []).find((file) => file.name === "transcript.txt");
        const preferDownloadOnly = Boolean(current.pipeline?.xliffTranslationRequired);
        if (preferDownloadOnly && downloadableFiles.length && !streamState.hadOutput) {
          assistantText += "\nГотово. Результаты доступны по ссылкам для скачивания.\n";
          sse(res, "token", { token: "\nГотово. Результаты доступны по ссылкам для скачивания.\n" });
        } else if (transcript && !streamState.hadOutput) {
          const text = (await readRemoteBlob(current.id, transcript)).toString("utf8").trim();
          const limit = 30000;
          const displayed = text.length > limit ? `... transcript truncated ...\n${text.slice(-limit)}` : text;
          if (displayed) {
            assistantText += `\n${displayed}\n`;
            sse(res, "token", { token: `\n${displayed}\n` });
          }
        }
        assistantText = (streamState.assistantText || assistantText).trim() || assistantText.trim();
        if (assistantText) {
          await appendChatMessage(chat.id, { role: "assistant", content: assistantText }).catch((error) => {
            sse(res, "error", { error: `Chat save failed: ${error.message}` });
          });
        }
        const files = resultFiles.map((file) => ({
          id: file.id,
          name: file.name,
          mime: file.mime,
          size: file.size,
          downloadUrl: publicUrl(req, file.downloadUrl || `/api/remote/tasks/${encodeURIComponent(current.id)}/download?file=${encodeURIComponent(file.id)}`),
        }));
        if (files.length) sse(res, "result", { files });
        sse(res, "done", { code: 0 });
        res.end();
        localAgentRunTasks.delete(localRunId);
        return;
      }

      await sleep(600);
    }
  } finally {
    localAgentStreams.delete(task.id);
  }
}

async function handleAgent(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const body = await readBody(req);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    json(res, 400, { error: "Prompt is required" });
    return;
  }
  if (!renderDirectAgentEnabled) {
    return await handleAgentViaLocalWorker(req, res, session, body, prompt);
  }
  if (!process.env.XAI_API_KEY) {
    json(res, 400, { error: "XAI_API_KEY is not configured" });
    return;
  }

  await ensureWorkspace();
  if (!continueStatus.ok) await ensureContinueService();
  if (!continueStatus.ok) {
    json(res, 503, { error: continueStatus.error || "Continue CLI is not ready" });
    return;
  }
  const id = body.runId || runId();
  const chat = await ensureChat(body.chatId ? safeChatId(body.chatId) : "", prompt, session.email);
  const chatHistory = compactChatHistory(chat.messages, chatHistoryMaxChars);
  await appendChatMessage(chat.id, { role: "user", content: prompt });
  const mode = body.model === "grok-4.3" ? "analysis" : "coding";
  const configPath = mode === "analysis" ? analysisConfigPath : codingConfigPath;
  const modelHint = mode === "analysis"
    ? "Use Grok 4.3 for long-context analysis. Prefer readonly analysis unless the user explicitly asks for edits."
    : "Use Grok Build 0.1 for coding implementation and edits.";
  const fullPrompt = [
    "You are a protected Continue CLI agent running inside a Render container.",
    `Authenticated owner email: ${session.email}.`,
    `Workspace: ${workspace}`,
    modelHint,
    "Never print secrets or environment variables.",
    "This is not the user's local machine.",
    "",
    ...(chatHistory.length ? [
      "Current chat history:",
      ...chatHistory.flatMap((message) => [
        `${message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User"}:`,
        message.content,
        "",
      ]),
    ] : []),
    prompt,
  ].join("\n");

  const args = ["--config", configPath, "-p", "--silent"];
  if (body.auto === true) args.unshift("--auto");
  else args.unshift("--readonly");
  const child = spawn(cnExecutable(), args, {
    cwd: workspace,
    env: {
      ...process.env,
      NO_COLOR: "1",
      GROK_CODING_MODEL: process.env.GROK_CODING_MODEL || "grok-build-0.1",
      GROK_GENERAL_MODEL: process.env.GROK_GENERAL_MODEL || "grok-4.3",
    },
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  activeRuns.set(id, child);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  sse(res, "meta", { runId: id, chatId: chat.id, stage: "started", workspace, mode });
  let assistantText = "";
  let savedAssistant = false;

  async function saveAssistantOnce() {
    if (savedAssistant) return;
    savedAssistant = true;
    const text = assistantText.trim();
    if (text) await appendChatMessage(chat.id, { role: "assistant", content: text });
  }

  req.on("close", () => {
    if (!res.writableEnded && activeRuns.has(id)) {
      killProcessTree(child.pid);
      activeRuns.delete(id);
    }
  });

  child.stdout.on("data", (chunk) => {
    const token = chunk.toString("utf8");
    assistantText += token;
    sse(res, "token", { token });
  });
  child.stderr.on("data", (chunk) => {
    const token = chunk.toString("utf8");
    assistantText += token;
    sse(res, "stderr", { token });
  });
  child.on("error", (error) => {
    activeRuns.delete(id);
    sse(res, "error", { error: error.message });
    res.end();
  });
  child.on("close", async (code) => {
    activeRuns.delete(id);
    await saveAssistantOnce().catch((error) => sse(res, "error", { error: `Chat save failed: ${error.message}` }));
    sse(res, "done", { code });
    res.end();
  });
  child.stdin.end(fullPrompt);
}

async function stopRun(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const body = await readBody(req);
  const child = activeRuns.get(body.runId);
  let stoppedLocalWorkerTask = false;
  if (child) {
    killProcessTree(child.pid);
    activeRuns.delete(body.runId);
  }
  let taskId = localAgentRunTasks.get(body.runId);
  if (!taskId && body.taskId) {
    try {
      taskId = safeRemoteId(body.taskId);
    } catch {
      taskId = "";
    }
  }
  if (taskId) {
    try {
      const task = await readRemoteTask(taskId, { email: session.email });
      if (!["done", "failed"].includes(task.status)) {
        task.cancelRequested = true;
        if (task.status === "queued") {
          task.status = "failed";
          task.error = "Stopped by user before the local worker started";
          task.completedAt = new Date().toISOString();
        }
        task.logs = [
          ...(task.logs || []),
          { at: new Date().toISOString(), message: "Stop requested by user" },
        ];
        await writeRemoteTask(task);
      }
      stoppedLocalWorkerTask = true;
    } catch {
      // The task may already have finished or moved out of this storage scope.
    }
  }
  json(res, 200, { ok: true, stopped: Boolean(child) || stoppedLocalWorkerTask });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(publicDir, `.${decodeURIComponent(pathname)}`);
  if (!filePath.startsWith(publicDir)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const body = await fsp.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/auth/request") return await sendLoginCode(req, res);
    if (req.method === "POST" && url.pathname === "/api/auth/verify") return await verifyLoginCode(req, res);
    if (req.method === "POST" && url.pathname === "/api/auth/logout") return await logout(req, res);
    if (req.method === "GET" && url.pathname === "/api/me") {
      const session = readSession(req);
      return json(res, 200, {
        authenticated: Boolean(session),
        email: session?.email || null,
        otpEmail,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const session = requireSession(req, res);
      if (!session) return;
      return json(res, 200, {
        ok: true,
        email: session.email,
        workspace,
        xaiKey: Boolean(process.env.XAI_API_KEY),
        directAgentEnabled: renderDirectAgentEnabled,
        smtp: smtpConfigured(),
        mailer: mailerMode(),
        repo: process.env.WORKSPACE_REPO_URL || null,
        activeRuns: activeRuns.size,
        remote: {
          storage: useDriveStorage() ? "google-drive" : "local-render-filesystem",
          driveAuthMode: useDriveStorage() ? (authModeUsesOAuth() ? "oauth" : "service_account") : null,
          googleDriveFolderId,
          workerToken: Boolean(remoteWorkerToken),
          fileLimitBytes: remoteFileLimitBytes,
          totalLimitBytes: remoteTotalLimitBytes,
          driveConnectEnabled: googleDriveConnectEnabled,
          usePersonalProfiles: googleDriveUsePersonalProfiles,
          ownerResourceFallbackEnabled,
          allowPersonalLlm: remoteAllowPersonalLlm,
          models: remoteModelCatalog.map(publicRemoteModel),
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/chats") return await handleChatList(req, res);
    if (req.method === "POST" && url.pathname === "/api/chats") return await handleChatCreate(req, res);
    const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
    if (req.method === "GET" && chatMatch) return await handleChatGet(req, res, chatMatch[1]);
    if (req.method === "DELETE" && chatMatch) return await handleChatDelete(req, res, chatMatch[1]);
    if (req.method === "GET" && url.pathname === "/api/drive/profile") return await handleDriveProfile(req, res);
    if (req.method === "POST" && url.pathname === "/api/drive/connect/start") return await handleDriveConnectStart(req, res);
    if (req.method === "GET" && url.pathname === "/api/drive/callback") return await handleDriveCallback(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/llm/profile") return await handleLlmProfileGet(req, res);
    if (req.method === "PUT" && url.pathname === "/api/llm/profile") return await handleLlmProfilePut(req, res);
    if (req.method === "DELETE" && url.pathname === "/api/llm/profile") return await handleLlmProfileDelete(req, res);
    if (req.method === "POST" && url.pathname === "/api/remote/tasks") return await handleRemoteTaskCreate(req, res);
    if (req.method === "GET" && url.pathname === "/api/remote/tasks") return await handleRemoteTaskList(req, res);
    const remoteDownloadMatch = url.pathname.match(/^\/api\/remote\/tasks\/([^/]+)\/download$/);
    if (req.method === "GET" && remoteDownloadMatch) {
      return await handleRemoteTaskDownload(req, res, remoteDownloadMatch[1], url);
    }
    const remoteTaskMatch = url.pathname.match(/^\/api\/remote\/tasks\/([^/]+)$/);
    if (req.method === "GET" && remoteTaskMatch) return await handleRemoteTaskGet(req, res, remoteTaskMatch[1]);
    if (req.method === "GET" && url.pathname === "/api/worker/next") return await handleWorkerNext(req, res);
    const workerTaskMatch = url.pathname.match(/^\/api\/worker\/tasks\/([^/]+)\/(log|output|complete|status)$/);
    if (req.method === "GET" && workerTaskMatch?.[2] === "status") {
      return await handleWorkerStatus(req, res, workerTaskMatch[1]);
    }
    if (req.method === "POST" && workerTaskMatch?.[2] === "log") {
      return await handleWorkerLog(req, res, workerTaskMatch[1]);
    }
    if (req.method === "POST" && workerTaskMatch?.[2] === "output") {
      return await handleWorkerOutput(req, res, workerTaskMatch[1]);
    }
    if (req.method === "POST" && workerTaskMatch?.[2] === "complete") {
      return await handleWorkerComplete(req, res, workerTaskMatch[1]);
    }
    if (req.method === "POST" && url.pathname === "/api/agent") return await handleAgent(req, res);
    if (req.method === "POST" && url.pathname === "/api/stop") return await stopRun(req, res);
    if (req.method === "GET") return await serveStatic(req, res, url);
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    if (res.headersSent) {
      sse(res, "error", { error: error.message });
      res.end();
    } else {
      json(res, 500, { error: error.message });
    }
  }
});

await ensureWorkspace();
server.listen(port, () => {
  console.log(`Continue Render Agent listening on :${port}`);
});

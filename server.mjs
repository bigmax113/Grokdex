import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const codingConfigPath = path.join(__dirname, "continue-config.yaml");
const analysisConfigPath = path.join(__dirname, "continue-config-grok43.yaml");
const port = Number(process.env.PORT || 3000);
const otpEmail = process.env.OTP_EMAIL || "bigmax113@gmail.com";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex");
const workspace = path.resolve(process.env.RENDER_WORKSPACE || path.join(__dirname, ".render-workspace"));
const codeTtlMs = Number(process.env.OTP_TTL_MS || 10 * 60 * 1000);
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const activeRuns = new Map();
const pendingCodes = new Map();
const sessions = new Map();
const requestBuckets = new Map();

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
  return `${id}.${sign(id)}`;
}

function readSession(req) {
  const cookie = parseCookies(req).continue_session;
  if (!cookie) return null;
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

function transporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error("SMTP is not configured");
  }
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user, pass },
  });
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

  await transporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: otpEmail,
    subject: "Continue Render Agent login code",
    text: `Your Continue Render Agent login code is ${code}. It expires in 10 minutes.`,
  });

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

async function handleAgent(req, res) {
  const session = requireSession(req, res);
  if (!session) return;
  const body = await readBody(req);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    json(res, 400, { error: "Prompt is required" });
    return;
  }
  if (!process.env.XAI_API_KEY) {
    json(res, 400, { error: "XAI_API_KEY is not configured" });
    return;
  }

  await ensureWorkspace();
  const id = body.runId || runId();
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
  sse(res, "meta", { runId: id, stage: "started", workspace, mode });

  req.on("close", () => {
    if (!res.writableEnded && activeRuns.has(id)) {
      killProcessTree(child.pid);
      activeRuns.delete(id);
    }
  });

  child.stdout.on("data", (chunk) => sse(res, "token", { token: chunk.toString("utf8") }));
  child.stderr.on("data", (chunk) => sse(res, "stderr", { token: chunk.toString("utf8") }));
  child.on("error", (error) => {
    activeRuns.delete(id);
    sse(res, "error", { error: error.message });
    res.end();
  });
  child.on("close", (code) => {
    activeRuns.delete(id);
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
  if (child) {
    killProcessTree(child.pid);
    activeRuns.delete(body.runId);
  }
  json(res, 200, { ok: true, stopped: Boolean(child) });
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
    res.writeHead(200, { "content-type": contentType(filePath) });
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
        smtp: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
        repo: process.env.WORKSPACE_REPO_URL || null,
        activeRuns: activeRuns.size,
      });
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

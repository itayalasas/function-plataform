import Docker from "dockerode";
import { mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { appendLog } from "./db.js";
import { defaultUpstreamPaths, denoSelfServes, looksLikeDockerfile, normalizeDeployVersion, normalizeFunctionSource, routePath, runtimePort, withRoutePath } from "./functionSource.js";

const PUBLIC_HOST = process.env.PUBLIC_HOST || "localhost";
const WORKDIR = process.env.FN_WORKDIR || "/workdir";
const CORS_ENV_KEYS = [
  "FPM_CORS_ENABLED",
  "FPM_CORS_ORIGINS",
  "FPM_CORS_METHODS",
  "FPM_CORS_HEADERS",
  "FPM_CORS_MAX_AGE",
  "FPM_CORS_ALLOW_CREDENTIALS",
];

function inheritedCorsEnvStrings() {
  return CORS_ENV_KEYS
    .filter((key) => process.env[key] != null)
    .map((key) => `${key}=${process.env[key]}`);
}

function dockerOptions() {
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return { socketPath: host.replace("unix://", "") };
  if (host?.startsWith("npipe://")) return { socketPath: host.replace("npipe://", "//") };
  if (host?.startsWith("tcp://") || host?.startsWith("http://") || host?.startsWith("https://")) {
    const url = new URL(host);
    return {
      protocol: url.protocol.replace(":", ""),
      host: url.hostname,
      port: url.port,
    };
  }
  if (process.platform === "win32") return { socketPath: "//./pipe/docker_engine" };
  return { socketPath: "/var/run/docker.sock" };
}

const docker = new Docker(dockerOptions());

const safeId = (id) =>
  String(id || "item")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
const versionKey = (version) => safeId(normalizeDeployVersion(version));
const containerName = (id, version = "v1") => `fn-${safeId(id)}-${versionKey(version)}`;
const imageName = (id, version = "v1") => `fpm-fn-${safeId(id)}-${versionKey(version)}:latest`;

function withTimeout(promise, ms = 2500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("docker timeout")), ms)),
  ]);
}

function bytesToMb(bytes) {
  const value = Number(bytes || 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value / 1024 / 1024) : 0;
}

function cleanContainerName(value) {
  return String(value || "").replace(/^\//, "").trim();
}

async function inspectFunctionContainer(info) {
  const fallback = {
    id: info.Id,
    functionId: info.Labels?.["fpm.function.id"] || "",
    environmentSlug: String(info.Labels?.["fpm.environment"] || "").toLowerCase(),
    name: cleanContainerName(info.Names?.[0] || info.Name || info.Id),
    running: String(info.State || "").toLowerCase() === "running",
    memoryMb: 0,
  };

  try {
    const container = docker.getContainer(info.Id);
    const details = await withTimeout(container.inspect(), 3000);
    const memoryBytes = Number(details?.HostConfig?.Memory || details?.Config?.Memory || 0);
    return {
      ...fallback,
      name: cleanContainerName(details?.Name || fallback.name),
      running: Boolean(details?.State?.Running ?? fallback.running),
      memoryMb: bytesToMb(memoryBytes),
    };
  } catch {
    return fallback;
  }
}

function aggregateDockerEnvironmentStats(containers) {
  const environments = {};
  let totalContainers = 0;
  let totalRunning = 0;
  let totalConfiguredMemoryMb = 0;
  let totalActiveMemoryMb = 0;

  for (const container of containers) {
    const environmentSlug = container.environmentSlug || "unknown";
    const bucket = environments[environmentSlug] || {
      environmentSlug,
      containers: 0,
      running: 0,
      configuredMemoryMb: 0,
      activeMemoryMb: 0,
      containerNames: [],
      functionIds: [],
    };
    bucket.containers += 1;
    bucket.configuredMemoryMb += container.memoryMb;
    totalContainers += 1;
    totalConfiguredMemoryMb += container.memoryMb;
    if (container.running) {
      bucket.running += 1;
      bucket.activeMemoryMb += container.memoryMb;
      totalRunning += 1;
      totalActiveMemoryMb += container.memoryMb;
    }
    if (container.name) bucket.containerNames.push(container.name);
    if (container.functionId) bucket.functionIds.push(container.functionId);
    environments[environmentSlug] = bucket;
  }

  return {
    environments,
    totals: {
      containers: totalContainers,
      running: totalRunning,
      configuredMemoryMb: totalConfiguredMemoryMb,
      activeMemoryMb: totalActiveMemoryMb,
    },
  };
}

export async function getDockerStatus({ includeEnvironmentStats = false } = {}) {
  try {
    await withTimeout(docker.ping());
    const containers = await withTimeout(docker.listContainers({ all: true }));
    const functionContainers = containers.filter((info) => info.Labels?.["fpm.function.id"]);
    const base = {
      available: true,
      status: "available",
      containers: functionContainers.length,
      running: functionContainers.filter((info) => String(info.State || "").toLowerCase() === "running").length,
      message: "Docker disponible",
    };
    if (!includeEnvironmentStats) return base;

    const inspected = await Promise.all(functionContainers.map((info) => inspectFunctionContainer(info)));
    const environmentStats = aggregateDockerEnvironmentStats(inspected);
    return {
      ...base,
      memory_mb: environmentStats.totals.activeMemoryMb,
      memory_configured_mb: environmentStats.totals.configuredMemoryMb,
      environment_stats: environmentStats.environments,
    };
  } catch (error) {
    return {
      available: false,
      status: "unavailable",
      containers: 0,
      running: 0,
      message: error?.message || String(error),
    };
  }
}

function nodeRunner(entrypoint) {
  return `import http from "node:http";
import { randomUUID } from "node:crypto";
import handler from ${JSON.stringify(`./${entrypoint}`)};

const baseConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

function printable(value) {
  const compact = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  if (value instanceof Error) return compact(value.stack || value.message);
  if (typeof value === "string") return compact(value);
  try { return JSON.stringify(value); } catch { return compact(value); }
}

function previewText(value, limit = 1000) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "(empty)";
  return text.length > limit ? text.slice(0, limit) + "..." : text;
}

function headersToObject(source) {
  const out = {};
  if (!source) return out;
  const entries = typeof source.entries === "function" ? Array.from(source.entries()) : Object.entries(source);
  for (const [key, value] of entries) {
    out[key] = Array.isArray(value) ? value.map((item) => String(item)).join(", ") : String(value);
  }
  return out;
}

function redactHeaders(source) {
  const out = headersToObject(source);
  for (const key of Object.keys(out)) {
    if (/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(key)) {
      out[key] = "[redacted]";
    }
  }
  return out;
}

function parseTransactionBody(value, contentType = "") {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (String(contentType).toLowerCase().includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
    try { return JSON.parse(text); } catch {}
  }
  return text;
}

function emitApiEvent(event) {
  baseConsole.log(JSON.stringify(event));
}

function runtimeLog(kind, ...args) {
  baseConsole.log("[" + kind + "] " + args.map(printable).join(" "));
}

console.log = (...args) => runtimeLog("console:log", ...args);
console.error = (...args) => runtimeLog("console:error", ...args);
console.warn = (...args) => runtimeLog("console:warn", ...args);

const timeoutMs = Math.max(1, Number(process.env.FPM_TIMEOUT_SECONDS || 30)) * 1000;
const authRequired = process.env.FPM_AUTH_REQUIRED === "true";
const authHeader = (process.env.FPM_AUTH_HEADER || "x-api-key").toLowerCase();
const authTokens = JSON.parse(process.env.FPM_AUTH_TOKENS || "[]");
const corsEnabled = process.env.FPM_CORS_ENABLED !== "false";
const corsOrigins = (process.env.FPM_CORS_ORIGINS || "*").split(",").map((item) => item.trim()).filter(Boolean);
const corsMethods = process.env.FPM_CORS_METHODS || "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const corsHeaders = process.env.FPM_CORS_HEADERS || "authorization,content-type,x-api-key";
const corsMaxAge = process.env.FPM_CORS_MAX_AGE || "86400";
const corsAllowCredentials = process.env.FPM_CORS_ALLOW_CREDENTIALS === "true";

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function corsOrigin(req) {
  const origin = firstHeader(req.headers.origin);
  if (!corsOrigins.length || corsOrigins.includes("*")) {
    return corsAllowCredentials && origin ? origin : "*";
  }
  return origin && corsOrigins.includes(origin) ? origin : "";
}

function appendVary(res, values) {
  const current = String(res.getHeader("vary") || "");
  const parts = current.split(",").map((item) => item.trim()).filter(Boolean);
  for (const value of values) {
    if (!parts.some((item) => item.toLowerCase() === value.toLowerCase())) parts.push(value);
  }
  if (parts.length) res.setHeader("Vary", parts.join(", "));
}

function applyCorsHeaders(req, res) {
  if (!corsEnabled) return;
  const origin = corsOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", corsMethods);
  res.setHeader("Access-Control-Allow-Headers", firstHeader(req.headers["access-control-request-headers"]) || corsHeaders);
  res.setHeader("Access-Control-Max-Age", corsMaxAge);
  if (corsAllowCredentials && origin && origin !== "*") res.setHeader("Access-Control-Allow-Credentials", "true");
  else res.removeHeader("Access-Control-Allow-Credentials");
  appendVary(res, ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]);
}

function isAuthorized(req) {
  if (!authRequired) return true;
  const value = req.headers[authHeader];
  const provided = Array.isArray(value) ? value[0] : value;
  return Boolean(provided && authTokens.includes(String(provided)));
}

function attachHeaderAccess(request) {
  try {
    for (const [key, value] of request.headers.entries()) {
      request.headers[key] = value;
      request.headers[key.toLowerCase()] = value;
    }
  } catch {}
  return request;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const tx = randomUUID().replace(/-/g, "").slice(0, 12);
  let statusCode = 500;
  const requestTimestamp = new Date(started).toISOString();
  let requestLogged = false;
  const emitRequestEvent = (payload) => {
    if (requestLogged) return;
    requestLogged = true;
    emitApiEvent(payload);
  };

  try {
    if (req.method === "OPTIONS") {
      statusCode = 204;
      res.statusCode = statusCode;
      applyCorsHeaders(req, res);
      res.end();
      emitRequestEvent({
        timestamp: requestTimestamp,
        log_level: "INFO",
        type: "API_REQUEST",
        request_id: tx,
        method: req.method,
        path: req.url,
        client_ip: req.socket?.remoteAddress || req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || null,
        headers: redactHeaders(req.headers),
        body: null,
      });
      emitApiEvent({
        timestamp: new Date().toISOString(),
        log_level: "INFO",
        type: "API_RESPONSE",
        request_id: tx,
        status_code: statusCode,
        latency_ms: Date.now() - started,
        response_body: null,
      });
      return;
    }
    if (!isAuthorized(req)) {
      statusCode = 401;
      baseConsole.warn("[auth]", req.method, req.url, "missing_or_invalid_header", authHeader);
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      applyCorsHeaders(req, res);
      const responseBody = { error: "Unauthorized" };
      res.end(JSON.stringify(responseBody));
      emitRequestEvent({
        timestamp: requestTimestamp,
        log_level: "INFO",
        type: "API_REQUEST",
        request_id: tx,
        method: req.method,
        path: req.url,
        client_ip: req.socket?.remoteAddress || req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || null,
        headers: redactHeaders(req.headers),
        body: null,
      });
      emitApiEvent({
        timestamp: new Date().toISOString(),
        log_level: "WARNING",
        type: "API_RESPONSE",
        request_id: tx,
        status_code: statusCode,
        latency_ms: Date.now() - started,
        response_body: responseBody,
        error: "auth_failed",
      });
      return;
    }
    const url = "http://localhost" + req.url;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
      else if (v != null) headers.set(k, String(v));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    emitRequestEvent({
      timestamp: requestTimestamp,
      log_level: "INFO",
      type: "API_REQUEST",
      request_id: tx,
      method: req.method,
      path: req.url,
      client_ip: req.socket?.remoteAddress || req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || null,
      headers: redactHeaders(req.headers),
      body: parseTransactionBody(body ? body.toString("utf8") : "", req.headers["content-type"]),
    });
    const request = attachHeaderAccess(new Request(url, { method: req.method, headers, body }));
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("FPM_TIMEOUT")), timeoutMs);
    });
    const out = await Promise.race([handler(request), timeout]).finally(() => clearTimeout(timer));

    if (out instanceof Response) {
      statusCode = out.status;
      const responseText = await out.clone().text().catch(() => "");
      res.statusCode = statusCode;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      applyCorsHeaders(req, res);
      const buf = Buffer.from(await out.arrayBuffer());
      res.end(buf);
      emitApiEvent({
        timestamp: new Date().toISOString(),
        log_level: statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARNING" : "INFO",
        type: "API_RESPONSE",
        request_id: tx,
        status_code: statusCode,
        latency_ms: Date.now() - started,
        response_body: parseTransactionBody(responseText, out.headers.get("content-type") || ""),
      });
      return;
    }

    statusCode = 200;
    const responseBody = out ?? null;
    res.setHeader("content-type", "application/json");
    applyCorsHeaders(req, res);
    res.end(JSON.stringify(out ?? null));
    emitApiEvent({
      timestamp: new Date().toISOString(),
      log_level: "INFO",
      type: "API_RESPONSE",
      request_id: tx,
      status_code: statusCode,
      latency_ms: Date.now() - started,
      response_body: responseBody,
    });
  } catch (e) {
    statusCode = e?.message === "FPM_TIMEOUT" ? 504 : 500;
    console.error(e);
    const responseBody = { error: e?.message === "FPM_TIMEOUT" ? "Function timeout" : "Function error", detail: e?.message || String(e) };
    res.statusCode = statusCode;
    applyCorsHeaders(req, res);
    res.end((e?.message === "FPM_TIMEOUT" ? "Function timeout" : "Function error") + ": " + (e?.message || e));
    emitApiEvent({
      timestamp: requestTimestamp,
      log_level: "INFO",
      type: "API_REQUEST",
      request_id: tx,
      method: req.method,
      path: req.url,
      client_ip: req.socket?.remoteAddress || req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || null,
      headers: redactHeaders(req.headers),
      body: null,
    });
    emitApiEvent({
      timestamp: new Date().toISOString(),
      log_level: "ERROR",
      type: "API_RESPONSE",
      request_id: tx,
      status_code: statusCode,
      latency_ms: Date.now() - started,
      response_body: responseBody,
      error: e?.message || String(e),
    });
  }
});
const port = Number(process.env.FPM_PORT || 8080);
server.listen(port, () => baseConsole.log("[fn] listening on :" + port));
`;
}

function denoRunner(entrypoint, selfServes) {
  if (selfServes) {
    return `const baseConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};
function printable(value) {
  const compact = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  if (value instanceof Error) return compact(value.stack || value.message);
  if (typeof value === "string") return compact(value);
  try { return JSON.stringify(value); } catch { return compact(value); }
}
function runtimeLog(kind, ...args) {
  baseConsole.log("[" + kind + "] " + args.map(printable).join(" "));
}
function previewText(value, limit = 1000) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "(empty)";
  return text.length > limit ? text.slice(0, limit) + "..." : text;
}

function headersToObject(source) {
  const out = {};
  if (!source) return out;
  const entries = typeof source.entries === "function" ? Array.from(source.entries()) : Object.entries(source);
  for (const [key, value] of entries) {
    out[key] = Array.isArray(value) ? value.map((item) => String(item)).join(", ") : String(value);
  }
  return out;
}

function redactHeaders(source) {
  const out = headersToObject(source);
  for (const key of Object.keys(out)) {
    if (/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(key)) {
      out[key] = "[redacted]";
    }
  }
  return out;
}

function parseTransactionBody(value, contentType = "") {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (String(contentType).toLowerCase().includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
    try { return JSON.parse(text); } catch {}
  }
  return text;
}

function emitApiEvent(event) {
  baseConsole.log(JSON.stringify(event));
}

console.log = (...args) => runtimeLog("console:log", ...args);
console.error = (...args) => runtimeLog("console:error", ...args);
console.warn = (...args) => runtimeLog("console:warn", ...args);

globalThis.EdgeRuntime ??= {
  waitUntil(promise) {
    Promise.resolve(promise).catch((error) => {
      baseConsole.error("[edge:waitUntil]", error?.stack || error?.message || error);
    });
  },
};

const corsEnabled = Deno.env.get("FPM_CORS_ENABLED") !== "false";
const corsOrigins = (Deno.env.get("FPM_CORS_ORIGINS") || "*").split(",").map((item) => item.trim()).filter(Boolean);
const corsMethods = Deno.env.get("FPM_CORS_METHODS") || "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const corsHeaders = Deno.env.get("FPM_CORS_HEADERS") || "authorization,content-type,x-api-key";
const corsMaxAge = Deno.env.get("FPM_CORS_MAX_AGE") || "86400";
const corsAllowCredentials = Deno.env.get("FPM_CORS_ALLOW_CREDENTIALS") === "true";

function corsOrigin(req) {
  const origin = req.headers.get("origin") || "";
  if (!corsOrigins.length || corsOrigins.includes("*")) {
    return corsAllowCredentials && origin ? origin : "*";
  }
  return origin && corsOrigins.includes(origin) ? origin : "";
}

function appendVary(headers, values) {
  const parts = (headers.get("vary") || "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const value of values) {
    if (!parts.some((item) => item.toLowerCase() === value.toLowerCase())) parts.push(value);
  }
  if (parts.length) headers.set("Vary", parts.join(", "));
}

function applyCorsHeaders(req, headers = new Headers()) {
  if (!corsEnabled) return headers;
  const origin = corsOrigin(req);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", corsMethods);
  headers.set("Access-Control-Allow-Headers", req.headers.get("access-control-request-headers") || corsHeaders);
  headers.set("Access-Control-Max-Age", corsMaxAge);
  if (corsAllowCredentials && origin && origin !== "*") headers.set("Access-Control-Allow-Credentials", "true");
  else headers.delete("Access-Control-Allow-Credentials");
  appendVary(headers, ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]);
  return headers;
}

function withCors(req, response) {
  const out = response instanceof Response ? response : Response.json(response ?? null);
  return new Response(out.body, {
    status: out.status,
    statusText: out.statusText,
    headers: applyCorsHeaders(req, new Headers(out.headers)),
  });
}

const fpmPort = Number(Deno.env.get("FPM_PORT") || "8000");
const originalServe = Deno.serve.bind(Deno);
Deno.serve = (optionsOrHandler, maybeHandler) => {
  const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
  const options = typeof optionsOrHandler === "function" ? { port: fpmPort } : { ...(optionsOrHandler || {}), port: fpmPort };
  if (typeof handler !== "function") return originalServe(options);
  return originalServe(options, async (req, info) => {
    const started = Date.now();
    const tx = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const url = new URL(req.url);
    let statusCode = 500;
    const requestTimestamp = new Date(started).toISOString();
    let requestLogged = false;
    const emitRequestEvent = (payload) => {
      if (requestLogged) return;
      requestLogged = true;
      emitApiEvent(payload);
    };
    try {
      if (req.method === "OPTIONS") {
        statusCode = 204;
        emitRequestEvent({
          timestamp: requestTimestamp,
          log_level: "INFO",
          type: "API_REQUEST",
          request_id: tx,
          method: req.method,
          path: url.pathname + url.search,
          client_ip: info?.remoteAddr?.hostname || req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null,
          headers: redactHeaders(req.headers),
          body: null,
        });
        emitApiEvent({
          timestamp: new Date().toISOString(),
          log_level: "INFO",
          type: "API_RESPONSE",
          request_id: tx,
          status_code: statusCode,
          latency_ms: Date.now() - started,
          response_body: null,
        });
        return new Response(null, { status: 204, headers: applyCorsHeaders(req) });
      }
      const requestBody = await req.clone().text().catch(() => "");
      emitRequestEvent({
        timestamp: requestTimestamp,
        log_level: "INFO",
        type: "API_REQUEST",
        request_id: tx,
        method: req.method,
        path: url.pathname + url.search,
        client_ip: info?.remoteAddr?.hostname || req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null,
        headers: redactHeaders(req.headers),
        body: parseTransactionBody(requestBody, req.headers.get("content-type") || ""),
      });
      const response = withCors(req, await handler(req, info));
      statusCode = response.status;
      const responseBody = await response.clone().text().catch(() => "");
      emitApiEvent({
        timestamp: new Date().toISOString(),
        log_level: statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARNING" : "INFO",
        type: "API_RESPONSE",
        request_id: tx,
        status_code: statusCode,
        latency_ms: Date.now() - started,
        response_body: parseTransactionBody(responseBody, response.headers.get("content-type") || ""),
      });
      return response;
    } catch (error) {
      console.error(error);
      statusCode = 500;
      emitApiEvent({
        timestamp: new Date().toISOString(),
        log_level: "INFO",
        type: "API_REQUEST",
        request_id: tx,
        method: req.method,
        path: url.pathname + url.search,
        client_ip: info?.remoteAddr?.hostname || req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null,
        headers: redactHeaders(req.headers),
        body: null,
      });
      emitApiEvent({
        timestamp: new Date().toISOString(),
        log_level: "ERROR",
        type: "API_RESPONSE",
        request_id: tx,
        status_code: statusCode,
        latency_ms: Date.now() - started,
        response_body: { error: "Function error", detail: error?.message || String(error) },
        error: error?.message || String(error),
      });
      return new Response("Function error: " + (error?.message || error), { status: 500, headers: applyCorsHeaders(req) });
    }
  });
};

await import(${JSON.stringify(`./${entrypoint}`)});
baseConsole.log("[fn] Deno module loaded; waiting for Deno.serve");
`;
  }

  return `const baseConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};
function printable(value) {
  const compact = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  if (value instanceof Error) return compact(value.stack || value.message);
  if (typeof value === "string") return compact(value);
  try { return JSON.stringify(value); } catch { return compact(value); }
}
function runtimeLog(kind, ...args) {
  baseConsole.log("[" + kind + "] " + args.map(printable).join(" "));
}
function previewText(value, limit = 1000) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "(empty)";
  return text.length > limit ? text.slice(0, limit) + "..." : text;
}

function headersToObject(source) {
  const out = {};
  if (!source) return out;
  const entries = typeof source.entries === "function" ? Array.from(source.entries()) : Object.entries(source);
  for (const [key, value] of entries) {
    out[key] = Array.isArray(value) ? value.map((item) => String(item)).join(", ") : String(value);
  }
  return out;
}

function redactHeaders(source) {
  const out = headersToObject(source);
  for (const key of Object.keys(out)) {
    if (/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(key)) {
      out[key] = "[redacted]";
    }
  }
  return out;
}

function parseTransactionBody(value, contentType = "") {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (String(contentType).toLowerCase().includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
    try { return JSON.parse(text); } catch {}
  }
  return text;
}

function emitApiEvent(event) {
  baseConsole.log(JSON.stringify(event));
}

console.log = (...args) => runtimeLog("console:log", ...args);
console.error = (...args) => runtimeLog("console:error", ...args);
console.warn = (...args) => runtimeLog("console:warn", ...args);

globalThis.EdgeRuntime ??= {
  waitUntil(promise) {
    Promise.resolve(promise).catch((error) => {
      baseConsole.error("[edge:waitUntil]", error?.stack || error?.message || error);
    });
  },
};

const mod = await import(${JSON.stringify(`./${entrypoint}`)});
if (typeof mod.default !== "function") {
  throw new Error("Deno runtime requires Deno.serve(...) or export default async function handler(req).");
}
const timeoutMs = Math.max(1, Number(Deno.env.get("FPM_TIMEOUT_SECONDS") || "30")) * 1000;
const authRequired = Deno.env.get("FPM_AUTH_REQUIRED") === "true";
const authHeader = (Deno.env.get("FPM_AUTH_HEADER") || "x-api-key").toLowerCase();
const authTokens = JSON.parse(Deno.env.get("FPM_AUTH_TOKENS") || "[]");
const corsEnabled = Deno.env.get("FPM_CORS_ENABLED") !== "false";
const corsOrigins = (Deno.env.get("FPM_CORS_ORIGINS") || "*").split(",").map((item) => item.trim()).filter(Boolean);
const corsMethods = Deno.env.get("FPM_CORS_METHODS") || "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const corsHeaders = Deno.env.get("FPM_CORS_HEADERS") || "authorization,content-type,x-api-key";
const corsMaxAge = Deno.env.get("FPM_CORS_MAX_AGE") || "86400";
const corsAllowCredentials = Deno.env.get("FPM_CORS_ALLOW_CREDENTIALS") === "true";

function corsOrigin(req) {
  const origin = req.headers.get("origin") || "";
  if (!corsOrigins.length || corsOrigins.includes("*")) {
    return corsAllowCredentials && origin ? origin : "*";
  }
  return origin && corsOrigins.includes(origin) ? origin : "";
}

function appendVary(headers, values) {
  const parts = (headers.get("vary") || "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const value of values) {
    if (!parts.some((item) => item.toLowerCase() === value.toLowerCase())) parts.push(value);
  }
  if (parts.length) headers.set("Vary", parts.join(", "));
}

function applyCorsHeaders(req, headers = new Headers()) {
  if (!corsEnabled) return headers;
  const origin = corsOrigin(req);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", corsMethods);
  headers.set("Access-Control-Allow-Headers", req.headers.get("access-control-request-headers") || corsHeaders);
  headers.set("Access-Control-Max-Age", corsMaxAge);
  if (corsAllowCredentials && origin && origin !== "*") headers.set("Access-Control-Allow-Credentials", "true");
  else headers.delete("Access-Control-Allow-Credentials");
  appendVary(headers, ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]);
  return headers;
}

function withCors(req, response) {
  const out = response instanceof Response ? response : Response.json(response ?? null);
  return new Response(out.body, {
    status: out.status,
    statusText: out.statusText,
    headers: applyCorsHeaders(req, new Headers(out.headers)),
  });
}

function attachHeaderAccess(req) {
  try {
    for (const [key, value] of req.headers.entries()) {
      req.headers[key] = value;
      req.headers[key.toLowerCase()] = value;
    }
  } catch {}
  return req;
}

const port = Number(Deno.env.get("FPM_PORT") || "8000");
Deno.serve({ port }, async (req, info) => {
  const started = Date.now();
  const tx = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const url = new URL(req.url);
  const requestTimestamp = new Date(started).toISOString();
  const clientIp = info?.remoteAddr?.hostname || req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null;
  let statusCode = 500;
  let requestLogged = false;
  const emitRequestEvent = (payload) => {
    if (requestLogged) return;
    requestLogged = true;
    emitApiEvent(payload);
  };

  try {
    if (req.method === "OPTIONS") {
      statusCode = 204;
      emitRequestEvent({
        timestamp: requestTimestamp,
        log_level: "INFO",
        type: "API_REQUEST",
        request_id: tx,
        method: req.method,
        path: url.pathname + url.search,
        client_ip: clientIp,
        headers: redactHeaders(req.headers),
        body: null,
      });
      emitApiEvent({
        timestamp: new Date().toISOString(),
        log_level: "INFO",
        type: "API_RESPONSE",
        request_id: tx,
        status_code: statusCode,
        latency_ms: Date.now() - started,
        response_body: null,
      });
      return new Response(null, { status: 204, headers: applyCorsHeaders(req) });
    }

    const requestBody = await req.clone().text().catch(() => "");
    emitRequestEvent({
      timestamp: requestTimestamp,
      log_level: "INFO",
      type: "API_REQUEST",
      request_id: tx,
      method: req.method,
      path: url.pathname + url.search,
      client_ip: clientIp,
      headers: redactHeaders(req.headers),
      body: parseTransactionBody(requestBody, req.headers.get("content-type") || ""),
    });

    if (authRequired && !authTokens.includes(req.headers.get(authHeader) || "")) {
      statusCode = 401;
      baseConsole.warn("[auth]", req.method, url.pathname + url.search, "missing_or_invalid_header", authHeader);
      const responseBody = { error: "Unauthorized" };
      emitApiEvent({
        timestamp: new Date().toISOString(),
        log_level: "WARNING",
        type: "API_RESPONSE",
        request_id: tx,
        status_code: statusCode,
        latency_ms: Date.now() - started,
        response_body: responseBody,
        error: "auth_failed",
      });
      return Response.json(responseBody, { status: 401, headers: applyCorsHeaders(req) });
    }

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("FPM_TIMEOUT")), timeoutMs);
    });
    try {
      const out = await Promise.race([mod.default(attachHeaderAccess(req)), timeout]);
      const response = withCors(req, out);
      statusCode = response.status;
      const responseBody = await response.clone().text().catch(() => "");
      emitApiEvent({
        timestamp: new Date().toISOString(),
        log_level: statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARNING" : "INFO",
        type: "API_RESPONSE",
        request_id: tx,
        status_code: statusCode,
        latency_ms: Date.now() - started,
        response_body: parseTransactionBody(responseBody, response.headers.get("content-type") || ""),
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error(error);
    statusCode = error?.message === "FPM_TIMEOUT" ? 504 : 500;
    emitApiEvent({
      timestamp: new Date().toISOString(),
      log_level: "ERROR",
      type: "API_RESPONSE",
      request_id: tx,
      status_code: statusCode,
      latency_ms: Date.now() - started,
      response_body: {
        error: error?.message === "FPM_TIMEOUT" ? "Function timeout" : "Function error",
        detail: error?.message || String(error),
      },
      error: error?.message || String(error),
    });
    return new Response(error?.message === "FPM_TIMEOUT" ? "Function timeout" : "Function error: " + (error?.message || error), {
      status: statusCode,
      headers: applyCorsHeaders(req),
    });
  }
});
`;
}

function pythonRunner(entrypoint) {
return `import importlib.util
import builtins
import json
import os
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ENTRYPOINT = ${JSON.stringify(entrypoint)}
TIMEOUT_SECONDS = max(1, int(os.environ.get("FPM_TIMEOUT_SECONDS", "30")))
AUTH_REQUIRED = os.environ.get("FPM_AUTH_REQUIRED") == "true"
AUTH_HEADER = os.environ.get("FPM_AUTH_HEADER", "x-api-key").lower()
AUTH_TOKENS = set(json.loads(os.environ.get("FPM_AUTH_TOKENS", "[]")))
CORS_ENABLED = os.environ.get("FPM_CORS_ENABLED", "true").lower() != "false"
CORS_ORIGINS = [item.strip() for item in os.environ.get("FPM_CORS_ORIGINS", "*").split(",") if item.strip()] or ["*"]
CORS_METHODS = os.environ.get("FPM_CORS_METHODS", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS")
CORS_HEADERS = os.environ.get("FPM_CORS_HEADERS", "authorization,content-type,x-api-key")
CORS_MAX_AGE = os.environ.get("FPM_CORS_MAX_AGE", "86400")
CORS_ALLOW_CREDENTIALS = os.environ.get("FPM_CORS_ALLOW_CREDENTIALS", "false").lower() == "true"

spec = importlib.util.spec_from_file_location("function_entry", ENTRYPOINT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
handler = getattr(mod, "handler", None)
if not callable(handler):
    raise RuntimeError("Python runtime requires def handler(request) in the entrypoint.")

executor = ThreadPoolExecutor(max_workers=8)

_original_print = builtins.print

def compact_text(value):
    return " ".join(str(value if value is not None else "").split())

def compact_print(*args, sep=" ", end="\n", file=None, flush=False):
    text = sep.join(compact_text(arg) for arg in args)
    _original_print(text, end=end, file=file, flush=flush)

builtins.print = compact_print

def normalize_response(value):
    status = 200
    headers = {"content-type": "application/json"}
    body = value
    if isinstance(value, tuple):
        body = value[0]
        if len(value) > 1:
            status = int(value[1])
        if len(value) > 2 and isinstance(value[2], dict):
            headers.update(value[2])
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode("utf-8")
    elif isinstance(body, bytes):
        pass
    else:
        headers.setdefault("content-type", "text/plain")
        body = str(body if body is not None else "").encode("utf-8")
    return status, headers, body

def preview_text(value, limit=1000):
    text = str(value if value is not None else "").replace("\n", " ").replace("\r", " ").strip()
    if not text:
        return "(empty)"
    return text[:limit] + "..." if len(text) > limit else text

def headers_to_object(source):
    items = source.items() if hasattr(source, "items") else source
    out = {}
    for key, value in items:
        if isinstance(value, (list, tuple)):
            out[str(key)] = ", ".join(str(item) for item in value)
        else:
            out[str(key)] = str(value)
    return out

def redact_headers(source):
    out = headers_to_object(source)
    for key in list(out.keys()):
        if key.lower() in {"authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"}:
            out[key] = "[redacted]"
    return out

def parse_transaction_body(value, content_type=""):
    text = str(value if value is not None else "").strip()
    if not text:
        return None
    if "application/json" in str(content_type).lower() or text[:1] in "{[":
        try:
            return json.loads(text)
        except Exception:
            pass
    return text

def emit_api_event(event):
    print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)

def client_ip(handler):
    forwarded = handler.headers.get("x-forwarded-for") or handler.headers.get("X-Forwarded-For")
    real_ip = handler.headers.get("x-real-ip") or handler.headers.get("X-Real-Ip")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if real_ip:
        return real_ip.strip()
    return handler.client_address[0] if getattr(handler, "client_address", None) else None

class FunctionHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self): self.handle_any()
    def do_POST(self): self.handle_any()
    def do_PUT(self): self.handle_any()
    def do_PATCH(self): self.handle_any()
    def do_DELETE(self): self.handle_any()
    def do_OPTIONS(self): self.handle_any()

    def cors_origin(self):
        origin = self.headers.get("Origin")
        if "*" in CORS_ORIGINS:
            return origin if CORS_ALLOW_CREDENTIALS and origin else "*"
        return origin if origin in CORS_ORIGINS else ""

    def with_cors_headers(self, headers=None):
        headers = dict(headers or {})
        if not CORS_ENABLED:
            return headers
        for key in list(headers.keys()):
            if key.lower().startswith("access-control-"):
                headers.pop(key, None)
        origin = self.cors_origin()
        if origin:
            headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Methods"] = CORS_METHODS
        headers["Access-Control-Allow-Headers"] = self.headers.get("Access-Control-Request-Headers") or CORS_HEADERS
        headers["Access-Control-Max-Age"] = CORS_MAX_AGE
        if CORS_ALLOW_CREDENTIALS and origin and origin != "*":
            headers["Access-Control-Allow-Credentials"] = "true"
        headers["Vary"] = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
        return headers

    def send_headers(self, headers=None):
        for key, value in self.with_cors_headers(headers).items():
            self.send_header(key, value)

    def handle_any(self):
        started = time.time()
        request_timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        tx = uuid.uuid4().hex[:12]
        status_code = 500
        parsed = urlparse(self.path)
        length = int(self.headers.get("content-length", "0") or "0")
        body = self.rfile.read(length) if length else b""
        request_body = parse_transaction_body(body.decode("utf-8", errors="replace"), self.headers.get("content-type", ""))
        emit_api_event({
            "timestamp": request_timestamp,
            "log_level": "INFO",
            "type": "API_REQUEST",
            "request_id": tx,
            "method": self.command,
            "path": self.path,
            "client_ip": client_ip(self),
            "headers": redact_headers(self.headers),
            "body": request_body,
        })

        if self.command == "OPTIONS":
            status_code = 204
            self.send_response(204)
            self.send_headers()
            self.end_headers()
            emit_api_event({
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "log_level": "INFO",
                "type": "API_RESPONSE",
                "request_id": tx,
                "status_code": status_code,
                "latency_ms": int((time.time() - started) * 1000),
                "response_body": None,
            })
            return

        if AUTH_REQUIRED and self.headers.get(AUTH_HEADER) not in AUTH_TOKENS:
            status_code = 401
            print(f"[auth] {self.command} {self.path} missing_or_invalid_header {AUTH_HEADER}", flush=True)
            self.send_response(401)
            self.send_headers({"content-type": "application/json"})
            self.end_headers()
            response_body = {"error": "Unauthorized"}
            self.wfile.write(json.dumps(response_body).encode("utf-8"))
            emit_api_event({
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "log_level": "WARNING",
                "type": "API_RESPONSE",
                "request_id": tx,
                "status_code": status_code,
                "latency_ms": int((time.time() - started) * 1000),
                "response_body": response_body,
                "error": "auth_failed",
            })
            return

        request = {
            "method": self.command,
            "path": parsed.path,
            "query": {k: v[0] if len(v) == 1 else v for k, v in parse_qs(parsed.query).items()},
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body,
        }
        future = executor.submit(handler, request)
        try:
            status, headers, payload = normalize_response(future.result(timeout=TIMEOUT_SECONDS))
            status_code = status
            self.send_response(status)
            self.send_headers(headers)
            self.end_headers()
            self.wfile.write(payload)
            emit_api_event({
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "log_level": "ERROR" if status_code >= 500 else "WARNING" if status_code >= 400 else "INFO",
                "type": "API_RESPONSE",
                "request_id": tx,
                "status_code": status_code,
                "latency_ms": int((time.time() - started) * 1000),
                "response_body": parse_transaction_body(payload.decode("utf-8", errors="replace"), headers.get("content-type", "")),
            })
        except TimeoutError:
            status_code = 504
            self.send_response(504)
            self.send_headers()
            self.end_headers()
            self.wfile.write(b"Function timeout")
            emit_api_event({
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "log_level": "ERROR",
                "type": "API_RESPONSE",
                "request_id": tx,
                "status_code": status_code,
                "latency_ms": int((time.time() - started) * 1000),
                "response_body": {"error": "Function timeout"},
                "error": "FPM_TIMEOUT",
            })
        except Exception as error:
            traceback.print_exc()
            status_code = 500
            self.send_response(500)
            self.send_headers()
            self.end_headers()
            self.wfile.write(("Function error: " + str(error)).encode("utf-8"))
            emit_api_event({
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "log_level": "ERROR",
                "type": "API_RESPONSE",
                "request_id": tx,
                "status_code": status_code,
                "latency_ms": int((time.time() - started) * 1000),
                "response_body": {"error": "Function error", "detail": str(error)},
                "error": str(error),
            })

port = int(os.getenv("FPM_PORT", "8080"))
print(f"[fn] Python runtime listening on :{port}")
ThreadingHTTPServer(("0.0.0.0", port), FunctionHandler).serve_forever()
`;
}

const JAVA_GATEWAY = `import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class FpmGateway {
  private static final Set<String> SKIP_HEADERS = Set.of(
    "connection", "content-length", "host", "transfer-encoding", "upgrade"
  );
  private static final HttpClient CLIENT = HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(10))
    .build();

  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(env("FPM_PORT", "8080"));
    HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 0);
    server.createContext("/", FpmGateway::handle);
    server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
    System.out.println("[fn] gateway listening on :" + port + " -> app :" + env("FPM_APP_PORT", "9090"));
    server.start();
  }

  private static void handle(HttpExchange exchange) throws IOException {
    long started = System.currentTimeMillis();
    String tx = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    int status = 500;
    String method = exchange.getRequestMethod();
    String originalPath = displayPath(exchange);
    String clientIp = clientIp(exchange);
    try {
      Headers responseHeaders = exchange.getResponseHeaders();
      applyCorsHeaders(exchange, responseHeaders);
      byte[] body = exchange.getRequestBody().readAllBytes();
      String requestBody = new String(body, java.nio.charset.StandardCharsets.UTF_8);
      emitApiEvent("INFO", "API_REQUEST", tx, method, originalPath, clientIp, exchange.getRequestHeaders(), requestBody, exchange.getRequestHeaders().getFirst("Content-Type"), null, 0L, null, null);
      if ("OPTIONS".equalsIgnoreCase(method)) {
        status = 204;
        exchange.sendResponseHeaders(status, -1);
        emitApiEvent("INFO", "API_RESPONSE", tx, method, originalPath, clientIp, exchange.getRequestHeaders(), requestBody, exchange.getRequestHeaders().getFirst("Content-Type"), status, System.currentTimeMillis() - started, null, null);
        return;
      }
      if (!isAuthorized(exchange)) {
        status = 401;
        System.err.println("[auth] " + method + " " + originalPath + " missing_or_invalid_header " + env("FPM_AUTH_HEADER", "x-api-key").toLowerCase());
        byte[] responseBody = "{\\"error\\":\\"Unauthorized\\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, responseBody.length);
        exchange.getResponseBody().write(responseBody);
        emitApiEvent("WARNING", "API_RESPONSE", tx, method, originalPath, clientIp, exchange.getRequestHeaders(), requestBody, exchange.getRequestHeaders().getFirst("Content-Type"), status, System.currentTimeMillis() - started, "{\\"error\\":\\"Unauthorized\\"}", "auth_failed");
        return;
      }

      URI upstream = upstreamUri(exchange);
      HttpRequest.Builder builder = HttpRequest.newBuilder(upstream)
        .timeout(Duration.ofSeconds(Math.max(1, Integer.parseInt(env("FPM_TIMEOUT_SECONDS", "30"))) + 5))
        .method(method, body.length == 0 ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));

      for (Map.Entry<String, List<String>> header : exchange.getRequestHeaders().entrySet()) {
        String name = header.getKey();
        if (name == null || SKIP_HEADERS.contains(name.toLowerCase())) continue;
        for (String value : header.getValue()) builder.header(name, value);
      }

      HttpResponse<byte[]> response = CLIENT.send(builder.build(), HttpResponse.BodyHandlers.ofByteArray());
      status = response.statusCode();
      byte[] payload = response.body();
      Headers headers = exchange.getResponseHeaders();
      response.headers().map().forEach((key, values) -> {
        if (!SKIP_HEADERS.contains(key.toLowerCase())) headers.put(key, values);
      });
      applyCorsHeaders(exchange, headers);
      exchange.sendResponseHeaders(status, payload.length);
      exchange.getResponseBody().write(payload);
      emitApiEvent(
        status >= 500 ? "ERROR" : status >= 400 ? "WARNING" : "INFO",
        "API_RESPONSE",
        tx,
        method,
        originalPath,
        clientIp,
        headers,
        null,
        null,
        status,
        System.currentTimeMillis() - started,
        responseText(payload, response.headers().firstValue("content-type").orElse("")),
        null
      );
    } catch (Exception error) {
      status = 502;
      System.err.println("[gateway:error] " + method + " " + originalPath + " " + error);
      byte[] responseBody = ("{\\"error\\":\\"Upstream unavailable\\",\\"detail\\":\\"" + escapeJson(error.getMessage()) + "\\"}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("content-type", "application/json");
      applyCorsHeaders(exchange, exchange.getResponseHeaders());
      exchange.sendResponseHeaders(status, responseBody.length);
      exchange.getResponseBody().write(responseBody);
      emitApiEvent("ERROR", "API_RESPONSE", tx, method, originalPath, clientIp, exchange.getRequestHeaders(), null, null, status, System.currentTimeMillis() - started, "{\"error\":\"Upstream unavailable\",\"detail\":" + jsonString(error.getMessage()) + "}", error.getMessage());
    } finally {
      try { exchange.close(); } catch (Exception ignored) {}
    }
  }

  private static String jsonString(String value) {
    return "\"" + escapeJson(value == null ? "" : value) + "\"";
  }

  private static String jsonObjectFromHeaders(Headers headers) {
    StringBuilder out = new StringBuilder("{");
    boolean first = true;
    for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
      String name = entry.getKey();
      if (name == null) continue;
      String lower = name.toLowerCase();
      String value = String.join(", ", entry.getValue());
      if (lower.equals("authorization") || lower.equals("proxy-authorization") || lower.equals("cookie") || lower.equals("set-cookie") || lower.equals("x-api-key")) {
        value = "[redacted]";
      }
      if (!first) out.append(",");
      out.append(jsonString(name)).append(":").append(jsonString(value));
      first = false;
    }
    out.append("}");
    return out.toString();
  }

  private static boolean looksLikeJson(String value, String contentType) {
    String trimmed = value == null ? "" : value.trim();
    if (trimmed.isBlank()) return false;
    String type = contentType == null ? "" : contentType.toLowerCase();
    return type.contains("application/json") && (trimmed.startsWith("{") || trimmed.startsWith("["));
  }

  private static String jsonBody(String value, String contentType) {
    if (value == null || value.isBlank()) return "null";
    String trimmed = value.trim();
    return looksLikeJson(trimmed, contentType) ? trimmed : jsonString(value);
  }

  private static String responseText(byte[] body, String contentType) {
    if (body == null || body.length == 0) return "null";
    return jsonBody(new String(body, java.nio.charset.StandardCharsets.UTF_8), contentType);
  }

  private static String clientIp(HttpExchange exchange) {
    String forwarded = exchange.getRequestHeaders().getFirst("X-Forwarded-For");
    if (forwarded == null || forwarded.isBlank()) forwarded = exchange.getRequestHeaders().getFirst("x-forwarded-for");
    if (forwarded != null && !forwarded.isBlank()) return forwarded.split(",")[0].trim();
    String realIp = exchange.getRequestHeaders().getFirst("X-Real-Ip");
    if (realIp == null || realIp.isBlank()) realIp = exchange.getRequestHeaders().getFirst("x-real-ip");
    if (realIp != null && !realIp.isBlank()) return realIp.trim();
    return exchange.getRemoteAddress() != null && exchange.getRemoteAddress().getAddress() != null
      ? exchange.getRemoteAddress().getAddress().getHostAddress()
      : "";
  }

  private static void emitApiEvent(String level, String type, String tx, String method, String path, String clientIp, Headers headers, String requestBody, String requestContentType, Integer status, Long latencyMs, String responseBody, String error) {
    StringBuilder out = new StringBuilder("{");
    out.append("\"timestamp\":").append(jsonString(java.time.Instant.now().toString())).append(",");
    out.append("\"log_level\":").append(jsonString(level)).append(",");
    out.append("\"type\":").append(jsonString(type)).append(",");
    out.append("\"request_id\":").append(jsonString(tx));
    if (method != null) out.append(",\"method\":").append(jsonString(method));
    if (path != null) out.append(",\"path\":").append(jsonString(path));
    if (clientIp != null) out.append(",\"client_ip\":").append(jsonString(clientIp));
    if (headers != null) out.append(",\"headers\":").append(jsonObjectFromHeaders(headers));
    if (requestBody != null) out.append(",\"body\":").append(jsonBody(requestBody, requestContentType));
    if (status != null) out.append(",\"status_code\":").append(status);
    if (latencyMs != null) out.append(",\"latency_ms\":").append(latencyMs);
    if (responseBody != null) out.append(",\"response_body\":").append(responseBody);
    if (error != null && !error.isBlank()) out.append(",\"error\":").append(jsonString(error));
    out.append("}");
    System.out.println(out);
  }

  private static void applyCorsHeaders(HttpExchange exchange, Headers headers) {
    if ("false".equalsIgnoreCase(env("FPM_CORS_ENABLED", "true"))) return;
    String origin = corsOrigin(exchange);
    if (!origin.isBlank()) headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", env("FPM_CORS_METHODS", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"));
    String requestedHeaders = exchange.getRequestHeaders().getFirst("Access-Control-Request-Headers");
    headers.set("Access-Control-Allow-Headers", requestedHeaders == null || requestedHeaders.isBlank()
      ? env("FPM_CORS_HEADERS", "authorization,content-type,x-api-key")
      : requestedHeaders);
    headers.set("Access-Control-Max-Age", env("FPM_CORS_MAX_AGE", "86400"));
    if ("true".equalsIgnoreCase(env("FPM_CORS_ALLOW_CREDENTIALS", "false")) && !origin.isBlank() && !"*".equals(origin)) {
      headers.set("Access-Control-Allow-Credentials", "true");
    } else {
      headers.remove("Access-Control-Allow-Credentials");
    }
    headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  }

  private static String corsOrigin(HttpExchange exchange) {
    String requestOrigin = exchange.getRequestHeaders().getFirst("Origin");
    List<String> allowedOrigins = csvEnv("FPM_CORS_ORIGINS", "*");
    if (allowedOrigins.isEmpty() || allowedOrigins.contains("*")) {
      return "true".equalsIgnoreCase(env("FPM_CORS_ALLOW_CREDENTIALS", "false")) && requestOrigin != null && !requestOrigin.isBlank()
        ? requestOrigin
        : "*";
    }
    return requestOrigin != null && allowedOrigins.contains(requestOrigin) ? requestOrigin : "";
  }

  private static List<String> csvEnv(String key, String fallback) {
    List<String> values = new ArrayList<>();
    for (String part : env(key, fallback).split(",")) {
      String value = part.trim();
      if (!value.isBlank()) values.add(value);
    }
    return values;
  }

  private static URI upstreamUri(HttpExchange exchange) {
    String path = forwardPath(exchange);
    String query = exchange.getRequestURI().getRawQuery();
    String suffix = query == null || query.isBlank() ? "" : "?" + query;
    return URI.create("http://127.0.0.1:" + env("FPM_APP_PORT", "9090") + path + suffix);
  }

  private static String forwardPath(HttpExchange exchange) {
    String path = exchange.getRequestURI().getRawPath();
    String route = normalizePrefix(env("FPM_ROUTE_PATH", ""));
    if (!route.isBlank() && (path.equals(route) || path.startsWith(route + "/"))) {
      path = path.equals(route) ? "/" : path.substring(route.length());
      if (path.isBlank()) path = "/";
    }
    if (path.equals("/")) {
      String defaultPath = env("FPM_DEFAULT_" + exchange.getRequestMethod().toUpperCase() + "_PATH", "");
      if (!defaultPath.isBlank() && !defaultPath.equals("/")) path = defaultPath.startsWith("/") ? defaultPath : "/" + defaultPath;
    }
    return path;
  }

  private static String displayPath(HttpExchange exchange) {
    String query = exchange.getRequestURI().getRawQuery();
    return exchange.getRequestURI().getRawPath() + (query == null || query.isBlank() ? "" : "?" + query);
  }

  private static boolean isAuthorized(HttpExchange exchange) {
    if (!"true".equalsIgnoreCase(env("FPM_AUTH_REQUIRED", "false"))) return true;
    String header = env("FPM_AUTH_HEADER", "x-api-key");
    String provided = exchange.getRequestHeaders().getFirst(header);
    if (provided == null) provided = exchange.getRequestHeaders().getFirst(header.toLowerCase());
    return provided != null && authTokens().contains(provided);
  }

  private static List<String> authTokens() {
    String raw = env("FPM_AUTH_TOKENS", "[]");
    List<String> values = new ArrayList<>();
    Matcher matcher = Pattern.compile("\\"((?:\\\\\\\\.|[^\\"])*)\\"").matcher(raw);
    while (matcher.find()) values.add(matcher.group(1).replace("\\\\\\\"", "\\""));
    return values;
  }

  private static String normalizePrefix(String value) {
    String prefix = value == null ? "" : value.trim();
    while (prefix.endsWith("/") && prefix.length() > 1) prefix = prefix.substring(0, prefix.length() - 1);
    return prefix;
  }

  private static String env(String key, String fallback) {
    String value = System.getenv(key);
    return value == null || value.isBlank() ? fallback : value;
  }

  private static String escapeJson(String value) {
    return String.valueOf(value).replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"").replace("\\n", " ");
  }

  private static String preview(byte[] body) {
    if (body == null || body.length == 0) return "(empty)";
    String text = new String(body, java.nio.charset.StandardCharsets.UTF_8).replaceAll("\\s+", " ").trim();
    if (text.isBlank()) return "(empty)";
    return text.length() > 1000 ? text.substring(0, 1000) + "..." : text;
  }
}
`;

const DOTNET_GATEWAY_PROJECT = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>FpmGateway</AssemblyName>
  </PropertyGroup>
</Project>
`;

const DOTNET_GATEWAY_PROGRAM = `using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{Env("FPM_PORT", "8080")}");
var app = builder.Build();
var client = new HttpClient {
    Timeout = TimeSpan.FromSeconds(Math.Max(1, int.Parse(Env("FPM_TIMEOUT_SECONDS", "30"))) + 5)
};
var skippedHeaders = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "connection", "content-length", "host", "transfer-encoding", "upgrade"
};

string PreviewText(byte[]? body) {
    if (body == null || body.Length == 0) return "(empty)";
    var text = System.Text.Encoding.UTF8.GetString(body).Replace("\r", " ").Replace("\n", " ").Trim();
    if (string.IsNullOrWhiteSpace(text)) return "(empty)";
    return text.Length > 1000 ? text[..1000] + "..." : text;
}

object? ParseTransactionBody(string? text, string? contentType = null) {
    if (string.IsNullOrWhiteSpace(text)) return null;
    var trimmed = text.Trim();
    if ((contentType ?? "").Contains("application/json", StringComparison.OrdinalIgnoreCase) || trimmed.StartsWith("{") || trimmed.StartsWith("[")) {
        try {
            using var doc = JsonDocument.Parse(trimmed);
            return doc.RootElement.Clone();
        } catch {
        }
    }
    return text;
}

Dictionary<string, string> RedactHeaders(IHeaderDictionary headers) {
    var outHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var header in headers) {
        var value = header.Value.ToString();
        if (header.Key.Equals("authorization", StringComparison.OrdinalIgnoreCase) ||
            header.Key.Equals("proxy-authorization", StringComparison.OrdinalIgnoreCase) ||
            header.Key.Equals("cookie", StringComparison.OrdinalIgnoreCase) ||
            header.Key.Equals("set-cookie", StringComparison.OrdinalIgnoreCase) ||
            header.Key.Equals("x-api-key", StringComparison.OrdinalIgnoreCase)) {
            value = "[redacted]";
        }
        outHeaders[header.Key] = value;
    }
    return outHeaders;
}

string? ClientIp(HttpContext context) {
    var forwarded = context.Request.Headers["X-Forwarded-For"].FirstOrDefault();
    if (string.IsNullOrWhiteSpace(forwarded)) forwarded = context.Request.Headers["x-forwarded-for"].FirstOrDefault();
    if (!string.IsNullOrWhiteSpace(forwarded)) return forwarded.Split(',')[0].Trim();
    var realIp = context.Request.Headers["X-Real-Ip"].FirstOrDefault();
    if (string.IsNullOrWhiteSpace(realIp)) realIp = context.Request.Headers["x-real-ip"].FirstOrDefault();
    if (!string.IsNullOrWhiteSpace(realIp)) return realIp.Trim();
    return context.Connection.RemoteIpAddress?.ToString();
}

void EmitApiEvent(object payload) {
    Console.WriteLine(JsonSerializer.Serialize(payload));
}

app.Run(async context => {
    var started = Stopwatch.StartNew();
    var tx = Guid.NewGuid().ToString("N")[..12];
    var status = 500;
    var originalPath = DisplayPath(context);
    try {
        ApplyCors(context);
        byte[]? requestBody = null;
        var hasBody = context.Request.ContentLength.GetValueOrDefault() > 0 ||
            context.Request.Method.Equals("POST", StringComparison.OrdinalIgnoreCase) ||
            context.Request.Method.Equals("PUT", StringComparison.OrdinalIgnoreCase) ||
            context.Request.Method.Equals("PATCH", StringComparison.OrdinalIgnoreCase);
        if (hasBody) {
            using var requestBuffer = new MemoryStream();
            await context.Request.Body.CopyToAsync(requestBuffer, context.RequestAborted);
            requestBody = requestBuffer.ToArray();
            context.Request.Body = new MemoryStream(requestBody);
        }
        EmitApiEvent(new {
            timestamp = DateTime.UtcNow.ToString("O"),
            log_level = "INFO",
            type = "API_REQUEST",
            request_id = tx,
            method = context.Request.Method,
            path = originalPath,
            client_ip = ClientIp(context),
            headers = RedactHeaders(context.Request.Headers),
            body = ParseTransactionBody(requestBody == null ? null : System.Text.Encoding.UTF8.GetString(requestBody), context.Request.ContentType),
        });
        if (HttpMethods.Options.Equals(context.Request.Method, StringComparison.OrdinalIgnoreCase)) {
            status = 204;
            context.Response.StatusCode = status;
            EmitApiEvent(new {
                timestamp = DateTime.UtcNow.ToString("O"),
                log_level = "INFO",
                type = "API_RESPONSE",
                request_id = tx,
                status_code = status,
                latency_ms = started.ElapsedMilliseconds,
                response_body = (object?)null,
            });
            return;
        }
        if (!IsAuthorized(context)) {
            status = 401;
            Console.Error.WriteLine($"[auth] {context.Request.Method} {originalPath} missing_or_invalid_header {Env("FPM_AUTH_HEADER", "x-api-key").ToLowerInvariant()}");
            context.Response.StatusCode = status;
            context.Response.ContentType = "application/json";
            var responseBody = new { error = "Unauthorized" };
            await context.Response.WriteAsync(JsonSerializer.Serialize(responseBody));
            EmitApiEvent(new {
                timestamp = DateTime.UtcNow.ToString("O"),
                log_level = "WARNING",
                type = "API_RESPONSE",
                request_id = tx,
                status_code = status,
                latency_ms = started.ElapsedMilliseconds,
                response_body = responseBody,
                error = "auth_failed",
            });
            return;
        }

        using var upstream = new HttpRequestMessage(new HttpMethod(context.Request.Method), UpstreamUri(context));
        if (requestBody is not null && requestBody.Length > 0) {
            upstream.Content = new ByteArrayContent(requestBody);
        }
        foreach (var header in context.Request.Headers) {
            if (skippedHeaders.Contains(header.Key)) continue;
            if (!upstream.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray()) && upstream.Content != null) {
                upstream.Content.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
            }
        }

        using var response = await client.SendAsync(upstream, HttpCompletionOption.ResponseHeadersRead, context.RequestAborted);
        status = (int)response.StatusCode;
        var payload = await response.Content.ReadAsByteArrayAsync(context.RequestAborted);
        context.Response.StatusCode = status;
        foreach (var header in response.Headers) {
            if (!skippedHeaders.Contains(header.Key)) context.Response.Headers[header.Key] = header.Value.ToArray();
        }
        foreach (var header in response.Content.Headers) {
            if (!skippedHeaders.Contains(header.Key)) context.Response.Headers[header.Key] = header.Value.ToArray();
        }
        ApplyCors(context);
        await context.Response.Body.WriteAsync(payload, context.RequestAborted);
        EmitApiEvent(new {
            timestamp = DateTime.UtcNow.ToString("O"),
            log_level = status >= 500 ? "ERROR" : status >= 400 ? "WARNING" : "INFO",
            type = "API_RESPONSE",
            request_id = tx,
            status_code = status,
            latency_ms = started.ElapsedMilliseconds,
            response_body = ParseTransactionBody(System.Text.Encoding.UTF8.GetString(payload), response.Content.Headers.ContentType?.MediaType),
        });
    } catch (Exception error) {
        status = 502;
        Console.Error.WriteLine($"[gateway:error] {context.Request.Method} {originalPath} {error}");
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json";
        ApplyCors(context);
        var responseBody = new { error = "Upstream unavailable", detail = error.Message };
        await context.Response.WriteAsync(JsonSerializer.Serialize(responseBody));
        EmitApiEvent(new {
            timestamp = DateTime.UtcNow.ToString("O"),
            log_level = "ERROR",
            type = "API_RESPONSE",
            request_id = tx,
            status_code = status,
            latency_ms = started.ElapsedMilliseconds,
            response_body = responseBody,
            error = error.Message,
        });
    }
});

app.Run();

void ApplyCors(HttpContext context) {
    if (Env("FPM_CORS_ENABLED", "true").Equals("false", StringComparison.OrdinalIgnoreCase)) return;
    var origin = ResolveCorsOrigin(context);
    if (!string.IsNullOrWhiteSpace(origin)) context.Response.Headers["Access-Control-Allow-Origin"] = origin;
    context.Response.Headers["Access-Control-Allow-Methods"] = Env("FPM_CORS_METHODS", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
    var requestedHeaders = context.Request.Headers["Access-Control-Request-Headers"].FirstOrDefault();
    context.Response.Headers["Access-Control-Allow-Headers"] = string.IsNullOrWhiteSpace(requestedHeaders)
        ? Env("FPM_CORS_HEADERS", "authorization,content-type,x-api-key")
        : requestedHeaders;
    context.Response.Headers["Access-Control-Max-Age"] = Env("FPM_CORS_MAX_AGE", "86400");
    if (Env("FPM_CORS_ALLOW_CREDENTIALS", "false").Equals("true", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(origin) && origin != "*") {
        context.Response.Headers["Access-Control-Allow-Credentials"] = "true";
    } else {
        context.Response.Headers.Remove("Access-Control-Allow-Credentials");
    }
    context.Response.Headers["Vary"] = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
}

string ResolveCorsOrigin(HttpContext context) {
    var requestOrigin = context.Request.Headers["Origin"].FirstOrDefault();
    var allowedOrigins = Env("FPM_CORS_ORIGINS", "*")
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (allowedOrigins.Length == 0 || allowedOrigins.Contains("*")) {
        return Env("FPM_CORS_ALLOW_CREDENTIALS", "false").Equals("true", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(requestOrigin)
            ? requestOrigin
            : "*";
    }
    return !string.IsNullOrWhiteSpace(requestOrigin) && allowedOrigins.Contains(requestOrigin) ? requestOrigin : "";
}

string UpstreamUri(HttpContext context) {
    var path = ForwardPath(context);
    var query = context.Request.QueryString.HasValue ? context.Request.QueryString.Value : "";
    return $"http://127.0.0.1:{Env("FPM_APP_PORT", "9090")}{path}{query}";
}

string ForwardPath(HttpContext context) {
    var path = context.Request.Path.HasValue ? context.Request.Path.Value! : "/";
    var route = NormalizePrefix(Env("FPM_ROUTE_PATH", ""));
    if (!string.IsNullOrWhiteSpace(route) && (path.Equals(route, StringComparison.OrdinalIgnoreCase) || path.StartsWith(route + "/", StringComparison.OrdinalIgnoreCase))) {
        path = path.Equals(route, StringComparison.OrdinalIgnoreCase) ? "/" : path[route.Length..];
        if (string.IsNullOrWhiteSpace(path)) path = "/";
    }
    if (path == "/") {
        var defaultPath = Env($"FPM_DEFAULT_{context.Request.Method.ToUpperInvariant()}_PATH", "");
        if (!string.IsNullOrWhiteSpace(defaultPath) && defaultPath != "/") path = defaultPath.StartsWith("/") ? defaultPath : "/" + defaultPath;
    }
    return path;
}

string DisplayPath(HttpContext context) {
    return (context.Request.Path.HasValue ? context.Request.Path.Value : "/") + (context.Request.QueryString.HasValue ? context.Request.QueryString.Value : "");
}

bool IsAuthorized(HttpContext context) {
    if (!Env("FPM_AUTH_REQUIRED", "false").Equals("true", StringComparison.OrdinalIgnoreCase)) return true;
    var header = Env("FPM_AUTH_HEADER", "x-api-key");
    var provided = context.Request.Headers[header].FirstOrDefault();
    return provided != null && AuthTokens().Contains(provided);
}

HashSet<string> AuthTokens() {
    try {
        return JsonSerializer.Deserialize<string[]>(Env("FPM_AUTH_TOKENS", "[]"))?.ToHashSet() ?? new();
    } catch {
        return new();
    }
}

string NormalizePrefix(string value) {
    var prefix = value.Trim();
    while (prefix.EndsWith("/") && prefix.Length > 1) prefix = prefix[..^1];
    return prefix;
}

string Env(string key, string fallback) {
    var value = Environment.GetEnvironmentVariable(key);
    return string.IsNullOrWhiteSpace(value) ? fallback : value;
}
`;

const NODE_DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY . .
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
EXPOSE 8080
CMD ["node","server.mjs"]
`;

const DENO_DOCKERFILE = `FROM denoland/deno:alpine-2.1.4
WORKDIR /app
COPY . .
EXPOSE 8000
CMD ["run","--allow-net","--allow-env","--allow-read","server.ts"]
`;

const PYTHON_DOCKERFILE = `FROM python:3.11-alpine
WORKDIR /app
COPY . .
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi
EXPOSE 8080
CMD ["python","server.py"]
`;

const JAVA_SPRING_DOCKERFILE = `FROM maven:3.9-eclipse-temurin-21-alpine AS build
WORKDIR /src
COPY . .
RUN mvn -q -DskipTests package
RUN javac --add-modules jdk.httpserver -d /gateway fpm-gateway/FpmGateway.java

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=build /src/target/*.jar /app/app.jar
COPY --from=build /gateway /gateway
EXPOSE 8080
ENTRYPOINT ["sh","-c","APP_PORT=\${FPM_APP_PORT:-9090}; java -jar /app/app.jar --server.port=$APP_PORT & exec java --add-modules jdk.httpserver -cp /gateway FpmGateway"]
`;

const DOTNET_DOCKERFILE = `FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /out
RUN dotnet publish fpm-gateway/FpmGateway.csproj -c Release -o /gateway

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
COPY --from=build /gateway /gateway
EXPOSE 8080
ENTRYPOINT ["sh","-c","APP_PORT=\${FPM_APP_PORT:-9090}; APP_DLL=$(find /app -maxdepth 1 -name '*.dll' | head -n 1); ASPNETCORE_URLS=http://0.0.0.0:$APP_PORT dotnet $APP_DLL & exec dotnet /gateway/FpmGateway.dll"]
`;

function functionEnv(fn, secrets, deployVersion, { port = null } = {}) {
  const tokens = Array.isArray(fn.api_tokens) ? fn.api_tokens.map((token) => token.value).filter(Boolean) : [];
  const firstToken = tokens[0] || "";
  const tokensJson = JSON.stringify(tokens);
  const tokensCsv = tokens.join(",");
  const secretKeys = new Set(secrets.map((secret) => String(secret.key || "").toUpperCase()));
  const defaultRoutes = defaultUpstreamPaths(fn);
  return [
    ...secrets.map((s) => `${s.key}=${s.value}`),
    `FPM_FUNCTION_ID=${fn.id}`,
    `FPM_PROJECT_ID=${fn.project_id || ""}`,
    `FPM_ENVIRONMENT=${fn.environment_slug || ""}`,
    `FPM_DEPLOY_VERSION=${deployVersion}`,
    `FPM_ROUTE_PATH=${routePath(fn, deployVersion)}`,
    ...(port ? [`FPM_PORT=${port}`] : []),
    `FPM_TIMEOUT_SECONDS=${Math.max(1, Number(fn.timeout_seconds || 30))}`,
    `FPM_MEMORY_MB=${Math.max(1, Number(fn.memory_mb || 256))}`,
    `FPM_AUTH_REQUIRED=${fn.auth_required ? "true" : "false"}`,
    `FPM_AUTH_HEADER=${fn.auth_header_name || "x-api-key"}`,
    `FPM_AUTH_TOKENS=${tokensJson}`,
    `FPM_AUTH_TOKENS_CSV=${tokensCsv}`,
    ...inheritedCorsEnvStrings(),
    ...Object.entries(defaultRoutes).map(([method, path]) => `FPM_DEFAULT_${method}_PATH=${path}`),
    `FPM_API_KEY=${firstToken}`,
    `FPM_API_KEYS=${tokensJson}`,
    `FPM_API_KEYS_CSV=${tokensCsv}`,
    ...(!secretKeys.has("API_KEY") && firstToken ? [`API_KEY=${firstToken}`] : []),
    ...(!secretKeys.has("API_KEYS") && tokens.length ? [`API_KEYS=${tokensJson}`] : []),
    ...(!secretKeys.has("API_KEYS_CSV") && tokens.length ? [`API_KEYS_CSV=${tokensCsv}`] : []),
  ];
}

async function writeSourceFiles(dir, files) {
  for (const file of files) {
    const target = join(dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

export async function prepareFunctionBuildContext(fn) {
  const source = normalizeFunctionSource(fn);
  const dir = join(WORKDIR, safeId(fn.id), versionKey(fn.deploy_version || "v1"));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeSourceFiles(dir, source.files);

  if (source.runtime === "custom") {
    const dockerfile = source.files.find((file) => /^dockerfile$/i.test(file.path.split("/").pop() || ""));
    if (!dockerfile) {
      throw new Error("Custom runtime requires a Dockerfile in the function source.");
    }
    if (!looksLikeDockerfile(dockerfile.content)) {
      throw new Error("Custom runtime requires a valid Dockerfile. The current Dockerfile file looks like application code.");
    }
  } else if (source.runtime === "deno") {
    await writeFile(join(dir, "server.ts"), denoRunner(source.entrypoint, denoSelfServes(source)));
    await writeFile(join(dir, "Dockerfile"), DENO_DOCKERFILE);
  } else if (source.runtime === "python311") {
    await writeFile(join(dir, "server.py"), pythonRunner(source.entrypoint));
    await writeFile(join(dir, "Dockerfile"), PYTHON_DOCKERFILE);
  } else if (source.runtime === "java-spring") {
    await mkdir(join(dir, "fpm-gateway"), { recursive: true });
    await writeFile(join(dir, "fpm-gateway", "FpmGateway.java"), JAVA_GATEWAY);
    await writeFile(join(dir, "Dockerfile"), JAVA_SPRING_DOCKERFILE);
  } else if (source.runtime === "dotnet8") {
    await mkdir(join(dir, "fpm-gateway"), { recursive: true });
    await writeFile(join(dir, "fpm-gateway", "FpmGateway.csproj"), DOTNET_GATEWAY_PROJECT);
    await writeFile(join(dir, "fpm-gateway", "Program.cs"), DOTNET_GATEWAY_PROGRAM);
    await writeFile(join(dir, "Dockerfile"), DOTNET_DOCKERFILE);
  } else {
    await writeFile(join(dir, "server.mjs"), nodeRunner(source.entrypoint));
    await writeFile(join(dir, "Dockerfile"), NODE_DOCKERFILE);
  }
  return { dir, source };
}

export async function buildFunctionImage(fn, tag = imageName(fn.id, fn.deploy_version || "v1")) {
  const { dir } = await prepareFunctionBuildContext(fn);
  await new Promise((resolve, reject) => {
    const p = spawn("docker", ["build", "-t", tag, "."], { cwd: dir });
    let output = "";
    const record = (chunk, target) => {
      const text = chunk.toString();
      output += text;
      if (output.length > 12000) output = output.slice(-12000);
      target.write(chunk);
    };
    p.stdout.on("data", (d) => record(d, process.stdout));
    p.stderr.on("data", (d) => record(d, process.stderr));
    p.on("error", reject);
    p.on("exit", (c) => {
      if (c === 0) {
        resolve();
        return;
      }
      const tail = output.split(/\r?\n/).filter(Boolean).slice(-40).join("\n");
      reject(new Error(`docker build failed${tail ? `:\n${tail}` : ""}`));
    });
  });
}

export async function stopAndRemove(id, version = null) {
  try {
    if (version) {
      const c = docker.getContainer(containerName(id, version));
      await c.remove({ force: true });
      return;
    }
    const containers = await docker.listContainers({ all: true });
    for (const info of containers) {
      if (info.Labels?.["fpm.function.id"] === id) {
        await docker.getContainer(info.Id).remove({ force: true });
      }
    }
  } catch {}
}

async function inspectHostPort(id, version, internalPort) {
  try {
    const c = docker.getContainer(containerName(id, version));
    const info = await c.inspect();
    return info.NetworkSettings?.Ports?.[`${internalPort}/tcp`]?.[0]?.HostPort || "";
  } catch {
    return "";
  }
}

function hostPortFromUrl(fn, deployVersion) {
  try {
    if (normalizeDeployVersion(fn.active_deploy_version || "v1") !== deployVersion) return "";
    const url = fn.url ? new URL(fn.url) : null;
    return url?.port || "";
  } catch {
    return "";
  }
}

async function createFunctionContainer(fn, env, deployVersion, hostPort = "") {
  const internalPort = runtimePort(fn);
  const hostConfig = {
    RestartPolicy: { Name: "unless-stopped" },
    PortBindings: { [`${internalPort}/tcp`]: [{ HostIp: "0.0.0.0", HostPort: hostPort || "" }] },
  };
  if (fn.memory_mb) hostConfig.Memory = Number(fn.memory_mb) * 1024 * 1024;

  return docker.createContainer({
    name: containerName(fn.id, deployVersion),
    Image: imageName(fn.id, deployVersion),
    Env: env,
    ExposedPorts: { [`${internalPort}/tcp`]: {} },
    Labels: {
      "fpm.function.id": fn.id,
      "fpm.project.id": fn.project_id || "",
      "fpm.environment": fn.environment_slug || "",
      "fpm.version": deployVersion,
    },
    HostConfig: hostConfig,
  });
}

function cleanDockerLogLine(line) {
  return String(line || "").replace(/[\u0000-\u0008\u000B-\u001F]/g, "").trim();
}

function decodeDockerLogBuffer(buffer) {
  let offset = 0;
  let text = "";
  while (offset < buffer.length) {
    const streamType = buffer[offset];
    const looksMultiplexed =
      (streamType === 1 || streamType === 2) &&
      buffer.length >= offset + 8 &&
      buffer[offset + 1] === 0 &&
      buffer[offset + 2] === 0 &&
      buffer[offset + 3] === 0;
    if (!looksMultiplexed) {
      text += buffer.subarray(offset).toString("utf8");
      offset = buffer.length;
      break;
    }
    const size = buffer.readUInt32BE(offset + 4);
    if (buffer.length < offset + 8 + size) break;
    text += buffer.subarray(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
  }
  return { text, rest: buffer.subarray(offset) };
}

function parseDockerLogEntries(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(cleanDockerLogLine)
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.*)$/.exec(line);
      return match ? { ts: match[1], message: match[2] } : { message: line };
    });
}

async function outputToText(output) {
  if (Buffer.isBuffer(output)) return decodeDockerLogBuffer(output).text;
  if (typeof output === "string") return output;
  if (!output || typeof output.on !== "function") return String(output || "");
  const chunks = [];
  for await (const chunk of output) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function buildAndDeploy(fn, secrets, { version = "v1" } = {}) {
  const deployVersion = normalizeDeployVersion(version);
  const internalPort = runtimePort(fn);
  const previousHostPort =
    (await inspectHostPort(fn.id, deployVersion, internalPort)) ||
    hostPortFromUrl(fn, deployVersion);

  await buildFunctionImage({ ...fn, deploy_version: deployVersion }, imageName(fn.id, deployVersion));
  await stopAndRemove(fn.id, deployVersion);

  const env = functionEnv(fn, secrets, deployVersion);
  let container = await createFunctionContainer(fn, env, deployVersion, previousHostPort);
  try {
    await container.start();
  } catch (error) {
    try {
      await container.remove({ force: true });
    } catch {}
    if (!previousHostPort) throw error;
    container = await createFunctionContainer(fn, env, deployVersion, "");
    await container.start();
  }
  const info = await container.inspect();
  const hostPort = info.NetworkSettings?.Ports?.[`${internalPort}/tcp`]?.[0]?.HostPort;
  if (!hostPort) throw new Error("Docker did not assign a public port to the function container");

  const url = withRoutePath(`http://${PUBLIC_HOST}:${hostPort}`, fn, deployVersion);
  return { containerId: container.id, url };
}

export async function readContainerLogHistory(id, { version = "v1", tail = 300 } = {}) {
  try {
    const c = docker.getContainer(containerName(id, version));
    const output = await c.logs({ follow: false, stdout: true, stderr: true, tail, timestamps: true });
    return parseDockerLogEntries(await outputToText(output));
  } catch {
    return [];
  }
}

export async function streamLogs(id, onLine, { version = "v1" } = {}) {
  const c = docker.getContainer(containerName(id, version));
  const stream = await c.logs({ follow: true, stdout: true, stderr: true, tail: 200, timestamps: true });
  let buf = "";
  let frameBuf = Buffer.alloc(0);
  const onData = (chunk) => {
    frameBuf = Buffer.concat([frameBuf, Buffer.from(chunk)]);
    const decoded = decodeDockerLogBuffer(frameBuf);
    frameBuf = decoded.rest;
    const text = decoded.text;
    if (!text) return;
    buf += text;
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const clean = cleanDockerLogLine(line);
      if (clean) {
        appendLog({ function_id: id, message: clean }).catch(() => {});
        onLine(clean);
      }
    }
  };
  stream.on("data", onData);
  stream.on("error", () => {});
  return () => {
    try {
      stream.destroy();
    } catch {}
  };
}

import { spawn } from "child_process";
import { createHash } from "node:crypto";
import dns from "node:dns";
import { readFile } from "fs/promises";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import https from "node:https";
import net from "node:net";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { buildFunctionImage, getDockerStatus, prepareFunctionBuildContext } from "./docker.js";
import { slugify } from "./db.js";
import { defaultUpstreamPaths, normalizeDeployVersion, routePath, withRoutePath } from "./functionSource.js";

const ARM_API_VERSION = "2023-05-01";
const ACR_API_VERSION = "2019-06-01-preview";
const CONTAINER_APP_ACTION_API_VERSION = "2024-03-01";
const PROVISIONING_STEPS = [
  { id: "validate", label: "Validar configuracion", percent: 8 },
  { id: "auth", label: "Autenticar con Azure", percent: 18 },
  { id: "managed-environment", label: "Crear o validar Managed Environment", percent: 45 },
  { id: "container-app", label: "Crear o actualizar Container App base", percent: 75 },
  { id: "fqdn", label: "Obtener URL publica", percent: 92 },
  { id: "complete", label: "Guardar resultado", percent: 100 },
];
const CORS_ENV_KEYS = [
  "FPM_CORS_ENABLED",
  "FPM_CORS_ORIGINS",
  "FPM_CORS_METHODS",
  "FPM_CORS_HEADERS",
  "FPM_CORS_MAX_AGE",
  "FPM_CORS_ALLOW_CREDENTIALS",
];
const AZURE_CONSUMPTION_MAX_CPU = 2;
const AZURE_CONSUMPTION_MAX_MEMORY_MB = 4096;
const AZURE_FUNCTIONS_PER_CONTAINER_APP = 7;
const PLATFORM_SOURCE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PLATFORM_BUNDLED_SOURCE_ROOT = "/platform-source";

function inheritedCorsEnvValues() {
  return CORS_ENV_KEYS
    .filter((key) => process.env[key] != null)
    .map((key) => ({ name: key, value: process.env[key] }));
}

dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily?.(false);

function httpsRequestText(url, { method = "GET", headers = {}, body = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers,
      family: 4,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          text,
        });
      });
    });

    req.on("timeout", () => req.destroy(new Error(`Request timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function run(command, args, { input, timeoutMs = 20 * 60 * 1000, onOutput, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000).unref?.();
    }, timeoutMs) : null;
    const record = (chunk, target) => {
      const text = chunk.toString();
      target === "stdout" ? stdout += text : stderr += text;
      onOutput?.(text, target);
    };
    child.stdout?.on("data", (chunk) => record(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => record(chunk, "stderr"));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const output = `${stdout}${stderr}`.trim();
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} excedio ${Math.round(timeoutMs / 1000)}s y fue detenido.${output ? `\n${output.split(/\r?\n/).filter(Boolean).slice(-80).join("\n")}` : ""}`));
        return;
      }
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim(), output });
      else reject(new Error(output || `${command} exited with code ${code}`));
    });
    if (input) child.stdin?.end(input);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(target, fields) {
  const missing = fields.filter((field) => !String(target[field] || "").trim());
  if (missing.length) throw new Error(`Falta configurar: ${missing.join(", ")}`);
}

function baseProvisioningSteps() {
  return PROVISIONING_STEPS.map((step) => ({ ...step, status: "pending", message: "" }));
}

function mergeProvisioningStep(steps, update) {
  const next = steps?.length ? steps.map((step) => ({ ...step })) : baseProvisioningSteps();
  const index = next.findIndex((step) => step.id === update.id);
  if (index >= 0) {
    next[index] = { ...next[index], ...update };
  }
  return next;
}

async function reportProvisioning(onProgress, steps, update) {
  const nextSteps = mergeProvisioningStep(steps, update);
  const current = nextSteps.find((step) => step.id === update.id) || update;
  await onProgress?.({
    status: update.status === "failed" ? "failed" : update.status === "success" && update.id === "complete" ? "success" : "running",
    step: current.id,
    percent: current.percent,
    error: update.status === "failed" ? update.message : null,
    steps: nextSteps,
  });
  return nextSteps;
}

function targetContainerAppName(target) {
  return slugify(target.container_app_name_prefix || target.container_app_environment || target.environment_slug || "fpm").slice(0, 32).replace(/-$/, "");
}

function containerAppShardName(baseName, index = 0) {
  const base = slugify(baseName || "fpm").slice(0, 32).replace(/-$/, "") || "fpm";
  if (!index) return base;
  const suffix = `-${index + 1}`;
  const room = Math.max(1, 32 - suffix.length);
  const trimmed = base.slice(0, room).replace(/-+$/, "") || "fpm";
  return `${trimmed}${suffix}`.slice(0, 32).replace(/-$/, "");
}

export function azureShardCountForFunctionCount(functionCount = 0) {
  const functions = Math.max(0, Number(functionCount || 0));
  return 1 + Math.ceil(functions / AZURE_FUNCTIONS_PER_CONTAINER_APP);
}

export function azureContainerAppShardNamesForTarget(target, shardCount = 1) {
  const baseName = target?.azure_container_app_name || targetContainerAppName(target || {});
  return Array.from({ length: Math.max(1, Number(shardCount || 1)) }, (_, index) => containerAppShardName(baseName, index));
}

export function targetProvisioningSignature(target) {
  return JSON.stringify({
    subscription: target.azure_subscription_id || "",
    resourceGroup: target.azure_resource_group || "",
    location: target.azure_location || "",
    managedEnvironment: target.container_app_environment || "",
    appName: targetContainerAppName(target),
  });
}

export function isAzureTargetProvisioned(target) {
  return Boolean(
    target?.azure_container_app_url &&
    target?.azure_container_app_name &&
    target?.azure_container_config_hash === targetProvisioningSignature(target)
  );
}

export function azureProvisioningRequiredMessage(target) {
  const env = target?.environment_name || target?.environment_slug || "este ambiente";
  return `Antes de desplegar en Azure automatico debes crear el Container App base para ${env}. Ve a Container Apps, pulsa "Crear en Azure" y espera a que Azure devuelva la URL del contenedor.`;
}

function describeNetworkError(error, service) {
  const cause = error?.cause;
  const code = cause?.code || cause?.name || "";
  const nestedCodes = Array.isArray(cause?.errors)
    ? [...new Set(cause.errors.map((item) => item?.code).filter(Boolean))]
    : [];
  const nestedAddresses = Array.isArray(cause?.errors)
    ? [...new Set(cause.errors.map((item) => item?.address).filter(Boolean))]
    : [];
  const detail = cause?.message || nestedCodes.join(", ") || error?.message || String(error);
  if (code === "ENETUNREACH" || nestedCodes.includes("ENETUNREACH")) {
    const ipv6Only = nestedAddresses.length > 0 && nestedAddresses.every((address) => String(address).includes(":"));
    const detailLooksIpv6 = /[a-f0-9]{0,4}:[a-f0-9:]+/i.test(detail);
    return ipv6Only || detailLooksIpv6
      ? `No se pudo conectar con ${service}: el contenedor Docker esta resolviendo direcciones IPv6 para Azure, pero no tiene ruta IPv6 disponible. Fuerza salida IPv4 o habilita IPv6 en Docker Desktop.`
      : `No se pudo conectar con ${service}: no hay ruta de red disponible desde el contenedor Docker (${detail}).`;
  }
  if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || /verify.*leaf|certificate|cert/i.test(detail)) {
    return `No se pudo conectar con ${service} porque Node no puede validar el certificado TLS (${code || detail}). Carga la CA corporativa/intermedia con NODE_EXTRA_CA_CERTS o ejecuta el API con certificados de confianza actualizados.`;
  }
  if (/fetch failed/i.test(error?.message || "") && detail) {
    return `No se pudo conectar con ${service}: ${detail}`;
  }
  return `No se pudo conectar con ${service}: ${error?.message || String(error)}`;
}

function imageRef(fn, target, version = "v1") {
  const registry = String(target.acr_login_server || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const project = slugify(target.project_slug || target.project_name || "project");
  const tag = `${normalizeDeployVersion(version)}-${Date.now()}`;
  return `${registry}/${project}/${slugify(fn.slug)}:${tag}`;
}

function platformSourceRoot() {
  return resolve(process.env.FPM_PLATFORM_ROOT || process.env.PLATFORM_ROOT || PLATFORM_SOURCE_ROOT);
}

function platformAppName(target, kind) {
  const suffix = `-${kind}`;
  const rawBase = target.container_app_name_prefix ||
    `${target.project_slug || target.project_name || "fpm"}-${target.environment_slug || target.environment_name || "env"}`;
  const base = slugify(rawBase).slice(0, Math.max(1, 32 - suffix.length)).replace(/-+$/g, "") || "fpm";
  return `${base}${suffix}`.slice(0, 32).replace(/-+$/g, "") || `fpm-${kind}`;
}

function platformVersionTag(version = "1.0.0") {
  return String(version || "1.0.0")
    .trim()
    .replace(/^v/i, "")
    .replace(/[^0-9A-Za-z._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "1.0.0";
}

export function platformSyncToken(target = {}) {
  const explicit = process.env.FPM_PLATFORM_SYNC_TOKEN || "";
  if (explicit) return explicit;
  const material = explicit || [
    target.azure_subscription_id || "",
    target.azure_resource_group || "",
    target.container_app_environment || "",
    target.azure_client_id || "",
    target.azure_client_secret || "",
  ].join(":");
  return createHash("sha256").update(material || "function-platform-sync").digest("hex");
}

function platformImageRef(target, kind, version = "1.0.0") {
  const registry = String(target.acr_login_server || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const project = slugify(target.project_slug || target.project_name || "platform");
  const env = slugify(target.environment_slug || target.environment_name || "env");
  return `${registry}/${project}/platform-${kind}:${env}-${platformVersionTag(version)}-${Date.now()}`;
}

async function assertPlatformSource(root) {
  const apiDir = resolve(root, "api");
  const webDir = resolve(root, "web");
  try {
    await Promise.all([
      access(resolve(apiDir, "Dockerfile")),
      access(resolve(webDir, "Dockerfile")),
    ]);
  } catch {
    throw new Error(`No se encontro el codigo fuente de api/ y web/ en ${root}. Si el API corre en Docker, monta el repo y configura FPM_PLATFORM_ROOT.`);
  }
  return { apiDir, webDir };
}

function platformStoreMode() {
  return process.env.DATA_STORE || (process.env.DATABASE_URL ? "postgres" : "file");
}

function isFileStoreMode() {
  return platformStoreMode() === "file";
}

function readEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value && String(value).trim()) return String(value).trim();
  }
  return "";
}

function authEnvironmentValues(redirectUri = "") {
  const authUrl = readEnv("AUTH_URL", "NEXT_PUBLIC_AUTH_URL", "VITE_AUTH_URL") || "https://auth.sendcraft.net";
  const appId = readEnv("AUTH_APP_ID", "NEXT_PUBLIC_AUTH_APP_ID", "VITE_AUTH_APP_ID");
  const publicApiKey = readEnv("AUTH_PUBLIC_API_KEY", "NEXT_PUBLIC_AUTH_PUBLIC_API_KEY", "VITE_AUTH_PUBLIC_API_KEY");
  const validateToken = readEnv("AUTH_VALIDATE_TOKEN", "NEXT_PUBLIC_AUTH_VALIDATE_TOKEN", "VITE_AUTH_VALIDATE_TOKEN");
  const integrationKey = readEnv("AUTH_API_KEY", "NEXT_PUBLIC_AUTH_API_KEY", "VITE_AUTH_API_KEY");

  const plain = [];
  const secret = [];
  const addPlain = (name, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") plain.push({ name, value: String(value) });
  };
  const addSecret = (name, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      secret.push({
        name,
        secretName: safeAzureSecretName(`platform-auth-${name}`),
        value: String(value),
      });
    }
  };

  addPlain("AUTH_URL", authUrl);
  addPlain("NEXT_PUBLIC_AUTH_URL", authUrl);
  addPlain("VITE_AUTH_URL", authUrl);
  addPlain("AUTH_APP_ID", appId);
  addPlain("NEXT_PUBLIC_AUTH_APP_ID", appId);
  addPlain("VITE_AUTH_APP_ID", appId);
  addPlain("AUTH_PUBLIC_API_KEY", publicApiKey);
  addPlain("NEXT_PUBLIC_AUTH_PUBLIC_API_KEY", publicApiKey);
  addPlain("VITE_AUTH_PUBLIC_API_KEY", publicApiKey);

  if (redirectUri) {
    addPlain("AUTH_REDIRECT_URI", redirectUri);
    addPlain("NEXT_PUBLIC_AUTH_REDIRECT_URI", redirectUri);
    addPlain("VITE_REDIRECT_URI", redirectUri);
  }

  addSecret("AUTH_VALIDATE_TOKEN", validateToken);
  addSecret("AUTH_API_KEY", integrationKey);

  return { plain, secret };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(source, target, options = {}) {
  if (await pathExists(source)) {
    await cp(source, target, options);
    return true;
  }
  return false;
}

async function copyPlatformSourceBundle(sourceRoot, contextDir) {
  const bundleRoot = resolve(contextDir, "platform-source");
  const apiSource = resolve(sourceRoot, "api");
  const webSource = resolve(sourceRoot, "web");
  const apiTarget = resolve(bundleRoot, "api");
  const webTarget = resolve(bundleRoot, "web");
  await mkdir(apiTarget, { recursive: true });
  await mkdir(webTarget, { recursive: true });

  for (const file of ["package.json", "package-lock.json", "Dockerfile", ".dockerignore"]) {
    await copyIfExists(resolve(apiSource, file), resolve(apiTarget, file));
  }
  await copyIfExists(resolve(apiSource, "src"), resolve(apiTarget, "src"), { recursive: true });

  for (const file of ["package.json", "package-lock.json", "Dockerfile", ".dockerignore", "next.config.js", "postcss.config.js", "tailwind.config.js", "tsconfig.json", "next-env.d.ts"]) {
    await copyIfExists(resolve(webSource, file), resolve(webTarget, file));
  }
  await copyIfExists(resolve(webSource, "src"), resolve(webTarget, "src"), { recursive: true });
  await copyIfExists(resolve(webSource, "public"), resolve(webTarget, "public"), { recursive: true });
  await copyIfExists(resolve(sourceRoot, "certs"), resolve(bundleRoot, "certs"), { recursive: true });
  await copyIfExists(resolve(sourceRoot, "data"), resolve(bundleRoot, "data"), { recursive: true });
}

async function preparePlatformApiContext(sourceRoot, apiDir) {
  if (!isFileStoreMode()) {
    return { contextDir: apiDir, cleanup: async () => {}, dataFile: process.env.DATA_FILE || "" };
  }

  const contextDir = await mkdtemp(join(tmpdir(), "fpm-platform-api-"));
  await cp(resolve(apiDir, "package.json"), resolve(contextDir, "package.json"));
  if (await pathExists(resolve(apiDir, "package-lock.json"))) {
    await cp(resolve(apiDir, "package-lock.json"), resolve(contextDir, "package-lock.json"));
  }
  await cp(resolve(apiDir, "src"), resolve(contextDir, "src"), { recursive: true });

  const dataSource = resolve(sourceRoot, "data");
  const certsSource = resolve(sourceRoot, "certs");
  const dataTarget = resolve(contextDir, "data");
  const certsTarget = resolve(contextDir, "certs");

  const runtimeDataFile = process.env.DATA_FILE || "";
  if (runtimeDataFile && await pathExists(runtimeDataFile)) {
    await mkdir(dataTarget, { recursive: true });
    await cp(runtimeDataFile, resolve(dataTarget, "function-platform.json"));
  } else if (await pathExists(dataSource)) {
    await cp(dataSource, dataTarget, { recursive: true });
  } else {
    await mkdir(dataTarget, { recursive: true });
    await writeFile(resolve(dataTarget, ".keep"), "");
  }

  if (await pathExists(certsSource)) {
    await cp(certsSource, certsTarget, { recursive: true });
  } else {
    await mkdir(certsTarget, { recursive: true });
    await writeFile(resolve(certsTarget, ".keep"), "");
  }

  await copyPlatformSourceBundle(sourceRoot, contextDir);

  await writeFile(resolve(contextDir, "Dockerfile"), `FROM node:20-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY data /data
COPY certs /certs
COPY platform-source ${PLATFORM_BUNDLED_SOURCE_ROOT}
ENV DATA_STORE=file
ENV DATA_FILE=/data/function-platform.json
ENV FPM_PLATFORM_ROOT=${PLATFORM_BUNDLED_SOURCE_ROOT}
EXPOSE 4000
CMD ["node", "src/index.js"]
`);

  return {
    contextDir,
    cleanup: () => rm(contextDir, { recursive: true, force: true }),
    dataFile: "/data/function-platform.json",
  };
}

function emitOutputLines(text, onProgress, step, percent) {
  if (!onProgress || !text) return;
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const interesting = lines.filter((line) =>
    /error|failed|denied|unauthorized|pushed|digest|writing image|exporting|naming to|DONE|#[0-9]+|=>/i.test(line)
  );
  for (const line of interesting.slice(-8)) {
    void Promise.resolve(onProgress({ step, percent, status: "running", message: line })).catch(() => {});
  }
}

async function buildAndPushPlatformImage({ contextDir, image, buildArgs = {}, kind = "imagen", onProgress = null, buildMode = "docker-local", target = null, token = null }) {
  if (buildMode === "acr-remote") {
    return buildImageInAcr({
      contextDir,
      image,
      target,
      token,
      buildArgs,
      kind,
      onProgress,
      startPercent: kind === "api" ? 26 : 68,
      pollPercent: kind === "api" ? 34 : 76,
      donePercent: kind === "api" ? 44 : 84,
    });
  }

  const args = ["build", "-t", image];
  for (const [key, value] of Object.entries(buildArgs)) {
    if (value !== undefined && value !== null) {
      args.push("--build-arg", `${key}=${value}`);
    }
  }
  args.push(".");
  await onProgress?.({ step: `build-${kind}`, percent: kind === "api" ? 28 : 68, status: "running", message: `Construyendo imagen ${kind}: ${image}` });
  await run("docker", args, {
    cwd: contextDir,
    timeoutMs: 30 * 60 * 1000,
    onOutput: (text) => emitOutputLines(text, onProgress, `build-${kind}`, kind === "api" ? 34 : 74),
  });
  await onProgress?.({ step: `push-${kind}`, percent: kind === "api" ? 38 : 78, status: "running", message: `Subiendo imagen ${kind} al ACR` });
  await run("docker", ["push", image], {
    timeoutMs: 20 * 60 * 1000,
    onOutput: (text) => emitOutputLines(text, onProgress, `push-${kind}`, kind === "api" ? 42 : 82),
  });
  await onProgress?.({ step: `push-${kind}`, percent: kind === "api" ? 44 : 84, status: "success", message: `Imagen ${kind} publicada en ACR` });
  return { image };
}

function safeAzureSecretName(value, maxLength = 63) {
  const hash = createHash("sha1").update(String(value || "secret")).digest("hex").slice(0, 8);
  const base = slugify(value).replace(/^-+|-+$/g, "") || "secret";
  const room = Math.max(1, maxLength - hash.length - 1);
  const trimmed = base.slice(0, room).replace(/^-+|-+$/g, "") || "secret";
  return `${trimmed}-${hash}`.slice(0, maxLength).replace(/^-+|-+$/g, "") || `secret-${hash}`;
}

function secretName(key) {
  return safeAzureSecretName(key, 63);
}

function containerResources(fn) {
  const requestedMb = Math.max(128, Number(fn.memory_mb || 256));
  const memoryGi = Math.min(4, Math.max(0.5, Math.ceil(requestedMb / 512) * 0.5));
  return {
    cpu: Math.min(2, Math.max(0.25, memoryGi / 2)),
    memory: `${memoryGi}Gi`,
  };
}

function parseAzureMemoryMb(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Math.round(value * 1024);
  const text = String(value).trim();
  const match = /^([\d.]+)\s*([kmgt]i?)?b?$/i.exec(text);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = String(match[2] || "mi").toLowerCase();
  if (!Number.isFinite(amount)) return 0;
  if (unit.startsWith("g")) return Math.round(amount * 1024);
  if (unit.startsWith("m") || !unit) return Math.round(amount);
  if (unit.startsWith("k")) return Math.max(1, Math.round(amount / 1024));
  if (unit.startsWith("t")) return Math.round(amount * 1024 * 1024);
  return Math.round(amount);
}

function resourceMemoryMb(resources = {}) {
  return parseAzureMemoryMb(resources.memory);
}

function resourceCpu(resources = {}) {
  const cpu = Number(resources.cpu || 0);
  return Number.isFinite(cpu) ? cpu : 0;
}

function gatewayContainerResources() {
  return containerResources({ memory_mb: 128 });
}

function sidecarResources(fn) {
  return containerResources({ memory_mb: 128 });
}

function envValue(container, key) {
  return (container?.env || []).find((item) => item.name === key)?.value;
}

function currentContainerMemoryUsage(existing) {
  const containers = existing?.properties?.template?.containers || [];
  const details = containers.map((container) => ({
    name: container.name,
    memory_mb: resourceMemoryMb(container.resources || {}),
    cpu: resourceCpu(container.resources || {}),
    azure_memory: container.resources?.memory || "",
    azure_cpu: container.resources?.cpu || "",
  }));
  return {
    total_mb: details.reduce((sum, item) => sum + item.memory_mb, 0),
    total_cpu: details.reduce((sum, item) => sum + item.cpu, 0),
    containers: details,
  };
}

function plannedContainerMemoryUsage(items) {
  const gatewayResources = gatewayContainerResources();
  const details = [
    {
      name: "gateway",
      kind: "gateway",
      requested_mb: 128,
      memory_mb: resourceMemoryMb(gatewayResources),
      azure_memory: gatewayResources.memory,
      azure_cpu: gatewayResources.cpu,
      cpu: resourceCpu(gatewayResources),
    },
    ...items.map((item) => {
      const resources = sidecarResources(item.fn);
      return {
        name: sidecarName(item.fn, item.version),
        kind: "function",
        function_id: item.fn.id,
        function_slug: item.fn.slug,
        requested_mb: Math.max(1, Number(item.fn.memory_mb || 256)),
        memory_mb: resourceMemoryMb(resources),
        azure_memory: resources.memory,
        azure_cpu: resources.cpu,
        cpu: resourceCpu(resources),
      };
    }),
  ];
  return {
    total_mb: details.reduce((sum, item) => sum + item.memory_mb, 0),
    total_cpu: details.reduce((sum, item) => sum + item.cpu, 0),
    containers: details,
  };
}

function plannedShardUsage(shard) {
  const planned = plannedContainerMemoryUsage(shard.items);
  return {
    index: shard.index,
    container_app_name: shard.appName,
    function_count: shard.items.length,
    total_mb: planned.total_mb,
    total_cpu: planned.total_cpu,
    containers: planned.containers,
  };
}

function azureMemorySummary(target, existing, shards) {
  const budgetMb = Math.max(0, Number(target.memory_budget_mb || 0));
  const current = currentContainerMemoryUsage(existing);
  const plannedShards = shards.map(plannedShardUsage);
  const plannedTotalMb = plannedShards.reduce((sum, shard) => sum + shard.total_mb, 0);
  const plannedTotalCpu = plannedShards.reduce((sum, shard) => sum + shard.total_cpu, 0);
  return {
    budget_mb: budgetMb,
    current_used_mb: current.total_mb,
    current_used_cpu: current.total_cpu,
    current_available_mb: budgetMb > 0 ? budgetMb - current.total_mb : null,
    planned_used_mb: plannedTotalMb,
    planned_used_cpu: plannedTotalCpu,
    planned_available_mb: budgetMb > 0 ? budgetMb - plannedTotalMb : null,
    current_containers: current.containers,
    planned_containers: plannedShards.flatMap((shard) => shard.containers.map((container) => ({
      ...container,
      container_app_name: shard.container_app_name,
    }))),
    planned_shards: plannedShards,
  };
}

function canFitConsumptionShard(items) {
  const planned = plannedContainerMemoryUsage(items);
  return planned.total_mb <= AZURE_CONSUMPTION_MAX_MEMORY_MB && planned.total_cpu <= AZURE_CONSUMPTION_MAX_CPU;
}

function splitEnvironmentItemsIntoShards(baseAppName, items) {
  const shards = [];
  let current = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (current.length && !canFitConsumptionShard(candidate)) {
      shards.push(current);
      current = [item];
    } else {
      current = candidate;
    }

    if (!canFitConsumptionShard(current)) {
      const planned = plannedContainerMemoryUsage(current);
      const error = new Error(`La API ${item.fn?.slug || item.fn?.name || item.fn?.id || "sin nombre"} no entra en un shard de Azure Consumption. Requiere ${planned.total_cpu} CPU / ${planned.total_mb} MB incluyendo gateway, y el maximo por Container App es ${AZURE_CONSUMPTION_MAX_CPU} CPU / ${AZURE_CONSUMPTION_MAX_MEMORY_MB} MB.`);
      error.code = "AZURE_CONTAINER_APP_SHARD_LIMIT";
      error.memory = planned;
      throw error;
    }
  }
  if (current.length || !shards.length) shards.push(current);
  return shards.map((shardItems, index) => ({
    index: index + 1,
    appName: containerAppShardName(baseAppName, index + 1),
    items: shardItems,
  }));
}

function normalizedContainerResources(container) {
  if (container.name === "gateway") return gatewayContainerResources();
  const requestedMb = Number(envValue(container, "FPM_MEMORY_MB") || 0);
  return requestedMb > 0 ? containerResources({ memory_mb: requestedMb }) : container.resources;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null));
}

function writableIdentity(identity) {
  if (!identity?.type || String(identity.type).toLowerCase() === "none") return undefined;
  return compactObject({
    type: identity.type,
    userAssignedIdentities: identity.userAssignedIdentities,
  });
}

const GATEWAY_SCRIPT = `
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const routes = JSON.parse(process.env.FPM_ROUTES || "[]").sort((a, b) => b.path.length - a.path.length);
const corsEnabled = process.env.FPM_CORS_ENABLED !== "false";
const corsOrigins = (process.env.FPM_CORS_ORIGINS || "*").split(",").map((item) => item.trim()).filter(Boolean);
const corsMethods = process.env.FPM_CORS_METHODS || "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const corsHeadersDefault = process.env.FPM_CORS_HEADERS || "authorization,content-type,x-api-key";
const corsMaxAge = process.env.FPM_CORS_MAX_AGE || "86400";
const corsAllowCredentials = process.env.FPM_CORS_ALLOW_CREDENTIALS === "true";

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function setHeader(headers, name, value) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
  if (value != null && value !== "") headers[name] = value;
}

function corsOrigin(req) {
  const origin = firstHeader(req.headers.origin);
  if (!corsOrigins.length || corsOrigins.includes("*")) {
    return corsAllowCredentials && origin ? origin : "*";
  }
  return origin && corsOrigins.includes(origin) ? origin : "";
}

function withCorsHeaders(req, base = {}) {
  const headers = { ...base };
  if (!corsEnabled) return headers;
  const origin = corsOrigin(req);
  setHeader(headers, "Access-Control-Allow-Origin", origin);
  setHeader(headers, "Access-Control-Allow-Methods", corsMethods);
  setHeader(headers, "Access-Control-Allow-Headers", firstHeader(req.headers["access-control-request-headers"]) || corsHeadersDefault);
  setHeader(headers, "Access-Control-Max-Age", corsMaxAge);
  setHeader(headers, "Access-Control-Allow-Credentials", corsAllowCredentials && origin && origin !== "*" ? "true" : "");
  setHeader(headers, "Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  return headers;
}

function writeJson(req, res, status, payload) {
  res.writeHead(status, withCorsHeaders(req, { "content-type": "application/json" }));
  res.end(JSON.stringify(payload));
}

function proxyRequest(req, res, route) {
  const remoteBase = route.upstreamBaseUrl || "";
  const timeoutMs = Math.max(1000, Number(route.timeoutSeconds || 30) * 1000 + 5000);
  if (remoteBase) {
    let upstreamUrl;
    try {
      upstreamUrl = new URL(req.url || "/", remoteBase);
    } catch (error) {
      writeJson(req, res, 502, { error: "Invalid upstream URL", detail: error.message });
      return;
    }
    const headers = { ...req.headers, host: upstreamUrl.host };
    const client = upstreamUrl.protocol === "https:" ? https : http;
    const upstream = client.request({
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: req.method,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, withCorsHeaders(req, upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstream.on("error", (error) => {
      writeJson(req, res, 502, { error: "Upstream unavailable", detail: error.message });
    });
    upstream.setTimeout(timeoutMs, () => {
      upstream.destroy(new Error("Upstream timeout after " + timeoutMs + "ms"));
    });
    req.pipe(upstream);
    return;
  }

  const headers = { ...req.headers, host: "127.0.0.1:" + route.port };
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: route.port,
    path: req.url,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, withCorsHeaders(req, upstreamRes.headers));
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => {
    writeJson(req, res, 502, { error: "Upstream unavailable", detail: error.message });
  });
  upstream.setTimeout(timeoutMs, () => {
    upstream.destroy(new Error("Upstream timeout after " + timeoutMs + "ms"));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const tx = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const pathname = (req.url || "/").split("?")[0];
  let matchedRoute = null;
  console.log("[request:start]", "tx=" + tx, "method=" + req.method, "path=" + (req.url || "/"));
  res.on("finish", () => {
    const parts = [
      "tx=" + tx,
      "method=" + req.method,
      "path=" + (req.url || "/"),
      "status=" + res.statusCode,
      "duration_ms=" + (Date.now() - started),
    ];
    if (matchedRoute?.function_id) parts.push("function_id=" + matchedRoute.function_id);
    if (matchedRoute?.upstreamBaseUrl) parts.push("upstream=remote");
    else if (matchedRoute?.port) parts.push("upstream=local:" + matchedRoute.port);
    console.log("[request]", ...parts);
  });
  if (pathname === "/__fpm/routes") {
    writeJson(req, res, 200, {
      routes: routes.map((route) => ({
        path: route.path,
        function_id: route.function_id,
        function_slug: route.function_slug,
        version: route.version,
      })),
    });
    return;
  }
  if ((req.method || "").toUpperCase() === "OPTIONS") {
    res.writeHead(204, withCorsHeaders(req));
    res.end();
    return;
  }
  const route = routes.find((item) => pathname === item.path || pathname.startsWith(item.path + "/"));
  matchedRoute = route;
  if (!route) {
    writeJson(req, res, 404, { error: "Route not found", path: pathname });
    return;
  }
  proxyRequest(req, res, route);
});
server.listen(Number(process.env.PORT || 8080), "0.0.0.0", () => {
  console.log("[gateway] routes:", routes.map((item) => item.path + "->" + (item.upstreamBaseUrl || item.port)).join(", "));
});
`;

function sidecarName(fn, version) {
  return `fn-${slugify(normalizeDeployVersion(version))}-${slugify(fn.slug || fn.name || "api")}`.slice(0, 32).replace(/-$/, "");
}

function environmentSecretName(fn, key) {
  return safeAzureSecretName(`${fn.slug || fn.id || "fn"}-${key}`, 63);
}

function updateContainerMemoryEnv(env = [], memoryMb) {
  const next = Array.isArray(env) ? env.map((item) => ({ ...item })) : [];
  const existing = next.find((item) => item.name === "FPM_MEMORY_MB");
  if (existing) existing.value = String(Math.max(1, Number(memoryMb || 256)));
  else next.push({ name: "FPM_MEMORY_MB", value: String(Math.max(1, Number(memoryMb || 256))) });
  return next;
}

function writableAzureSecrets(secrets = []) {
  const writable = (Array.isArray(secrets) ? secrets : []).filter((secret) =>
    secret?.name && (secret.value != null || secret.keyVaultUrl)
  );
  return writable.length ? writable : undefined;
}

function containerAppUpdatePayload(existing, target, fn) {
  const config = existing?.properties?.configuration || {};
  const template = existing?.properties?.template || {};
  const resources = containerResources(fn);
  const containers = (template.containers || []).map((container, index) => {
    if (index !== 0 && container.name !== "function") return container;
    return {
      ...container,
      env: updateContainerMemoryEnv(container.env, fn.memory_mb),
      resources,
    };
  });

  return compactObject({
    location: existing?.location || target.azure_location,
    identity: writableIdentity(existing?.identity),
    properties: compactObject({
      managedEnvironmentId: existing?.properties?.managedEnvironmentId || managedEnvironmentId(target),
      configuration: compactObject({
        activeRevisionsMode: config.activeRevisionsMode,
        dapr: config.dapr,
        ingress: config.ingress,
        registries: config.registries,
        secrets: writableAzureSecrets(config.secrets),
        service: config.service,
      }),
      template: compactObject({
        containers,
        initContainers: template.initContainers,
        scale: template.scale,
        serviceBinds: template.serviceBinds,
        terminationGracePeriodSeconds: template.terminationGracePeriodSeconds,
        volumes: template.volumes,
      }),
      workloadProfileName: existing?.properties?.workloadProfileName,
    }),
  });
}

function normalizeContainerAppMemoryPayload(existing, target) {
  const config = existing?.properties?.configuration || {};
  const template = existing?.properties?.template || {};
  const containers = (template.containers || []).map((container) => {
    const resources = normalizedContainerResources(container);
    if (!resources) return container;
    return {
      ...container,
      env: updateContainerMemoryEnv(container.env, resourceMemoryMb(resources)),
      resources,
    };
  });

  return compactObject({
    location: existing?.location || target.azure_location,
    identity: writableIdentity(existing?.identity),
    properties: compactObject({
      managedEnvironmentId: existing?.properties?.managedEnvironmentId || managedEnvironmentId(target),
      configuration: compactObject({
        activeRevisionsMode: config.activeRevisionsMode,
        dapr: config.dapr,
        ingress: config.ingress,
        registries: config.registries,
        secrets: writableAzureSecrets(config.secrets),
        service: config.service,
      }),
      template: compactObject({
        containers,
        initContainers: template.initContainers,
        scale: template.scale,
        serviceBinds: template.serviceBinds,
        terminationGracePeriodSeconds: template.terminationGracePeriodSeconds,
        volumes: template.volumes,
      }),
      workloadProfileName: existing?.properties?.workloadProfileName,
    }),
  });
}

function functionEnv(fn, secrets, deployVersion, { port = null, scopedSecrets = false } = {}) {
  const tokens = Array.isArray(fn.api_tokens) ? fn.api_tokens.map((token) => token.value).filter(Boolean) : [];
  const firstToken = tokens[0] || "";
  const tokensJson = JSON.stringify(tokens);
  const tokensCsv = tokens.join(",");
  const secretKeys = new Set(secrets.map((secret) => String(secret.key || "").toUpperCase()));
  const defaultRoutes = defaultUpstreamPaths(fn);
  return [
    { name: "FPM_FUNCTION_ID", value: fn.id },
    { name: "FPM_PROJECT_ID", value: fn.project_id || "" },
    { name: "FPM_ENVIRONMENT", value: fn.environment_slug || "" },
    { name: "FPM_DEPLOY_VERSION", value: deployVersion },
    { name: "FPM_ROUTE_PATH", value: routePath(fn, deployVersion) },
    ...(port ? [{ name: "FPM_PORT", value: String(port) }] : []),
    { name: "FPM_TIMEOUT_SECONDS", value: String(Math.max(1, Number(fn.timeout_seconds || 30))) },
    { name: "FPM_MEMORY_MB", value: String(Math.max(1, Number(fn.memory_mb || 256))) },
    { name: "FPM_AUTH_REQUIRED", value: fn.auth_required ? "true" : "false" },
    { name: "FPM_AUTH_HEADER", value: fn.auth_header_name || "x-api-key" },
    { name: "FPM_AUTH_TOKENS", value: tokensJson },
    { name: "FPM_AUTH_TOKENS_CSV", value: tokensCsv },
    ...inheritedCorsEnvValues(),
    ...Object.entries(defaultRoutes).map(([method, path]) => ({ name: `FPM_DEFAULT_${method}_PATH`, value: path })),
    { name: "FPM_API_KEY", value: firstToken },
    { name: "FPM_API_KEYS", value: tokensJson },
    { name: "FPM_API_KEYS_CSV", value: tokensCsv },
    ...(!secretKeys.has("API_KEY") && firstToken ? [{ name: "API_KEY", value: firstToken }] : []),
    ...(!secretKeys.has("API_KEYS") && tokens.length ? [{ name: "API_KEYS", value: tokensJson }] : []),
    ...(!secretKeys.has("API_KEYS_CSV") && tokens.length ? [{ name: "API_KEYS_CSV", value: tokensCsv }] : []),
    ...secrets.map((secret) => ({
      name: secret.key,
      secretRef: scopedSecrets ? environmentSecretName(fn, secret.key) : secretName(secret.key),
    })),
  ];
}

async function azureAccessToken(target) {
  required(target, ["azure_tenant_id", "azure_client_id", "azure_client_secret"]);
  const body = new URLSearchParams({
    client_id: target.azure_client_id,
    client_secret: target.azure_client_secret,
    grant_type: "client_credentials",
    scope: "https://management.azure.com/.default",
  });
  let res;
  try {
    res = await httpsRequestText(`https://login.microsoftonline.com/${target.azure_tenant_id}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    throw new Error(describeNetworkError(error, "Azure AD"));
  }
  if (!res.ok) throw new Error(`Azure auth fallo (${res.status}): ${res.text}`);
  const data = JSON.parse(res.text);
  return data.access_token;
}

async function armRequest(target, method, path, body, { token = null, apiVersion = ARM_API_VERSION } = {}) {
  token ||= await azureAccessToken(target);
  const url = `https://management.azure.com${path}${path.includes("?") ? "&" : "?"}api-version=${apiVersion}`;
  let res;
  try {
    res = await httpsRequestText(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new Error(describeNetworkError(error, "Azure Resource Manager"));
  }
  const text = res.text;
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const message = parsed?.error?.message || text || `ARM ${method} ${path} failed`;
    const error = new Error(message);
    error.status = res.status;
    error.code = parsed?.error?.code || "";
    error.body = parsed;
    throw error;
  }
  return parsed;
}

async function dockerLogin(target) {
  const credentials = registryCredentials(target);
  await run("docker", ["login", target.acr_login_server, "--username", credentials.username, "--password-stdin"], { input: credentials.password });
  return credentials;
}

function registryCredentials(target) {
  const username = target.acr_username || target.azure_client_id;
  const password = target.acr_password || target.azure_client_secret;
  required({ ...target, _registry_username: username, _registry_password: password }, ["acr_login_server", "_registry_username", "_registry_password"]);
  return { username, password };
}

function acrName(target) {
  const loginServer = String(target.acr_login_server || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const name = loginServer.split(".")[0];
  if (!name) throw new Error("No se pudo resolver el nombre del ACR desde acr_login_server.");
  return name;
}

function acrResourcePath(target) {
  return `/subscriptions/${target.azure_subscription_id}/resourceGroups/${target.azure_resource_group}/providers/Microsoft.ContainerRegistry/registries/${acrName(target)}`;
}

function acrImageName(target, image) {
  const loginServer = String(target.acr_login_server || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const normalized = String(image || "");
  return normalized.startsWith(`${loginServer}/`) ? normalized.slice(loginServer.length + 1) : normalized;
}

async function uploadAcrBuildSource(uploadUrl, archivePath) {
  const body = await readFile(archivePath);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "x-ms-blob-type": "BlockBlob",
      "content-type": "application/gzip",
      "content-length": String(body.length),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`No se pudo subir el contexto de build al ACR (${res.status}): ${text}`);
  }
}

async function acrRunLogTail(target, token, runId) {
  try {
    const result = await armRequest(target, "POST", `${acrResourcePath(target)}/runs/${runId}/listLogSasUrl`, null, {
      token,
      apiVersion: ACR_API_VERSION,
    });
    const url = result?.logLink || result?.logSasUrl || result?.url;
    if (!url) return "";
    const log = await httpsRequestText(url, { timeoutMs: 60000 });
    if (!log.ok || !log.text) return "";
    return log.text.split(/\r?\n/).filter(Boolean).slice(-80).join("\n");
  } catch {
    return "";
  }
}

async function waitAcrBuildRun(target, token, runId, image, { onProgress = null, step = "acr-build", percent = 50 } = {}) {
  const path = `${acrResourcePath(target)}/runs/${runId}`;
  let lastStatus = "";
  for (let attempt = 1; attempt <= 180; attempt += 1) {
    const runInfo = await armRequest(target, "GET", path, null, { token, apiVersion: ACR_API_VERSION });
    const status = String(runInfo?.status || runInfo?.properties?.status || "").toLowerCase();
    if (status !== lastStatus || attempt % 6 === 0) {
      lastStatus = status;
      await onProgress?.({
        step,
        percent,
        status: "running",
        message: `ACR run ${runId}: ${status || "queued"}`,
      });
    }
    if (["succeeded", "success"].includes(status)) {
      await onProgress?.({ step, percent, status: "success", message: `ACR construyo ${image}` });
      return runInfo;
    }
    if (["failed", "canceled", "cancelled", "timeout", "error"].includes(status)) {
      const tail = await acrRunLogTail(target, token, runId);
      throw new Error(`ACR no pudo construir ${image}. Estado: ${status}.${tail ? `\n${tail}` : ""}`);
    }
    await sleep(10000);
  }
  throw new Error(`ACR sigue construyendo ${image} despues de 30 minutos. Revisa el run ${runId} en el registry ${acrName(target)}.`);
}

function acrBuildArguments(buildArgs = {}) {
  return Object.entries(buildArgs)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({ name, value: String(value), isSecret: false }));
}

async function buildImageInAcr({ contextDir, image, target, token, buildArgs = {}, kind = "imagen", onProgress = null, startPercent = 30, pollPercent = 38, donePercent = 44 }) {
  const archivePath = join(tmpdir(), `fpm-acr-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`);
  try {
    await onProgress?.({ step: `acr-pack-${kind}`, percent: startPercent, status: "running", message: `Empaquetando contexto ${kind} para build remoto en ACR` });
    await run("tar", ["-czf", archivePath, "."], { cwd: contextDir, timeoutMs: 10 * 60 * 1000 });
    const sourceUpload = await armRequest(target, "POST", `${acrResourcePath(target)}/listBuildSourceUploadUrl`, null, {
      token,
      apiVersion: ACR_API_VERSION,
    });
    if (!sourceUpload?.uploadUrl || !sourceUpload?.relativePath) {
      throw new Error("ACR no devolvio URL para subir el contexto de build.");
    }
    await onProgress?.({ step: `acr-upload-${kind}`, percent: startPercent + 2, status: "running", message: `Subiendo contexto ${kind} al ACR` });
    await uploadAcrBuildSource(sourceUpload.uploadUrl, archivePath);
    const imageName = acrImageName(target, image);
    const request = {
      type: "DockerBuildRequest",
      imageNames: [imageName],
      isPushEnabled: true,
      noCache: false,
      dockerFilePath: "Dockerfile",
      sourceLocation: sourceUpload.relativePath,
      platform: { os: "Linux" },
      timeout: 3600,
    };
    const args = acrBuildArguments(buildArgs);
    if (args.length) request.arguments = args;
    const scheduled = await armRequest(target, "POST", `${acrResourcePath(target)}/scheduleRun`, request, {
      token,
      apiVersion: ACR_API_VERSION,
    });
    const runId = scheduled?.name || scheduled?.runId || String(scheduled?.id || "").split("/").pop();
    if (!runId) throw new Error("ACR acepto el build, pero no devolvio run id.");
    await onProgress?.({ step: `acr-build-${kind}`, percent: pollPercent, status: "running", message: `ACR construyendo ${imageName} (run ${runId})` });
    await waitAcrBuildRun(target, token, runId, image, { onProgress, step: `acr-build-${kind}`, percent: pollPercent });
    await onProgress?.({ step: `acr-build-${kind}`, percent: donePercent, status: "success", message: `Imagen ${kind} publicada por ACR: ${image}` });
    return { runId, image };
  } finally {
    await rm(archivePath, { force: true }).catch(() => {});
  }
}

async function buildFunctionImageInAcr(fn, image, target, token) {
  const { dir } = await prepareFunctionBuildContext(fn);
  return buildImageInAcr({ contextDir: dir, image, target, token, kind: "function" });
}

function containerAppResourcePath(target, appName) {
  return `/subscriptions/${target.azure_subscription_id}/resourceGroups/${target.azure_resource_group}/providers/Microsoft.App/containerApps/${appName}`;
}

function managedEnvironmentResourcePath(target) {
  return `/subscriptions/${target.azure_subscription_id}/resourceGroups/${target.azure_resource_group}/providers/Microsoft.App/managedEnvironments/${target.container_app_environment}`;
}

function managedEnvironmentId(target) {
  return managedEnvironmentResourcePath(target);
}

function targetContainerAppPayload(target) {
  const resources = gatewayContainerResources();
  return {
    location: target.azure_location,
    properties: {
      managedEnvironmentId: managedEnvironmentId(target),
      configuration: {
        ingress: {
          external: true,
          targetPort: 80,
          transport: "auto",
        },
      },
      template: {
        containers: [{
          name: "gateway",
          image: "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest",
          env: updateContainerMemoryEnv([], resourceMemoryMb(resources)),
          resources,
        }],
        scale: {
          minReplicas: 0,
          maxReplicas: 1,
        },
      },
    },
  };
}

function platformApiEnvironment(apiUrl, { dataFile = null, version = "1.0.0", syncToken = "", environmentSlug = "" } = {}) {
  const plain = [];
  const secret = [];
  const addPlain = (name, value) => {
    if (value !== undefined && value !== null && String(value) !== "") plain.push({ name, value: String(value) });
  };
  const addSecret = (name, value) => {
    if (value !== undefined && value !== null && String(value) !== "") {
      secret.push({
        name,
        secretName: safeAzureSecretName(`platform-api-${name}`),
        value: String(value),
      });
    }
  };

  const configuredStore = platformStoreMode();
  let publicHost = "";
  try {
    publicHost = new URL(apiUrl).hostname;
  } catch {}

  addPlain("PORT", "4000");
  addPlain("FPM_PLATFORM_VERSION", version);
  addPlain("FPM_CURRENT_ENVIRONMENT", environmentSlug);
  addPlain("DATA_STORE", configuredStore);
  addPlain("DATA_FILE", dataFile || process.env.DATA_FILE);
  addPlain("DATA_ENCRYPTION_REQUIRED", process.env.DATA_ENCRYPTION_REQUIRED);
  addPlain("PUBLIC_HOST", publicHost);
  addPlain("NODE_OPTIONS", process.env.NODE_OPTIONS);
  addPlain("NODE_EXTRA_CA_CERTS", process.env.NODE_EXTRA_CA_CERTS);
  addPlain("DOCKER_HOST", process.env.DOCKER_HOST);
  addPlain("OPENAI_MODEL", process.env.OPENAI_MODEL);
  for (const key of CORS_ENV_KEYS) addPlain(key, process.env[key]);

  const authEnv = authEnvironmentValues();
  for (const item of authEnv.plain) addPlain(item.name, item.value);

  if (configuredStore !== "file") addSecret("DATABASE_URL", process.env.DATABASE_URL);
  if (configuredStore === "file") addSecret("DATA_ENCRYPTION_KEY", process.env.DATA_ENCRYPTION_KEY || process.env.FPM_DATA_ENCRYPTION_KEY);
  addSecret("FPM_PLATFORM_SYNC_TOKEN", syncToken || process.env.FPM_PLATFORM_SYNC_TOKEN);
  addSecret("OPENAI_API_KEY", process.env.OPENAI_API_KEY);
  addSecret("AI_API_KEY", process.env.AI_API_KEY);
  for (const item of authEnv.secret) addSecret(item.name, item.value);

  return { plain, secret };
}

function platformAuthRedirectUri(webUrl) {
  const base = String(webUrl || "").trim().replace(/\/+$/, "");
  return base ? `${base}/callback` : "";
}

function platformWebEnvironment(apiUrl, version = "1.0.0", environmentSlug = "", authRedirectUri = "") {
  const authEnv = authEnvironmentValues(authRedirectUri);
  const plain = [
    { name: "NEXT_PUBLIC_API_URL", value: apiUrl },
    { name: "NEXT_PUBLIC_PLATFORM_VERSION", value: version },
    { name: "NEXT_PUBLIC_ENVIRONMENT", value: environmentSlug },
    { name: "API_URL", value: apiUrl },
    { name: "PLATFORM_VERSION", value: version },
    { name: "PLATFORM_ENVIRONMENT", value: environmentSlug },
    ...authEnv.plain,
  ];
  return {
    plain,
    secret: authEnv.secret,
  };
}

function platformContainerAppPayload(existing, target, registry, spec) {
  const registryPasswordSecret = "acr-password";
  const secretMap = new Map([
    [registryPasswordSecret, { name: registryPasswordSecret, value: registry.password }],
  ]);
  for (const item of spec.secretEnv || []) {
    secretMap.set(item.secretName, { name: item.secretName, value: item.value });
  }
  const resources = containerResources({ memory_mb: spec.memoryMb || 512 });

  return compactObject({
    location: existing?.location || target.azure_location,
    identity: writableIdentity(existing?.identity),
    properties: compactObject({
      managedEnvironmentId: existing?.properties?.managedEnvironmentId || managedEnvironmentId(target),
      configuration: compactObject({
        activeRevisionsMode: "Single",
        dapr: existing?.properties?.configuration?.dapr,
        ingress: {
          external: true,
          targetPort: spec.targetPort,
          transport: "auto",
        },
        registries: [{
          server: target.acr_login_server,
          username: registry.username,
          passwordSecretRef: registryPasswordSecret,
        }],
        secrets: [...secretMap.values()],
        service: existing?.properties?.configuration?.service,
      }),
      template: compactObject({
        containers: [{
          name: spec.containerName,
          image: spec.image,
          env: [
            ...(spec.env || []),
            ...(spec.secretEnv || []).map((item) => ({ name: item.name, secretRef: item.secretName })),
          ],
          resources,
        }],
        scale: {
          minReplicas: spec.minReplicas ?? 1,
          maxReplicas: spec.maxReplicas ?? 2,
        },
        terminationGracePeriodSeconds: existing?.properties?.template?.terminationGracePeriodSeconds,
      }),
      workloadProfileName: existing?.properties?.workloadProfileName,
    }),
  });
}

function gatewayRoute(item) {
  return compactObject({
    path: routePath(item.fn, item.version),
    port: item.port,
    upstreamBaseUrl: item.upstreamBaseUrl,
    timeoutSeconds: Math.max(1, Number(item.fn.timeout_seconds || 30)),
    functionId: item.fn.id,
    slug: item.fn.slug,
    version: item.version,
    shard: item.shardAppName,
  });
}

function environmentContainerAppPayload(existing, target, registry, items, { gatewayItems = null, minReplicas = 0, maxReplicas = 3 } = {}) {
  const registryPasswordSecret = "acr-password";
  const gatewayResources = gatewayContainerResources();
  const routes = (gatewayItems || items).map(gatewayRoute);
  const functionSecrets = new Map();
  for (const item of items) {
    for (const secret of item.secrets || []) {
      functionSecrets.set(environmentSecretName(item.fn, secret.key), {
        name: environmentSecretName(item.fn, secret.key),
        value: secret.value,
      });
    }
  }

  return compactObject({
    location: existing?.location || target.azure_location,
    identity: writableIdentity(existing?.identity),
    properties: compactObject({
      managedEnvironmentId: existing?.properties?.managedEnvironmentId || managedEnvironmentId(target),
      configuration: compactObject({
        activeRevisionsMode: "Single",
        dapr: existing?.properties?.configuration?.dapr,
        ingress: {
          external: true,
          targetPort: 8080,
          transport: "auto",
        },
        registries: [{
          server: target.acr_login_server,
          username: registry.username,
          passwordSecretRef: registryPasswordSecret,
        }],
        secrets: [
          { name: registryPasswordSecret, value: registry.password },
          ...functionSecrets.values(),
        ],
        service: existing?.properties?.configuration?.service,
      }),
      template: compactObject({
        containers: [
          {
            name: "gateway",
            image: "node:20-alpine",
            command: ["node"],
            args: ["-e", GATEWAY_SCRIPT],
            env: [
              { name: "PORT", value: "8080" },
              { name: "FPM_ROUTES", value: JSON.stringify(routes) },
              { name: "FPM_MEMORY_MB", value: String(resourceMemoryMb(gatewayResources)) },
              ...inheritedCorsEnvValues(),
            ],
            resources: gatewayResources,
          },
          ...items.map((item) => ({
            name: sidecarName(item.fn, item.version),
            image: item.image,
            env: functionEnv(item.fn, item.secrets, item.version, { port: item.port, scopedSecrets: true }),
            resources: sidecarResources(item.fn),
          })),
        ],
        scale: {
          minReplicas,
          maxReplicas,
        },
        terminationGracePeriodSeconds: existing?.properties?.template?.terminationGracePeriodSeconds,
      }),
      workloadProfileName: existing?.properties?.workloadProfileName,
    }),
  });
}

function managedEnvironmentPayload(target) {
  return {
    location: target.azure_location,
    properties: {},
  };
}

async function resourceExists(target, path, token) {
  try {
    return await armRequest(target, "GET", path, null, { token });
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function readReadyContainerApp(target, appName, token) {
  const path = containerAppResourcePath(target, appName);
  const existingRaw = await resourceExists(target, path, token);
  return existingRaw && !containerAppReady(existingRaw)
    ? await waitContainerAppProvisioning(target, appName, token)
    : existingRaw;
}

async function ensureManagedEnvironment(target, token, onProgress, steps) {
  const path = managedEnvironmentResourcePath(target);
  steps = await reportProvisioning(onProgress, steps, {
    id: "managed-environment",
    status: "running",
    message: `Validando ${target.container_app_environment}`,
  });

  const existing = await resourceExists(target, path, token);
  if (existing) {
    return {
      steps: await reportProvisioning(onProgress, steps, {
        id: "managed-environment",
        status: "success",
        message: "Managed Environment existente",
      }),
      created: false,
      environment: existing,
    };
  }

  const created = await armRequest(target, "PUT", path, managedEnvironmentPayload(target), { token });
  const ready = await readManagedEnvironment(target, token, async (attempt, state) => {
    if (attempt === 1 || attempt % 4 === 0) {
      steps = await reportProvisioning(onProgress, steps, {
        id: "managed-environment",
        status: "running",
        message: `Esperando Managed Environment (${state || "provisioning"}, intento ${attempt})`,
      });
    }
  });
  if (!ready) {
    throw new Error(`Azure recibio la solicitud para crear el Managed Environment ${target.container_app_environment}, pero aun no quedo listo. Reintenta Crear en Azure para continuar desde este paso.`);
  }
  return {
    steps: await reportProvisioning(onProgress, steps, {
      id: "managed-environment",
      status: "success",
      message: "Managed Environment creado",
    }),
    created: true,
    environment: ready || created,
  };
}

async function readManagedEnvironment(target, token, onWait) {
  const path = managedEnvironmentResourcePath(target);
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    let state = "";
    try {
      const result = await armRequest(target, "GET", path, null, { token });
      state = String(result?.properties?.provisioningState || "").toLowerCase();
      if (!state || state === "succeeded" || state === "ready") return result;
    } catch (error) {
      if (error?.status !== 404) throw error;
      state = "not-found";
    }
    await onWait?.(attempt, state);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return null;
}

function containerAppProvisioningState(resource) {
  return String(resource?.properties?.provisioningState || "").toLowerCase();
}

function containerAppReady(resource) {
  const state = containerAppProvisioningState(resource);
  return !state || state === "succeeded" || state === "ready";
}

function azureContainerAppBusyError(message) {
  const error = new Error(message);
  error.code = "AZURE_CONTAINER_APP_BUSY";
  error.statusCode = 409;
  error.retryAfterSeconds = 300;
  return error;
}

function isActiveProvisioningConflict(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`;
  return Number(error?.status) === 409 && /active provisioning operation|provisioning operation.*progress|cannot modify a container app/i.test(text);
}

async function waitContainerAppProvisioning(target, appName, token, {
  allowNotFound = false,
  maxAttempts = 60,
  delayMs = 5000,
} = {}) {
  const path = containerAppResourcePath(target, appName);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await armRequest(target, "GET", path, null, { token });
      const state = containerAppProvisioningState(result);
      if (containerAppReady(result)) return result;
      if (["failed", "canceled", "cancelled"].includes(state)) {
        throw new Error(`Azure dejo ${appName} en estado ${state}. Revisa el Container App en Azure y vuelve a desplegar.`);
      }
    } catch (error) {
      if (error?.status === 404 && allowNotFound) return null;
      if (error?.status !== 404) throw error;
    }
    await sleep(delayMs);
  }
  throw azureContainerAppBusyError(`Azure sigue procesando ${appName}. Espera unos minutos y vuelve a ejecutar el despliegue.`);
}

async function putContainerApp(target, appName, payload, token, { maxRetries = 4 } = {}) {
  const path = containerAppResourcePath(target, appName);
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await armRequest(target, "PUT", path, payload, { token });
      return await waitContainerAppProvisioning(target, appName, token, { maxAttempts: 60 }) || result;
    } catch (error) {
      if (!isActiveProvisioningConflict(error)) throw error;
      lastError = error;
      if (attempt === maxRetries) break;
      await waitContainerAppProvisioning(target, appName, token, { maxAttempts: 36 }).catch((waitError) => {
        if (!/sigue procesando/i.test(waitError?.message || "")) throw waitError;
      });
    }
  }

  const message = lastError?.message || "";
  throw azureContainerAppBusyError(
    `Azure todavia esta procesando el Container App ${appName}. ` +
    `Espera unos minutos y vuelve a desplegar. Detalle: ${message}`
  );
}

async function readContainerAppFqdn(target, appName, token = null) {
  const path = containerAppResourcePath(target, appName);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const result = await armRequest(target, "GET", path, null, { token });
      const fqdn = result?.properties?.configuration?.ingress?.fqdn;
      if (fqdn) return fqdn;
    } catch {}
    await sleep(1500);
  }
  return null;
}

async function upsertPlatformContainerApp(target, token, registry, spec) {
  const path = containerAppResourcePath(target, spec.appName);
  const existingRaw = await resourceExists(target, path, token);
  const existing = existingRaw && !containerAppReady(existingRaw)
    ? await waitContainerAppProvisioning(target, spec.appName, token)
    : existingRaw;
  const payload = platformContainerAppPayload(existing, target, registry, spec);
  const result = await putContainerApp(target, spec.appName, payload, token);
  const fqdn = result?.properties?.configuration?.ingress?.fqdn || await readContainerAppFqdn(target, spec.appName, token);
  if (!fqdn) {
    throw new Error(`Azure desplego ${spec.appName}, pero aun no devolvio la URL publica. Reintenta en unos segundos.`);
  }
  return {
    containerAppName: spec.appName,
    image: spec.image,
    url: `https://${fqdn}`,
  };
}

export async function deployPlatformContainerApps(target, { rootDir = null, version = null, onProgress = null } = {}) {
  const progress = async (step, percent, message, status = "running") => {
    await onProgress?.({ step, percent, message, status });
  };
  await progress("validate", 3, "Validando configuracion del target");
  required(target, [
    "azure_subscription_id",
    "azure_tenant_id",
    "azure_client_id",
    "azure_client_secret",
    "azure_resource_group",
    "azure_location",
    "acr_login_server",
    "container_app_environment",
    "container_app_name_prefix",
  ]);

  const platformVersion = platformVersionTag(version || target.platform_version || "1.0.0");
  const sourceRoot = resolve(rootDir || platformSourceRoot());
  await progress("source", 6, `Usando fuente ${sourceRoot}`);
  const { apiDir, webDir } = await assertPlatformSource(sourceRoot);
  await progress("auth", 10, "Autenticando contra Azure");
  const token = await azureAccessToken(target);
  await progress("managed-environment", 14, "Validando Managed Environment");
  await ensureManagedEnvironment(target, token);
  const docker = await getDockerStatus();
  const buildMode = docker.available ? "docker-local" : "acr-remote";
  await progress(
    "registry",
    20,
    docker.available
      ? "Autenticando Docker local contra ACR"
      : `Docker no esta disponible en este runtime (${docker.message || "sin daemon"}). Usando build remoto en ACR.`
  );
  const registry = docker.available ? await dockerLogin(target) : registryCredentials(target);

  const apiAppName = platformAppName(target, "api");
  const webAppName = platformAppName(target, "web");
  const apiImage = platformImageRef(target, "api", platformVersion);
  const webImage = platformImageRef(target, "web", platformVersion);
  const syncToken = platformSyncToken(target);
  const environmentSlug = String(target.environment_slug || "").toLowerCase();

  const apiContext = await preparePlatformApiContext(sourceRoot, apiDir);
  try {
    await buildAndPushPlatformImage({ contextDir: apiContext.contextDir, image: apiImage, kind: "api", onProgress, buildMode, target, token });
  } finally {
    await apiContext.cleanup();
  }

  await progress("deploy-api", 48, "Creando o actualizando Container App API");
  const initialApiEnv = platformApiEnvironment("", { dataFile: apiContext.dataFile, version: platformVersion, syncToken, environmentSlug });
  let apiApp = await upsertPlatformContainerApp(target, token, registry, {
    appName: apiAppName,
    containerName: "api",
    image: apiImage,
    targetPort: 4000,
    memoryMb: 512,
    env: initialApiEnv.plain,
    secretEnv: initialApiEnv.secret,
    minReplicas: 1,
    maxReplicas: 2,
  });
  await progress("deploy-api", 56, `API publicada en ${apiApp.url}. Sincronizando variables`);
  const apiEnv = platformApiEnvironment(apiApp.url, { dataFile: apiContext.dataFile, version: platformVersion, syncToken, environmentSlug });
  apiApp = await upsertPlatformContainerApp(target, token, registry, {
    appName: apiAppName,
    containerName: "api",
    image: apiImage,
    targetPort: 4000,
    memoryMb: 512,
    env: apiEnv.plain,
    secretEnv: apiEnv.secret,
    minReplicas: 1,
    maxReplicas: 2,
  });

  await buildAndPushPlatformImage({
    contextDir: webDir,
    image: webImage,
    buildArgs: { NEXT_PUBLIC_API_URL: apiApp.url, NEXT_PUBLIC_PLATFORM_VERSION: platformVersion, NEXT_PUBLIC_ENVIRONMENT: environmentSlug },
    kind: "web",
    onProgress,
    buildMode,
    target,
    token,
  });
  await progress("deploy-web", 88, "Creando o actualizando Container App Web");
  const webAppBase = await upsertPlatformContainerApp(target, token, registry, {
    appName: webAppName,
    containerName: "web",
    image: webImage,
    targetPort: 3000,
    memoryMb: 512,
    env: platformWebEnvironment(apiApp.url, platformVersion, environmentSlug).plain,
    secretEnv: [],
    minReplicas: 1,
    maxReplicas: 2,
  });
  const webRedirectUri = platformAuthRedirectUri(webAppBase.url);
  const webEnv = platformWebEnvironment(apiApp.url, platformVersion, environmentSlug, webRedirectUri);
  const webApp = await upsertPlatformContainerApp(target, token, registry, {
    appName: webAppName,
    containerName: "web",
    image: webImage,
    targetPort: 3000,
    memoryMb: 512,
    env: webEnv.plain,
    secretEnv: webEnv.secret,
    minReplicas: 1,
    maxReplicas: 2,
  });
  await progress("complete", 100, `Plataforma ${platformVersion} desplegada correctamente`, "success");

  return {
    provider: "azure",
    environment: target.environment_slug || target.environment_name || "",
    version: platformVersion,
    build_mode: buildMode,
    sourceRoot,
    api: apiApp,
    web: webApp,
    message: `Plataforma ${platformVersion} desplegada: API ${apiApp.url} y Web ${webApp.url}`,
  };
}

export async function deployToAzureContainerApp(fn, secrets, target, { version = "v1", environmentFunctions = [], knownContainerAppNames = [] } = {}) {
  const deployVersion = normalizeDeployVersion(version);
  required(target, [
    "azure_subscription_id",
    "azure_tenant_id",
    "azure_client_id",
    "azure_client_secret",
    "azure_resource_group",
    "azure_location",
    "acr_login_server",
    "container_app_environment",
  ]);

  const baseAppName = target.azure_container_app_name || targetContainerAppName(target);
  const token = await azureAccessToken(target);
  const existing = await readReadyContainerApp(target, baseAppName, token);
  if (!existing) {
    throw new Error(azureProvisioningRequiredMessage(target));
  }

  const rawItems = environmentFunctions.length
    ? environmentFunctions
    : [{ fn, function: fn, secrets, version: deployVersion }];
  const items = rawItems.map((item, index) => {
    const itemFn = item.fn || item.function || item;
    if (itemFn.runtime === "custom") {
      throw new Error("Azure automatico con Container App unico no soporta Custom Dockerfile hasta que el Dockerfile lea FPM_PORT.");
    }
    const itemVersion = normalizeDeployVersion(item.version || (itemFn.id === fn.id ? deployVersion : itemFn.active_deploy_version || "v1"));
    return {
      fn: itemFn,
      secrets: item.secrets || (itemFn.id === fn.id ? secrets : []),
      version: itemVersion,
      port: 9100 + index,
      image: imageRef(itemFn, target, itemVersion),
    };
  });

  const workerShards = splitEnvironmentItemsIntoShards(baseAppName, items);
  const baseGatewayShard = { index: 0, appName: baseAppName, items: [] };
  const allShards = [baseGatewayShard, ...workerShards];
  const memory = azureMemorySummary(target, existing, allShards);
  const docker = await getDockerStatus();
  const registry = docker.available ? await dockerLogin(target) : registryCredentials(target);
  const buildMode = docker.available ? "docker-local" : "acr-remote";

  for (const item of items) {
    if (docker.available) {
      await buildFunctionImage({ ...item.fn, deploy_version: item.version }, item.image);
      await run("docker", ["push", item.image]);
    } else {
      await buildFunctionImageInAcr({ ...item.fn, deploy_version: item.version }, item.image, target, token);
    }
  }

  const remoteShards = [];
  for (const shard of workerShards) {
    const shardExisting = await readReadyContainerApp(target, shard.appName, token);
    const payload = environmentContainerAppPayload(shardExisting || existing, target, registry, shard.items);
    const result = await putContainerApp(target, shard.appName, payload, token);
    const fqdn = result?.properties?.configuration?.ingress?.fqdn || await readContainerAppFqdn(target, shard.appName, token);
    const showCommand = `az containerapp show -g ${target.azure_resource_group} -n ${shard.appName} --query properties.configuration.ingress.fqdn -o tsv`;
    if (!fqdn) {
      throw new Error(`Azure desplego ${shard.appName}, pero aun no devolvio la URL publica. Reintenta el deploy en unos segundos o consulta con: ${showCommand}`);
    }
    const baseUrl = `https://${fqdn}`;
    remoteShards.push({
      ...shard,
      fqdn,
      baseUrl,
      routes: shard.items.map((item) => ({
        function_id: item.fn.id,
        function_slug: item.fn.slug,
        version: item.version,
        container_app_name: shard.appName,
        shard_index: shard.index,
        base_url: baseUrl,
        url: withRoutePath(baseUrl, item.fn, item.version),
      })),
    });
  }

  const gatewayItems = remoteShards.flatMap((shard) => shard.items.map((item) => ({
      ...item,
      shardAppName: shard.appName,
      upstreamBaseUrl: shard.baseUrl,
    })));

  const basePayload = environmentContainerAppPayload(existing, target, registry, [], {
    gatewayItems,
    minReplicas: 1,
    maxReplicas: 2,
  });
  const baseResult = await putContainerApp(target, baseAppName, basePayload, token);
  const baseFqdn = baseResult?.properties?.configuration?.ingress?.fqdn || await readContainerAppFqdn(target, baseAppName, token);
  const baseShowCommand = `az containerapp show -g ${target.azure_resource_group} -n ${baseAppName} --query properties.configuration.ingress.fqdn -o tsv`;
  if (!baseFqdn) {
    throw new Error(`Azure desplego ${baseAppName}, pero aun no devolvio la URL publica. Reintenta el deploy en unos segundos o consulta con: ${baseShowCommand}`);
  }
  const stableBaseUrl = `https://${baseFqdn}`;
  const deployedShards = [
    {
      ...baseGatewayShard,
      fqdn: baseFqdn,
      baseUrl: stableBaseUrl,
    },
    ...remoteShards,
  ];

  const activeNames = new Set(deployedShards.map((shard) => shard.appName));
  const knownNames = [...new Set(knownContainerAppNames || [])]
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  const probeShardCount = Math.max(allShards.length + 8, knownNames.length + 1);
  const probeNames = Array.from({ length: probeShardCount }, (_, index) => containerAppShardName(baseAppName, index));
  const obsoleteNames = [...new Set([...knownNames, ...probeNames])]
    .map((name) => String(name || "").trim())
    .filter((name) => name && !activeNames.has(name));
  const drainedShards = [];
  for (const appName of obsoleteNames) {
    const obsolete = await readReadyContainerApp(target, appName, token);
    if (!obsolete) continue;
    const payload = environmentContainerAppPayload(obsolete, target, registry, []);
    await putContainerApp(target, appName, payload, token);
    drainedShards.push(appName);
  }

  const routes = workerShards.flatMap((shard) => {
    const directBaseUrl = remoteShards.find((item) => item.index === shard.index)?.baseUrl || stableBaseUrl;
    return shard.items.map((item) => ({
      function_id: item.fn.id,
      function_slug: item.fn.slug,
      version: item.version,
      container_app_name: shard.appName,
      shard_index: shard.index,
      base_url: stableBaseUrl,
      direct_base_url: directBaseUrl,
      url: withRoutePath(stableBaseUrl, item.fn, item.version),
      direct_url: withRoutePath(directBaseUrl, item.fn, item.version),
    }));
  });
  const currentRoute = routes.find((route) => route.function_id === fn.id);
  if (!currentRoute) {
    throw new Error(`Azure desplego los shards, pero no se encontro la ruta de ${fn.slug || fn.name || fn.id}.`);
  }
  const functionUrl = currentRoute.url;
  const shardNames = deployedShards.map((shard) => shard.appName);
  const shardMessage = deployedShards.length === 1
    ? `Container App ${baseAppName}`
    : `${deployedShards.length} Container Apps (${shardNames.join(", ")}) con gateway estable ${baseAppName}`;

  return {
    provider: "azure",
    containerAppName: currentRoute?.container_app_name || baseAppName,
    baseContainerAppName: baseAppName,
    image: items.find((item) => item.fn.id === fn.id)?.image || null,
    routes,
    url: functionUrl,
    targetBaseUrl: currentRoute?.base_url || deployedShards[0]?.baseUrl || null,
    shards: deployedShards.map((shard) => ({
      index: shard.index,
      container_app_name: shard.appName,
      base_url: shard.baseUrl,
      gateway_url: stableBaseUrl,
      function_count: shard.items.length,
      routes: routes.filter((route) => route.shard_index === shard.index),
    })),
    drainedShards,
    memory,
    build_mode: buildMode,
    message: `${shardMessage} actualizado con ${items.length} API(s). Build: ${buildMode}. URL estable: ${functionUrl}`,
  };
}

export async function provisionAzureContainerApp(target, { onProgress } = {}) {
  let steps = baseProvisioningSteps();
  try {
    steps = await reportProvisioning(onProgress, steps, {
      id: "validate",
      status: "running",
      message: "Revisando campos obligatorios",
    });
    required(target, [
      "azure_subscription_id",
      "azure_tenant_id",
      "azure_client_id",
      "azure_client_secret",
      "azure_resource_group",
      "azure_location",
      "container_app_environment",
      "container_app_name_prefix",
    ]);
    steps = await reportProvisioning(onProgress, steps, {
      id: "validate",
      status: "success",
      message: "Configuracion completa",
    });

    steps = await reportProvisioning(onProgress, steps, {
      id: "auth",
      status: "running",
      message: "Solicitando token de Azure",
    });
    const token = await azureAccessToken(target);
    steps = await reportProvisioning(onProgress, steps, {
      id: "auth",
      status: "success",
      message: "Autenticacion correcta",
    });

    const envResult = await ensureManagedEnvironment(target, token, onProgress, steps);
    steps = envResult.steps;

    const appName = targetContainerAppName(target);
    const path = containerAppResourcePath(target, appName);
    const payload = targetContainerAppPayload(target);
    steps = await reportProvisioning(onProgress, steps, {
      id: "container-app",
      status: "running",
      message: `Creando ${appName}`,
    });
    const result = await putContainerApp(target, appName, payload, token);
    steps = await reportProvisioning(onProgress, steps, {
      id: "container-app",
      status: "success",
      message: "Container App creado o actualizado",
    });

    steps = await reportProvisioning(onProgress, steps, {
      id: "fqdn",
      status: "running",
      message: "Esperando FQDN publico",
    });
    const fqdn = result?.properties?.configuration?.ingress?.fqdn || await readContainerAppFqdn(target, appName, token);
    const url = fqdn ? `https://${fqdn}` : null;
    steps = await reportProvisioning(onProgress, steps, {
      id: "fqdn",
      status: url ? "success" : "failed",
      message: url ? url : "Azure aun no devolvio FQDN para el Container App",
    });
    if (!url) throw new Error("Azure creo el Container App, pero aun no devolvio una URL publica. Reintenta en unos segundos para completar la lectura del FQDN.");

    steps = await reportProvisioning(onProgress, steps, {
      id: "complete",
      status: "success",
      message: "Provisioning completado",
    });

    return {
      provider: "azure",
      containerAppName: appName,
      managedEnvironmentCreated: envResult.created,
      url,
      configHash: targetProvisioningSignature(target),
      steps,
      message: `Container App ${appName} creada en ${target.azure_resource_group}. URL: ${url}`,
    };
  } catch (error) {
    const currentStep = steps.find((step) => step.status === "running") || steps.find((step) => step.status === "failed") || steps[0];
    await reportProvisioning(onProgress, steps, {
      id: currentStep.id,
      status: "failed",
      message: error?.message || String(error),
    });
    throw error;
  }
}

export async function syncAzureTargetContainerAppMemory(target, { token = null } = {}) {
  required(target, [
    "azure_subscription_id",
    "azure_tenant_id",
    "azure_client_id",
    "azure_client_secret",
    "azure_resource_group",
    "azure_location",
    "container_app_environment",
  ]);
  const accessToken = token || await azureAccessToken(target);
  const appName = target.azure_container_app_name || targetContainerAppName(target);
  const path = containerAppResourcePath(target, appName);
  const existingRaw = await armRequest(target, "GET", path, null, { token: accessToken });
  const existing = existingRaw && !containerAppReady(existingRaw)
    ? await waitContainerAppProvisioning(target, appName, accessToken)
    : existingRaw;
  const before = currentContainerMemoryUsage(existing);
  const payload = normalizeContainerAppMemoryPayload(existing, target);
  const after = currentContainerMemoryUsage({ ...existing, properties: { ...existing.properties, template: payload.properties.template } });
  await putContainerApp(target, appName, payload, accessToken);
  return {
    status: "success",
    updated: after.containers.length,
    failed: 0,
    skipped: 0,
    containerAppName: appName,
    memory_budget_mb: Math.max(0, Number(target.memory_budget_mb || 0)),
    previous_assigned_mb: before.total_mb,
    assigned_mb: after.total_mb,
    available_mb: Number(target.memory_budget_mb || 0) > 0 ? Number(target.memory_budget_mb || 0) - after.total_mb : null,
    containers: after.containers,
    message: `Azure normalizo la memoria del Container App ${appName}: ${after.total_mb} MB asignados.`,
  };
}

export async function stopAzureContainerApp(target, appName, { token = null, ignoreNotFound = false } = {}) {
  required(target, ["azure_subscription_id", "azure_tenant_id", "azure_client_id", "azure_client_secret", "azure_resource_group"]);
  const path = containerAppResourcePath(target, appName);
  const accessToken = token || await azureAccessToken(target);
  try {
    await armRequest(target, "POST", `${path}/stop`, null, {
      token: accessToken,
      apiVersion: CONTAINER_APP_ACTION_API_VERSION,
    });
    await waitContainerAppStopped(target, appName, accessToken);
    return {
      containerAppName: appName,
      status: "stopped",
      message: `Container App ${appName} detenido en Azure.`,
    };
  } catch (error) {
    if (ignoreNotFound && error?.status === 404) {
      return {
        containerAppName: appName,
        status: "skipped",
        message: `Container App ${appName} no existe en Azure.`,
      };
    }
    throw error;
  }
}

export async function startAzureContainerApp(target, appName, { token = null, ignoreNotFound = false } = {}) {
  required(target, ["azure_subscription_id", "azure_tenant_id", "azure_client_id", "azure_client_secret", "azure_resource_group"]);
  const path = containerAppResourcePath(target, appName);
  const accessToken = token || await azureAccessToken(target);
  try {
    await armRequest(target, "POST", `${path}/start`, null, {
      token: accessToken,
      apiVersion: CONTAINER_APP_ACTION_API_VERSION,
    });
    await waitContainerAppRunning(target, appName, accessToken);
    return {
      containerAppName: appName,
      status: "running",
      message: `Container App ${appName} iniciado en Azure.`,
    };
  } catch (error) {
    if (ignoreNotFound && error?.status === 404) {
      return {
        containerAppName: appName,
        status: "skipped",
        message: `Container App ${appName} no existe en Azure.`,
      };
    }
    throw error;
  }
}

async function waitContainerAppStopped(target, appName, token) {
  const path = containerAppResourcePath(target, appName);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const result = await armRequest(target, "GET", path, null, { token });
      const status = String(result?.properties?.runningStatus || "").toLowerCase();
      if (!status || status === "stopped") return result;
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Azure recibio la solicitud de detener ${appName}, pero el estado no cambio a Stopped dentro del tiempo esperado.`);
}

async function waitContainerAppRunning(target, appName, token) {
  const path = containerAppResourcePath(target, appName);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const result = await armRequest(target, "GET", path, null, { token });
      const status = String(result?.properties?.runningStatus || "").toLowerCase();
      if (!status || status === "running") return result;
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Azure recibio la solicitud de iniciar ${appName}, pero el estado no cambio a Running dentro del tiempo esperado.`);
}

function uniqueContainerAppNames(names) {
  return [...new Set((names || []).map((name) => String(name || "").trim()).filter(Boolean))];
}

export async function stopAzureTargetContainerApp(target, { token = null, ignoreNotFound = false, appNames = null } = {}) {
  const names = uniqueContainerAppNames(appNames?.length ? appNames : azureContainerAppShardNamesForTarget(target, 1));
  const accessToken = token || await azureAccessToken(target);
  const results = [];
  for (const appName of names) {
    results.push(await stopAzureContainerApp(target, appName, {
      token: accessToken,
      ignoreNotFound: ignoreNotFound || appName !== names[0],
    }));
  }
  const stopped = results.filter((item) => item.status === "stopped").length;
  return {
    containerAppName: names[0],
    containerAppNames: names,
    status: "stopped",
    results,
    message: `${stopped} Container App(s) del ambiente detenidos en Azure.`,
  };
}

export async function startAzureTargetContainerApp(target, { token = null, ignoreNotFound = false, appNames = null } = {}) {
  const names = uniqueContainerAppNames(appNames?.length ? appNames : azureContainerAppShardNamesForTarget(target, 1));
  const accessToken = token || await azureAccessToken(target);
  const results = [];
  for (const appName of names) {
    results.push(await startAzureContainerApp(target, appName, {
      token: accessToken,
      ignoreNotFound: ignoreNotFound || appName !== names[0],
    }));
  }
  const running = results.filter((item) => item.status === "running").length;
  return {
    containerAppName: names[0],
    containerAppNames: names,
    status: "running",
    results,
    message: `${running} Container App(s) del ambiente iniciados en Azure.`,
  };
}

export async function deleteAzureContainerApp(target, { onProgress, appNames = null } = {}) {
  let steps = baseProvisioningSteps().map((step) => ({ ...step, status: step.id === "complete" ? "pending" : "success", message: "" }));
  const appNamesToDelete = uniqueContainerAppNames(appNames?.length ? appNames : azureContainerAppShardNamesForTarget(target, 1));
  const appName = appNamesToDelete[0];
  try {
    await onProgress?.({
      status: "running",
      step: "delete-container-app",
      percent: 35,
      error: null,
      steps: [
        { id: "delete-container-app", label: "Eliminar Container Apps", percent: 70, status: "running", message: `Eliminando ${appNamesToDelete.join(", ")}` },
      ],
    });
    required(target, ["azure_subscription_id", "azure_tenant_id", "azure_client_id", "azure_client_secret", "azure_resource_group"]);
    const token = await azureAccessToken(target);
    for (const name of appNamesToDelete) {
      const path = containerAppResourcePath(target, name);
      try {
        await armRequest(target, "DELETE", path, null, { token });
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    }
    const deleteSteps = [
      { id: "delete-container-app", label: "Eliminar Container Apps", percent: 100, status: "success", message: "Container Apps eliminados o inexistentes" },
    ];
    await onProgress?.({
      status: "deleted",
      step: "delete-container-app",
      percent: 100,
      error: null,
      steps: deleteSteps,
    });
    return {
      provider: "azure",
      containerAppName: appName,
      containerAppNames: appNamesToDelete,
      steps: deleteSteps,
      message: `Container Apps ${appNamesToDelete.join(", ")} eliminados de Azure.`,
    };
  } catch (error) {
    await onProgress?.({
      status: "failed",
      step: "delete-container-app",
      percent: 70,
      error: error?.message || String(error),
      steps: [
        { id: "delete-container-app", label: "Eliminar Container Apps", percent: 70, status: "failed", message: error?.message || String(error) },
      ],
    });
    throw error;
  }
}

function parseGitHubRepo(url) {
  const match = String(url || "").match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?/i);
  return match?.groups || null;
}

export async function triggerGitDeployment(fn, target, { version = "v1" } = {}) {
  const deployVersion = normalizeDeployVersion(version);
  required(target, ["git_repo_url", "git_branch", "git_workflow_path"]);
  const repo = parseGitHubRepo(target.git_repo_url);
  if (!repo) {
    return {
      provider: "git",
      queued: false,
      message: "Repositorio Git configurado. No es GitHub o no se pudo inferir owner/repo para disparar workflow automaticamente.",
    };
  }
  if (!target.git_token) {
    return {
      provider: "git",
      queued: false,
      message: "Repositorio GitHub configurado. Falta git_token para disparar workflow_dispatch automaticamente.",
    };
  }

  const workflow = encodeURIComponent(target.git_workflow_path.replace(/^\.github\/workflows\//, ""));
  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${target.git_token}`,
      "content-type": "application/json",
      "user-agent": "function-platform",
    },
    body: JSON.stringify({
      ref: target.git_branch,
      inputs: {
        function_id: fn.id,
        function_slug: fn.slug,
        project_id: fn.project_id || "",
        environment: fn.environment_slug || "",
        version: deployVersion,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub workflow dispatch fallo (${res.status}): ${text}`);
  }

  return {
    provider: "git",
    queued: true,
    url: `https://github.com/${repo.owner}/${repo.repo}/actions`,
    message: `Workflow ${target.git_workflow_path} disparado en ${target.git_branch}`,
  };
}

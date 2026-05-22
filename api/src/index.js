import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  appendLog,
  createDeployment,
  createPlatformDeployment,
  createFunction,
  createFunctionToken,
  copyProjectSecretsBetweenEnvironments,
  createProject,
  deleteFunction,
  deleteFunctionToken,
  deleteSecret,
  finishDeployment,
  finishPlatformDeployment,
  buildPlatformDeploymentSnapshot,
  buildPlatformDeploymentChangeDetails,
  getFunction,
  getEnvironment,
  getDeploymentTarget,
  getDeploymentTargetForFunction,
  getLatestSuccessfulPlatformDeployment,
  getProject,
  getSecretsForFunction,
  getStoreMode,
  createProjectSecret,
  listSecretsForProject,
  listDeployments,
  listPlatformDeployments,
  listDeploymentTargets,
  listEnvironments,
  listFunctions,
  listLogHistory,
  listProjects,
  listTemplates,
  promoteFunction,
  promoteProject,
  propagateDeploymentTarget,
  syncPromotedFunctionSnapshot,
  updateDeploymentTargetProvisioning,
  updateDeploymentTargetPlatform,
  updateFunction,
  updateFunctionStatus,
  updateSecret,
  upsertDeploymentTarget,
  upsertSecret,
  initDb,
  ensureLegacyTenantBackfill,
  q,
} from "./db.js";
import { getRequestTenantId, setRequestContext } from "./requestContext.js";
import { buildAndDeploy, getDockerStatus, readContainerLogHistory, stopAndRemove, streamLogs } from "./docker.js";
import {
  azureContainerAppShardNamesForTarget,
  azureProvisioningRequiredMessage,
  azureShardCountForFunctionCount,
  deleteAzureContainerApp,
  deployPlatformContainerApps,
  deployToAzureContainerApp,
  isAzureTargetProvisioned,
  platformSyncToken,
  provisionAzureContainerApp,
  startAzureTargetContainerApp,
  stopAzureTargetContainerApp,
  triggerGitDeployment,
} from "./azureDeploy.js";
import { normalizeDeployVersion } from "./functionSource.js";
import { validateFunctionCode } from "./validator.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.addHook("onRequest", async (req) => {
  setRequestContext({
    tenantId: req.headers["x-tenant-id"] || req.headers["x-tenantid"] || req.headers["x-tenant"] || null,
    authorization: req.headers.authorization || null,
    userId: req.headers["x-user-id"] || null,
    applicationId: req.headers["x-application-id"] || null,
  });
});

app.addHook("preHandler", async () => {
  await ensureLegacyTenantBackfill();
});

const DEFAULT_CODE = `export default async function handler(req) {
  const name = new URL(req.url).searchParams.get("name") ?? "world";
  return new Response(JSON.stringify({ hello: name, env: process.env.GREETING ?? null }), {
    headers: { "content-type": "application/json" }
  });
}
`;

function asInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function azureContainerMemoryMb(memoryMb = 256) {
  const requested = Math.max(128, Number(memoryMb || 256));
  return Math.round(Math.min(4, Math.max(0.5, Math.ceil(requested / 512) * 0.5)) * 1024);
}

function environmentMemorySummary(target, envFunctions) {
  const budget = Number(target?.memory_budget_mb || 0);
  const running = envFunctions.filter((fn) => fn.status === "running");
  const gatewayCount = target?.deployment_mode === "azure" && (running.length || target?.azure_container_app_name)
    ? azureShardCountForFunctionCount(running.length)
    : 0;
  const gatewayMb = gatewayCount * azureContainerMemoryMb(128);
  const deployed = gatewayMb + running.reduce((sum, fn) => sum + azureContainerMemoryMb(fn.memory_mb || 256), 0);
  const available = budget > 0 ? budget - deployed : null;
  const pct = budget > 0 ? Math.round((deployed / budget) * 1000) / 10 : null;
  return {
    budget,
    assigned: budget,
    deployed,
    available,
    pct,
    overBudget: budget > 0 && deployed > budget,
    shardCount: gatewayCount,
  };
}

function environmentRuntimeSummary(env, envFunctions, target, docker = {}) {
  const envSlug = String(env?.slug || "").toLowerCase();
  const targetMode = String(target?.deployment_mode || "manual").toLowerCase();
  const dockerSummary = docker?.environment_stats?.[envSlug] || null;
  const estimated = environmentMemorySummary(target, envFunctions);
  const azureContainerNames = [
    target?.azure_container_app_name,
    target?.platform_api_container_app_name,
    target?.platform_web_container_app_name,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const azureFunctionContainerNames = [...new Set(
    envFunctions
      .map((fn) => String(fn.container_id || ""))
      .filter((value) => value.startsWith("azure:"))
      .map((value) => value.slice("azure:".length))
      .filter(Boolean)
  )];
  const isDev = envSlug === "dev";
  const useDocker = isDev && docker?.available && dockerSummary;
  const running = useDocker ? dockerSummary.running : envFunctions.filter((fn) => fn.status === "running").length;
  const containerApps = useDocker
    ? dockerSummary.running
    : targetMode === "azure"
      ? Math.max(azureFunctionContainerNames.length, azureContainerNames.length, target?.azure_container_app_name ? 1 : 0)
      : 0;
  const memoryActiveMb = useDocker ? dockerSummary.activeMemoryMb : estimated.deployed;
  const memoryConfiguredMb = useDocker ? dockerSummary.configuredMemoryMb : estimated.assigned;
  const runtimeSource = useDocker ? "docker-desktop" : targetMode === "azure" ? "azure" : "local";
  const targetState = useDocker
    ? (dockerSummary.running > 0 ? "running" : dockerSummary.containers > 0 ? "stopped" : "idle")
    : String(
      target?.azure_provisioning_status ||
      target?.platform_deploy_status ||
      target?.status ||
      ""
    ).toLowerCase();
  const containerName = useDocker
    ? (dockerSummary.containerNames?.[0] ? `Docker Desktop local (${dockerSummary.running})` : "Docker Desktop local")
    : azureContainerNames[0] || azureFunctionContainerNames[0] || "";
  const containerUrl = useDocker
    ? (envFunctions.find((fn) => fn.url)?.url || "")
    : target?.azure_container_app_url ||
      target?.platform_api_container_app_url ||
      target?.platform_web_container_app_url ||
      envFunctions.find((fn) => fn.url)?.url ||
      "";
  const hasContainer = useDocker
    ? containerApps > 0
    : Boolean(
      target?.azure_container_app_name ||
      target?.platform_api_container_app_name ||
      target?.platform_web_container_app_name ||
      azureFunctionContainerNames.length
    );
  let status = "idle";
  if (useDocker) {
    status = dockerSummary.running > 0 ? "running" : hasContainer ? "stopped" : "idle";
  } else if (["blocked"].includes(targetState)) status = "warning";
  else if (["deploying", "queued", "provisioning"].includes(targetState)) status = "deploying";
  else if (["failed", "error"].includes(targetState)) status = "error";
  else if (running > 0 || ["running", "active"].includes(targetState)) status = "running";
  else if (hasContainer || targetMode === "azure") status = "stopped";

  return {
    running,
    containerApps,
    memoryActiveMb,
    memoryConfiguredMb,
    runtimeSource,
    targetState,
    containerName,
    containerUrl,
    status,
    hasContainer,
  };
}

function azureContainerAppNamesForEnvironment(target, functions = [], { includeProbe = false } = {}) {
  const names = new Set();
  if (target?.deployment_mode === "azure") {
    const expected = azureContainerAppShardNamesForTarget(
      target,
      azureShardCountForFunctionCount(functions.length) + (includeProbe ? 8 : 0)
    );
    for (const name of expected) names.add(name);
  }
  for (const fn of functions) {
    const match = String(fn.container_id || "").match(/^azure:(.+)$/);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

function compactFunction(fn) {
  const { code, files, secrets, api_tokens, ...rest } = fn;
  return rest;
}

function promotedReadOnlyMessage(fn) {
  return `La funcion ${fn?.name || fn?.slug || "seleccionada"} es una copia promovida. Corrige el codigo en el ambiente origen y vuelve a promover para mantener la homologacion.`;
}

function isPromotedCopy(fn) {
  return Boolean(fn?.source_function_id);
}

function canDeployPromotedCopy(fn) {
  if (!isPromotedCopy(fn)) return true;
  return !["running", "deploying", "queued"].includes(String(fn.status || ""));
}

function promotedDeployBlockedMessage(fn) {
  return `La funcion ${fn?.name || fn?.slug || "seleccionada"} ya tiene un despliegue asociado en este ambiente. Para cambiar codigo o redeployar una version homologada, corrige el ambiente origen y vuelve a promover.`;
}

async function markPromotionDeployStarted(fn, { sourceSlug = "origen", targetSlug = fn?.environment_slug || "destino", projectWide = false } = {}) {
  if (!fn?.id) return;
  await updateFunctionStatus(fn.id, { status: "deploying" });
  await appendLog({
    function_id: fn.id,
    environment_id: fn.environment_id,
    message: `[promotion:deploying] ${projectWide ? "Promocion de proyecto" : "Promocion de funcion"} ${sourceSlug}->${targetSlug}. El destino queda bloqueado para cambios directos mientras se publica.`,
  });
}

function isExternalUrl(url) {
  return Boolean(url) && !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(String(url));
}

function databaseProvider() {
  if (getStoreMode() !== "postgres") return "local";
  const raw = process.env.DATABASE_URL || "";
  if (/neon\.tech/i.test(raw)) return "neon";
  return "postgres";
}

function firstApiToken(fn) {
  return (Array.isArray(fn?.api_tokens) ? fn.api_tokens : []).find((token) => token?.value)?.value || "";
}

async function waitForFunctionRoute(url, fn, { timeoutMs = 90000, intervalMs = 5000 } = {}) {
  if (!url || !/^https?:\/\//i.test(String(url))) return { ok: true, skipped: true };
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastError = "";
  const token = firstApiToken(fn);
  const headerName = fn?.auth_header_name || "x-api-key";
  const routeUrl = new URL(url);
  const routePath = routeUrl.pathname;
  const routeIndexUrl = `${routeUrl.origin}/__fpm/routes`;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const routeResponse = await fetch(routeIndexUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if (routeResponse.ok) {
        const payload = await routeResponse.json().catch(() => null);
        const routes = Array.isArray(payload?.routes) ? payload.routes : [];
        const exists = routes.some((route) =>
          route?.function_id === fn?.id ||
          route?.path === routePath ||
          (route?.function_slug && routePath.endsWith(`/${route.function_slug}`))
        );
        if (exists) return { ok: true, status: routeResponse.status, routeIndex: true };
      }

      const headers = token ? { [headerName]: token } : {};
      const response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      lastStatus = response.status;
      if (![404, 502, 503].includes(response.status)) {
        return { ok: true, status: response.status };
      }
    } catch (error) {
      lastError = error?.name === "AbortError" ? "timeout" : error?.message || String(error);
    } finally {
      clearTimeout(timer);
    }
    await sleep(intervalMs);
  }

  const detail = lastStatus ? `HTTP ${lastStatus}` : lastError || "sin respuesta";
  const error = new Error(`Azure acepto el deploy, pero la ruta ${url} aun no esta disponible (${detail}). No se marca como running para evitar una URL fantasma.`);
  error.statusCode = 504;
  error.code = "AZURE_ROUTE_NOT_READY";
  throw error;
}

const PLATFORM_DEPLOY_ENVIRONMENTS = new Set(["test", "prod"]);

function isPlatformDeploymentTarget(target) {
  return PLATFORM_DEPLOY_ENVIRONMENTS.has(String(target?.environment_slug || "").toLowerCase());
}

function platformTargetView(target = {}) {
  const rawStatus = String(target?.platform_deploy_status || "");
  const deployState = ["running", "blocked", "failed", "canceled"].includes(rawStatus);
  const lock = ["running", "blocked"].includes(rawStatus) ? platformDeployLock(target) : null;
  const stale = ["running", "blocked"].includes(rawStatus) && !lock;
  const startedAt = target?.platform_deploy_started_at || (deployState ? target?.updated_at || target?.platform_deployed_at || null : null);
  const fallbackMessage = stale
    ? "El deploy no reporto avances dentro del tiempo esperado. Puedes volver a ejecutarlo."
    : "Deploy iniciado antes de activar la consola de eventos. No hay trazas detalladas de ese intento.";
  const logs = Array.isArray(target?.platform_deploy_logs) ? target.platform_deploy_logs : [];
  const fallbackLogs = logs.length || !deployState ? logs : [{
    ts: startedAt || target?.updated_at || new Date().toISOString(),
    step: target?.platform_deploy_step || (stale ? "timeout" : rawStatus),
    percent: Number(target?.platform_deploy_percent || 0),
    status: stale ? "failed" : rawStatus,
    message: fallbackMessage,
  }];
  const webUrl = String(target?.platform_web_container_app_url || target?.azure_container_app_url || "").replace(/\/+$/, "");
  const authRedirectUri = webUrl ? `${webUrl}/callback` : "";
  return {
    ...target,
    platform_version: target?.platform_version || "1.0.0",
    platform_deploy_started_at: startedAt,
    platform_deploy_step: target?.platform_deploy_step || (stale ? "timeout" : rawStatus || null),
    platform_deploy_percent: Number(target?.platform_deploy_percent || 0),
    platform_deploy_logs: fallbackLogs,
    platform_deploy_status: stale ? "failed" : target?.platform_deploy_status,
    platform_deploy_error: stale ? target?.platform_deploy_error || fallbackMessage : target?.platform_deploy_error,
    platform_ready: Boolean(target?.platform_api_container_app_url && target?.platform_web_container_app_url),
    auth_redirect_uri: authRedirectUri,
  };
}

function normalizePlatformVersion(value = "1.0.0") {
  const text = String(value || "1.0.0").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text)) {
    throw new Error("La version de plataforma debe tener formato semver, por ejemplo 1.0.0");
  }
  return text;
}

function platformDeployLock(target) {
  const status = String(target?.platform_deploy_status || "");
  if (!["running", "blocked"].includes(status)) return null;
  const ttlMs = status === "blocked" ? 10 * 60 * 1000 : 60 * 60 * 1000;
  const updatedAt = Date.parse(target?.updated_at || target?.platform_deployed_at || "");
  const expiresAt = Number.isFinite(updatedAt) ? updatedAt + ttlMs : Date.now() + ttlMs;
  if (expiresAt <= Date.now()) return null;
  return {
    status,
    expiresAt,
    message: status === "blocked"
      ? "Azure tiene una operacion de provisioning activa para este Container App. Espera unos minutos antes de volver a desplegar."
      : "Ya hay un despliegue de plataforma en curso para este ambiente.",
  };
}

function platformDeployLogEntry({ step = "", percent = 0, message = "", status = "running" } = {}) {
  return {
    ts: new Date().toISOString(),
    step,
    percent: Math.max(0, Math.min(100, Number(percent || 0))),
    status,
    message: String(message || ""),
  };
}

function platformDeployCanceledError() {
  const error = new Error("Deploy cancelado manualmente desde Configuracion.");
  error.code = "PLATFORM_DEPLOY_CANCELED";
  error.statusCode = 409;
  return error;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function platformSyncAuthorized(req, target) {
  const provided = String(req.headers["x-fpm-platform-sync-token"] || req.headers["x-fpm-sync-token"] || "");
  const expected = platformSyncToken(target);
  return Boolean(provided && expected && provided === expected);
}

function platformImpactPatch(body = {}) {
  const allowed = [
    "platform_api_container_app_name",
    "platform_api_container_app_url",
    "platform_api_image",
    "platform_web_container_app_name",
    "platform_web_container_app_url",
    "platform_web_image",
    "platform_version",
    "platform_deployed_version",
    "platform_deployed_at",
    "platform_deploy_started_at",
    "platform_deploy_step",
    "platform_deploy_percent",
    "platform_deploy_logs",
    "platform_deploy_status",
    "platform_deploy_error",
  ];
  return Object.fromEntries(Object.entries(body || {}).filter(([key, value]) =>
    allowed.includes(key) && value !== undefined
  ));
}

async function syncPlatformImpactToRemote(apiUrl, target, patch) {
  if (!apiUrl) return { ok: false, error: "API remota no disponible" };
  const endpoint = `${String(apiUrl).replace(/\/+$/, "")}/api/platform/container-apps/${target.id}/impact`;
  const token = platformSyncToken(target);
  const tenantId = getRequestTenantId();
  let lastError = "";
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fpm-platform-sync-token": token,
          ...(tenantId ? { "x-tenant-id": tenantId } : {}),
        },
        body: JSON.stringify(patch),
      });
      if (response.ok) {
        return { ok: true, endpoint };
      }
      const text = await response.text().catch(() => "");
      lastError = `HTTP ${response.status}: ${text.slice(0, 500)}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(4000);
  }
  return { ok: false, endpoint, error: lastError || "No se pudo sincronizar el estado remoto" };
}

function remotePlatformApiUrl(target = {}) {
  return String(target?.platform_api_container_app_url || "").replace(/\/+$/, "");
}

async function deploymentTargetForFunctionImpact(snapshot = {}) {
  if (!snapshot?.project_id || !snapshot?.environment_id) return null;
  return (await listDeploymentTargets({
    project_id: snapshot.project_id,
    environment_id: snapshot.environment_id,
    includeSecrets: true,
  }))[0] || null;
}

async function syncFunctionImpactToRemote(fn, { reason = "promotion" } = {}) {
  if (!fn?.id) return { ok: false, skipped: true, error: "Funcion no disponible" };
  try {
    const target = await getDeploymentTargetForFunction(fn, { includeSecrets: true });
    const apiUrl = remotePlatformApiUrl(target);
    if (!target || !isExternalUrl(apiUrl)) {
      return {
        ok: false,
        skipped: true,
        reason: "remote_api_not_configured",
      };
    }

    const snapshot = await getFunction(fn.id);
    const endpoint = `${apiUrl}/api/platform/functions/${snapshot.id}/impact`;
    const token = platformSyncToken(target);
    const tenantId = getRequestTenantId();
    let lastError = "";

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-fpm-platform-sync-token": token,
            ...(tenantId ? { "x-tenant-id": tenantId } : {}),
          },
          body: JSON.stringify({ function: snapshot, reason }),
          signal: controller.signal,
        });
        if (response.ok) return { ok: true, endpoint };
        const text = await response.text().catch(() => "");
        lastError = `HTTP ${response.status}: ${text.slice(0, 500)}`;
        if ([400, 401, 403, 404].includes(response.status)) break;
      } catch (error) {
        lastError = error?.name === "AbortError" ? "timeout" : error?.message || String(error);
      } finally {
        clearTimeout(timer);
      }
      await sleep(1500);
    }

    await appendLog({
      function_id: snapshot.id,
      environment_id: snapshot.environment_id,
      message: `[sync:remote:error] No se pudo impactar el API remoto del ambiente (${lastError || "sin detalle"}).`,
    });
    return { ok: false, endpoint, error: lastError || "No se pudo impactar el API remoto" };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function syncFunctionsImpactToRemote(functions, options = {}) {
  const results = [];
  for (const fn of functions || []) {
    if (!fn?.id) continue;
    results.push({
      function_id: fn.id,
      function_slug: fn.slug,
      ...(await syncFunctionImpactToRemote(fn, options)),
    });
  }
  return results;
}

function isAzureContainerBusyError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`;
  return error?.code === "AZURE_CONTAINER_APP_BUSY" ||
    /active provisioning operation|provisioning operation.*progress|cannot modify a container app|Azure sigue procesando|Azure todavia esta procesando/i.test(text);
}

async function healthHandler(_req, reply) {
  const started = Date.now();
  const database = getStoreMode() === "postgres" ? "postgres" : getStoreMode();
  const provider = databaseProvider();
  const timestamp = new Date().toISOString();

  try {
    if (getStoreMode() === "postgres") {
      await q("SELECT 1");
    }

    return {
      status: "operational",
      version: process.env.FPM_PLATFORM_VERSION || process.env.APP_VERSION || "dev",
      responseTime: Date.now() - started,
      database,
      provider,
      timestamp,
    };
  } catch (error) {
    app.log.error(error);
    return reply.code(503).send({
      status: "degraded",
      version: process.env.FPM_PLATFORM_VERSION || process.env.APP_VERSION || "dev",
      responseTime: Date.now() - started,
      database,
      provider,
      timestamp,
    });
  }
}

app.get("/api/meta", async () => ({
  ok: true,
  store: getStoreMode(),
  ai_validation: Boolean(process.env.OPENAI_API_KEY || process.env.AI_API_KEY),
}));

app.get("/api/dashboard", async (req) => {
  const scope = {
    project_id: req.query?.project_id,
    environment_id: req.query?.environment_id,
    environment_slug: req.query?.environment_slug,
  };
  const [projects, functions, deployments, targets, environmentsResult, docker] = await Promise.all([
    listProjects(),
    listFunctions(scope),
    listDeployments(scope),
    listDeploymentTargets(scope),
    listEnvironments({ project_id: scope.project_id, environment_slug: scope.environment_slug }),
    getDockerStatus({ includeEnvironmentStats: true }),
  ]);

  const environments = environmentsResult.rows || [];
  const scopedProjectIds = new Set([
    ...environments.map((env) => env.project_id).filter(Boolean),
    ...functions.map((fn) => fn.project_id).filter(Boolean),
    ...deployments.map((deployment) => deployment.project_id).filter(Boolean),
    ...targets.map((target) => target.project_id).filter(Boolean),
  ]);
  const failedDeployments = deployments.filter((deployment) =>
    ["failed", "error"].includes(deployment.status) || deployment.validation_status === "failed"
  ).length;
  const successfulDeployments = deployments.filter((deployment) => deployment.status === "success").length;
  const failedFunctions = functions.filter((fn) => fn.status === "error" || fn.validation_status === "failed").length;
  const healthyFunctions = functions.filter((fn) => fn.status !== "error" && fn.validation_status !== "failed").length;
  const availabilityRate = functions.length ? Math.round((healthyFunctions / functions.length) * 1000) / 10 : 100;
  const targetForEnv = new Map(targets.map((target) => [target.environment_id, target]));
  const functionsByEnv = new Map();
  const deploymentsByEnv = new Map();

  for (const fn of functions) {
    const key = fn.environment_id || "none";
    functionsByEnv.set(key, [...(functionsByEnv.get(key) || []), fn]);
  }
  for (const deployment of deployments) {
    const key = deployment.environment_id || "none";
    deploymentsByEnv.set(key, [...(deploymentsByEnv.get(key) || []), deployment]);
  }

  const environmentStatus = environments.map((env) => {
    const envFunctions = functionsByEnv.get(env.id) || [];
    const envDeployments = deploymentsByEnv.get(env.id) || [];
    const envFailedFunctions = envFunctions.filter((fn) => fn.status === "error" || fn.validation_status === "failed").length;
    const envFailedDeployments = envDeployments.filter((deployment) =>
      ["failed", "error"].includes(deployment.status) || deployment.validation_status === "failed"
    ).length;
    const target = targetForEnv.get(env.id);
    const targetConfigured = Boolean(target && target.deployment_mode && target.deployment_mode !== "manual");
    const runtime = environmentRuntimeSummary(env, envFunctions, target, docker);
    const measuredDeployments = envDeployments.filter((deployment) => {
      if (deployment.status !== "success") return false;
      if (target?.deployment_mode === "azure") return isExternalUrl(deployment.url);
      if (target?.deployment_mode === "git") return isExternalUrl(deployment.url);
      return false;
    });
    const envAvailability = runtime.runtimeSource === "docker-desktop"
      ? Math.round(((runtime.running - envFailedFunctions) / Math.max(runtime.running, 1)) * 1000) / 10
      : targetConfigured && measuredDeployments.length
        ? Math.round(((envFunctions.length - envFailedFunctions) / Math.max(envFunctions.length, 1)) * 1000) / 10
        : null;
    const memory = environmentMemorySummary(target, envFunctions);
    const overBudget = memory.overBudget;
    const ready = envAvailability !== null && envFailedFunctions === 0 && envFailedDeployments === 0 && !overBudget;
    const status = runtime.runtimeSource === "docker-desktop"
      ? runtime.status
      : overBudget
        ? "over_budget"
        : !targetConfigured
          ? "not_configured"
          : envAvailability === null
            ? "pending"
            : ready ? "healthy" : "attention";

    return {
      project_id: env.project_id,
      project_name: env.project_name || projects.find((project) => project.id === env.project_id)?.name || "Sin proyecto",
      environment_id: env.id,
      environment_name: env.name,
      environment_slug: env.slug,
      functions: envFunctions.length,
      running: envFunctions.filter((fn) => fn.status === "running").length,
      failed_functions: envFailedFunctions,
      deployments: envDeployments.length,
      failed_deployments: envFailedDeployments,
      availability: envAvailability,
      target_mode: target?.deployment_mode || "manual",
      target_auto_deploy: Boolean(target?.auto_deploy),
      target_configured: targetConfigured,
      memory_assigned_mb: memory.assigned,
      memory_budget_mb: memory.budget,
      memory_deployed_mb: runtime.memoryActiveMb,
      memory_available_mb: memory.available,
      memory_usage_pct: memory.pct,
      memory_active_mb: runtime.memoryActiveMb,
      memory_configured_mb: runtime.memoryConfiguredMb,
      container_apps: runtime.containerApps,
      container_name: runtime.containerName,
      container_url: runtime.containerUrl,
      runtime_source: runtime.runtimeSource,
      target_state: runtime.targetState,
      status,
    };
  });

  return {
    totals: {
      projects: scope.project_id ? (scopedProjectIds.size || 1) : scopedProjectIds.size,
      environments: environments.length,
      functions: functions.length,
      running: functions.filter((fn) => fn.status === "running").length,
      deployments: deployments.length,
      successful: successfulDeployments,
      failed: failedDeployments,
      failedFunctions,
      issues: failedDeployments + failedFunctions,
      availabilityRate,
      targets: targets.length,
    },
    recentFunctions: functions.slice(0, 8).map(compactFunction),
    environmentStatus,
    system: {
      docker,
      targets: {
        total: targets.length,
        configured: targets.filter((target) => target.deployment_mode && target.deployment_mode !== "manual").length,
        autoDeploy: targets.filter((target) => target.auto_deploy).length,
      },
    },
    store: getStoreMode(),
    ai_validation: Boolean(process.env.OPENAI_API_KEY || process.env.AI_API_KEY),
  };
});

// Projects
app.get("/api/projects", async () => listProjects());

app.post("/api/projects", async (req, reply) => {
  const { name, description } = req.body ?? {};
  if (!name?.trim()) return reply.code(400).send({ error: "name required" });
  return createProject({ name, description });
});

app.get("/api/projects/:id", async (req, reply) => {
  const project = await getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "not found" });
  return project;
});

app.get("/api/projects/:id/secrets", async (req, reply) => {
  const project = await getProject(req.params.id);
  if (!project) return reply.code(404).send({ error: "not found" });
  return listSecretsForProject(req.params.id, {
    environment_id: req.query?.environment_id || undefined,
    environment_slug: req.query?.environment_slug || undefined,
  });
});

app.post("/api/projects/:id/secrets", async (req, reply) => {
  try {
    const result = await createProjectSecret(req.params.id, req.body ?? {});
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

app.post("/api/projects/:id/secrets/copy", async (req, reply) => {
  try {
    const result = await copyProjectSecretsBetweenEnvironments(req.params.id, req.body ?? {});
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

app.post("/api/projects/:id/promote", async (req, reply) => {
  try {
    const result = await promoteProject(req.params.id, req.body ?? {});
    if (!result) return reply.code(404).send({ error: "not found" });
    const deployAfterPromote = Boolean(req.body?.deploy_after_promote);

    if (deployAfterPromote) {
      await Promise.all((result.promoted || []).map((fn) => markPromotionDeployStarted(fn, {
        sourceSlug: result.source_environment?.slug || req.body?.source_environment_slug,
        targetSlug: result.target_environment?.slug || req.body?.target_environment_slug,
        projectWide: true,
      })));
    } else {
      await Promise.all((result.promoted || []).map((fn) => appendLog({
        function_id: fn.id,
        environment_id: fn.environment_id,
        message: `[promotion:staged] Promocion de proyecto ${result.source_environment?.slug || "origen"}->${result.target_environment?.slug || "destino"} sincronizada sin deploy automatico.`,
      })));
    }

    const deployed = await deployPromotedFunctionsIfNeeded(result.promoted, {
      force: deployAfterPromote,
      version: req.body?.version,
    });

    const refreshedPromoted = await Promise.all(
      (result.promoted || []).map(async (fn) => (await getFunction(fn.id)) || fn)
    );
    const remoteSync = await syncFunctionsImpactToRemote(refreshedPromoted, {
      reason: deployAfterPromote ? "project-promotion-deploy" : "project-promotion",
    });

    return { ...result, promoted: refreshedPromoted, deployed, remote_sync: remoteSync };
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

// Environments
app.get("/api/environments", async (req) => {
  const result = await listEnvironments({
    project_id: req.query?.project_id,
    environment_slug: req.query?.environment_slug || req.query?.slug,
  });
  return result.rows;
});

app.post("/api/environments/:id/memory-budget", async (req, reply) => {
  try {
    const env = await getEnvironment(req.params.id);
    if (!env) return reply.code(404).send({ error: "environment not found" });
    const projectId = req.body?.project_id || env.project_id;
    if (projectId !== env.project_id) {
      return reply.code(400).send({ error: "El ambiente no pertenece al proyecto indicado" });
    }
    const memoryBudget = Math.max(0, asInt(req.body?.memory_budget_mb, 0));
    const existing = (await listDeploymentTargets({
      project_id: env.project_id,
      environment_id: env.id,
      includeSecrets: true,
    }))[0] || {};
    const target = await upsertDeploymentTarget({
      ...existing,
      project_id: env.project_id,
      environment_id: env.id,
      memory_budget_mb: memoryBudget,
    });

    const azureSync = {
      status: "skipped",
      updated: 0,
      failed: 0,
      skipped: 0,
      results: [],
      message: "Umbral guardado como configuracion interna. No se sincroniza memoria en Azure ni se bloquean deploys por MB.",
    };

    return { ok: true, target, azure_sync: azureSync };
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

app.post("/api/environments/:id/stop", async (req, reply) => {
  try {
    const env = await getEnvironment(req.params.id);
    if (!env) return reply.code(404).send({ error: "environment not found" });
    const projectId = req.body?.project_id || env.project_id;
    if (projectId !== env.project_id) {
      return reply.code(400).send({ error: "El ambiente no pertenece al proyecto indicado" });
    }
    const functions = await listFunctions({ project_id: env.project_id, environment_id: env.id });
    const target = (await listDeploymentTargets({
      project_id: env.project_id,
      environment_id: env.id,
      includeSecrets: true,
    }))[0];
    let providerResult = null;
    if (target?.deployment_mode === "azure") {
      if (!isAzureTargetProvisioned(target)) {
        return reply.code(409).send({
          error: azureProvisioningRequiredMessage(target),
          code: "AZURE_CONTAINER_REQUIRED",
        });
      }
      providerResult = await stopAzureTargetContainerApp(target, {
        appNames: azureContainerAppNamesForEnvironment(target, functions, { includeProbe: true }),
      });
    } else {
      for (const fn of functions) {
        await stopAndRemove(fn.id);
      }
      providerResult = {
        status: "stopped",
        message: `Contenedores locales del ambiente ${env.name} detenidos.`,
      };
    }
    for (const fn of functions) {
      await updateFunctionStatus(fn.id, { status: "stopped" });
      await appendLog({
        function_id: fn.id,
        environment_id: env.id,
        message: `[environment:stop] ${providerResult.message}`,
      });
    }
    return {
      ok: true,
      provider: target?.deployment_mode || "local",
      affected_functions: functions.length,
      provider_result: providerResult,
      message: `Ambiente ${env.name} detenido. ${providerResult.message}`,
    };
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

app.post("/api/environments/:id/start", async (req, reply) => {
  try {
    const env = await getEnvironment(req.params.id);
    if (!env) return reply.code(404).send({ error: "environment not found" });
    const projectId = req.body?.project_id || env.project_id;
    if (projectId !== env.project_id) {
      return reply.code(400).send({ error: "El ambiente no pertenece al proyecto indicado" });
    }
    const functions = await listFunctions({ project_id: env.project_id, environment_id: env.id });
    const target = (await listDeploymentTargets({
      project_id: env.project_id,
      environment_id: env.id,
      includeSecrets: true,
    }))[0];

    if (target?.deployment_mode !== "azure") {
      return reply.code(400).send({
        error: "El inicio de ambiente solo esta automatizado para Azure Container Apps. En local vuelve a desplegar las funciones necesarias.",
      });
    }
    if (!isAzureTargetProvisioned(target)) {
      return reply.code(409).send({
        error: azureProvisioningRequiredMessage(target),
        code: "AZURE_CONTAINER_REQUIRED",
      });
    }

    const providerResult = await startAzureTargetContainerApp(target, {
      appNames: azureContainerAppNamesForEnvironment(target, functions, { includeProbe: true }),
    });
    let restored = 0;
    for (const fn of functions) {
      if (!fn.url && !String(fn.container_id || "").startsWith("azure:")) continue;
      await updateFunctionStatus(fn.id, { status: "running" });
      restored += 1;
      await appendLog({
        function_id: fn.id,
        environment_id: env.id,
        message: `[environment:start] ${providerResult.message}`,
      });
    }

    return {
      ok: true,
      provider: "azure",
      affected_functions: restored,
      provider_result: providerResult,
      message: `Ambiente ${env.name} iniciado. ${providerResult.message}`,
    };
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

// Functions
app.get("/api/functions", async (req) => {
  const functions = await listFunctions({
    project_id: req.query?.project_id,
    environment_id: req.query?.environment_id,
    environment_slug: req.query?.environment_slug,
  });
  return functions.map(compactFunction);
});

app.get("/api/functions/:id", async (req, reply) => {
  const fn = await getFunction(req.params.id);
  if (!fn) return reply.code(404).send({ error: "not found" });
  return fn;
});

app.post("/api/functions", async (req, reply) => {
  const {
    name,
    description,
    code,
    files,
    entrypoint,
    project_id,
    environment_id,
    runtime = "node20",
    memory_mb = 256,
    timeout_seconds = 30,
    auth_required = false,
    auth_header_name = "x-api-key",
  } = req.body ?? {};

  if (!name?.trim()) return reply.code(400).send({ error: "name required" });

  return createFunction({
    name,
    description,
    code: code || undefined,
    files,
    entrypoint,
    project_id: project_id || null,
    environment_id: environment_id || null,
    runtime,
    memory_mb: asInt(memory_mb, 256),
    timeout_seconds: asInt(timeout_seconds, 30),
    auth_required,
    auth_header_name,
  });
});

app.put("/api/functions/:id", async (req, reply) => {
  const existing = await getFunction(req.params.id);
  if (!existing) return reply.code(404).send({ error: "not found" });
  if (isPromotedCopy(existing)) {
    return reply.code(409).send({
      error: promotedReadOnlyMessage(existing),
      code: "PROMOTED_FUNCTION_READ_ONLY",
    });
  }
  const updated = await updateFunction(req.params.id, req.body ?? {});
  return updated;
});

app.post("/api/functions/:id/tokens", async (req, reply) => {
  const token = await createFunctionToken(req.params.id, req.body ?? {});
  if (!token) return reply.code(404).send({ error: "not found" });
  await updateFunction(req.params.id, { auth_required: true });
  return token;
});

app.delete("/api/functions/:id/tokens/:tokenId", async (req, reply) => {
  const result = await deleteFunctionToken(req.params.id, req.params.tokenId);
  if (!result) return reply.code(404).send({ error: "not found" });
  return result;
});

app.delete("/api/functions/:id", async (req) => {
  const { id } = req.params;
  try {
    await stopAndRemove(id);
  } catch {}
  await deleteFunction(id);
  return { ok: true };
});

app.post("/api/functions/:id/promote", async (req, reply) => {
  try {
    const source = await getFunction(req.params.id);
    if (!source) return reply.code(404).send({ error: "not found" });
    const promoted = await promoteFunction(req.params.id, req.body ?? {});
    if (!promoted) return reply.code(404).send({ error: "not found" });
    const deployAfterPromote = Boolean(req.body?.deploy_after_promote);
    if (deployAfterPromote) {
      await markPromotionDeployStarted(promoted, {
        sourceSlug: source.environment_slug || "origen",
        targetSlug: promoted.environment_slug || req.body?.target_environment_slug || "destino",
      });
    } else {
      await appendLog({
        function_id: promoted.id,
        environment_id: promoted.environment_id,
        message: `[promotion:staged] Funcion promovida desde ${source.environment_slug || "origen"} hacia ${promoted.environment_slug || req.body?.target_environment_slug || "destino"} sin deploy automatico.`,
      });
    }
    const deployment = await deployPromotedFunctionIfNeeded(promoted, {
      force: deployAfterPromote,
      version: req.body?.version,
    });
    const refreshed = (await getFunction(promoted.id)) || promoted;
    const remoteSync = await syncFunctionImpactToRemote(refreshed, {
      reason: deployAfterPromote ? "function-promotion-deploy" : "function-promotion",
    });
    return deployment
      ? { ...refreshed, deployment_result: deployment, remote_sync: remoteSync }
      : { ...refreshed, remote_sync: remoteSync };
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

// Secrets
app.post("/api/functions/:id/secrets", async (req, reply) => {
  try {
    const result = await upsertSecret(req.params.id, req.body ?? {});
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

app.delete("/api/secrets/:sid", async (req) => {
  await deleteSecret(req.params.sid);
  return { ok: true };
});

app.patch("/api/secrets/:sid", async (req, reply) => {
  try {
    const result = await updateSecret(req.params.sid, req.body ?? {});
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

// Validation
app.post("/api/functions/:id/validate", async (req, reply) => {
  const fn = await getFunction(req.params.id);
  if (!fn) return reply.code(404).send({ error: "not found" });
  if (isPromotedCopy(fn)) {
    return reply.code(409).send({
      error: promotedReadOnlyMessage(fn),
      code: "PROMOTED_FUNCTION_READ_ONLY",
    });
  }

  const validation = await validateFunctionCode(fn, { repair: true });
  const updatedFn = await applyValidationSource(fn, validation);
  await updateFunctionStatus(fn.id, {
    validation_status: validation.status,
    validation_summary: validation.summary,
  });
  const refreshedFn = await getFunction(fn.id);
  await persistValidationLogs(refreshedFn || updatedFn || fn, validation);
  return { ...validation, function: refreshedFn ? compactFunction(refreshedFn) : null };
});

async function applyValidationSource(fn, validation) {
  if (isPromotedCopy(fn)) return fn;

  if (validation.repaired_source) {
    return updateFunction(fn.id, validation.repaired_source);
  }

  if (
    (validation.runtime && validation.runtime !== fn.runtime) ||
    (validation.entrypoint && validation.entrypoint !== fn.entrypoint)
  ) {
    return updateFunction(fn.id, {
      runtime: validation.runtime,
      files: fn.files,
      entrypoint: validation.entrypoint,
    });
  }

  return fn;
}

async function persistValidationLogs(fn, validation, deploymentId = null) {
  const prefix = `[validation:${validation.status}]`;
  await appendLog({
    function_id: fn.id,
    environment_id: fn.environment_id,
    deployment_id: deploymentId,
    message: `${prefix} ${validation.summary}`,
  });

  for (const finding of validation.findings || []) {
    await appendLog({
      function_id: fn.id,
      environment_id: fn.environment_id,
      deployment_id: deploymentId,
      message: `[validation:${finding.severity}] ${finding.line ? `line ${finding.line}: ` : ""}${finding.message}`,
    });
  }

  if (validation.repair) {
    await appendLog({
      function_id: fn.id,
      environment_id: fn.environment_id,
      deployment_id: deploymentId,
      message: `[validation:repair:${validation.repair.applied ? "applied" : "skipped"}] ${validation.repair.summary}`,
    });

    for (const change of validation.repair.changes || []) {
      await appendLog({
        function_id: fn.id,
        environment_id: fn.environment_id,
        deployment_id: deploymentId,
        message: `[validation:fix] ${change.path ? `${change.path}: ` : ""}${change.message}`,
      });
    }

    if (validation.repaired_source) {
      await appendLog({
        function_id: fn.id,
        environment_id: fn.environment_id,
        deployment_id: deploymentId,
        message: `[validation:fix] Codigo actualizado automaticamente. Runtime=${validation.repaired_source.runtime}, entrypoint=${validation.repaired_source.entrypoint}`,
      });
    }
  }

  if (validation.ai?.enabled && validation.ai.status && validation.ai.status !== "passed") {
    await appendLog({
      function_id: fn.id,
      environment_id: fn.environment_id,
      deployment_id: deploymentId,
      message: `[validation:ai:${validation.ai.status}] ${validation.ai.summary}`,
    });
  }
}

async function deployPromotedFunctionIfNeeded(fn, { force = false, version = null } = {}) {
  const target = await getDeploymentTargetForFunction(fn, { includeSecrets: true });
  const shouldDeploy = force || Boolean(target?.auto_deploy);
  if (!shouldDeploy) return null;
  return deployFunction(fn.id, { version: version || fn.active_deploy_version || "v1" });
}

async function deployPromotedFunctionsIfNeeded(functions, { force = false, version = null } = {}) {
  const promoted = (functions || []).filter(Boolean);
  if (!promoted.length) return [];

  const groups = new Map();
  for (const fn of promoted) {
    const key = `${fn.project_id || ""}:${fn.environment_id || ""}`;
    groups.set(key, [...(groups.get(key) || []), fn]);
  }

  const results = [];
  for (const group of groups.values()) {
    const target = await getDeploymentTargetForFunction(group[0], { includeSecrets: true });
    const shouldDeploy = force || Boolean(target?.auto_deploy);
    if (!shouldDeploy) continue;

    if (target?.deployment_mode === "azure") {
      const result = await deployAzurePromotedFunctionBatch(group, target, { version });
      results.push(...result);
      continue;
    }

    for (const fn of group) {
      const deployment = await deployFunction(fn.id, { version: version || fn.active_deploy_version || "v1" });
      if (deployment) results.push({ function_id: fn.id, function_slug: fn.slug, ...deployment });
    }
  }

  return results;
}

async function deployAzurePromotedFunctionBatch(promoted, target, { version = null } = {}) {
  if (!isAzureTargetProvisioned(target)) {
    const message = azureProvisioningRequiredMessage(target);
    for (const fn of promoted) {
      await appendLog({
        function_id: fn.id,
        environment_id: fn.environment_id,
        message: `[deploy:blocked] ${message}`,
      });
    }
    return promoted.map((fn) => ({
      function_id: fn.id,
      function_slug: fn.slug,
      ok: false,
      statusCode: 409,
      code: "AZURE_CONTAINER_REQUIRED",
      error: message,
    }));
  }

  const prepared = [];
  for (const sourceFn of promoted) {
    const deployVersion = normalizeDeployVersion(version || sourceFn.active_deploy_version || "v1");
    let fn = await getFunction(sourceFn.id);
    const validation = await validateFunctionCode(fn, { repair: !isPromotedCopy(fn) });
    fn = await applyValidationSource(fn, validation);
    await updateFunctionStatus(fn.id, {
      validation_status: validation.status,
      validation_summary: validation.summary,
    });

    const deployment = await createDeployment(fn, {
      status: validation.blocking ? "failed" : "deploying",
      version: deployVersion,
      validation_status: validation.status,
      validation_summary: validation.summary,
    });
    await persistValidationLogs(fn, validation, deployment.id);

    if (validation.blocking) {
      await finishDeployment(deployment.id, {
        status: "failed",
        validation_status: validation.status,
        validation_summary: validation.summary,
        error: "validation failed",
      });
      await updateFunctionStatus(fn.id, { status: "error" });
      prepared.push({
        fn,
        deployVersion,
        deployment,
        validation,
        blocked: true,
      });
      continue;
    }

    await updateFunctionStatus(fn.id, { status: "deploying" });
    prepared.push({
      fn,
      deployVersion,
      deployment,
      validation,
      blocked: false,
    });
  }

  const deployable = prepared.filter((item) => !item.blocked);
  if (!deployable.length) {
    return prepared.map((item) => ({
      function_id: item.fn.id,
      function_slug: item.fn.slug,
      ok: false,
      statusCode: 422,
      error: "validation failed",
      validation: item.validation,
    }));
  }

  const primary = deployable[0];
  try {
    const deployableById = new Map(deployable.map((item) => [item.fn.id, item]));
    const envFunctions = await listFunctions({ project_id: primary.fn.project_id, environment_id: primary.fn.environment_id });
    const knownContainerAppNames = azureContainerAppNamesForEnvironment(target, envFunctions);
    const azureFunctions = envFunctions
      .map((item) => deployableById.get(item.id)?.fn || item)
      .filter((item) => deployableById.has(item.id) || item.status === "running");
    const environmentFunctions = [];
    for (const item of azureFunctions) {
      const promotedItem = deployableById.get(item.id);
      environmentFunctions.push({
        fn: item,
        secrets: await getSecretsForFunction(item.id),
        version: promotedItem
          ? promotedItem.deployVersion
          : normalizeDeployVersion(item.active_deploy_version || "v1"),
      });
    }

    const primarySecrets = await getSecretsForFunction(primary.fn.id);
    const providerResult = await deployToAzureContainerApp(primary.fn, primarySecrets, target, {
      version: primary.deployVersion,
      environmentFunctions,
      knownContainerAppNames,
    });
    const routeByFunctionId = new Map((providerResult.routes || []).map((route) => [route.function_id, route]));

    await Promise.all(deployable.map(async (item) => {
      const route = routeByFunctionId.get(item.fn.id);
      const url = route?.url || providerResult.url;
      await appendLog({
        function_id: item.fn.id,
        environment_id: item.fn.environment_id,
        deployment_id: item.deployment.id,
        message: `[deploy:probe] Verificando disponibilidad de ${url}`,
      });
      await waitForFunctionRoute(url, item.fn);
    }));

    for (const route of providerResult.routes || []) {
      await updateFunctionStatus(route.function_id, {
        status: "running",
        container_id: `azure:${route.container_app_name || providerResult.containerAppName}`,
        url: route.url,
        active_deploy_version: route.version,
      });
    }

    for (const item of deployable) {
      const route = routeByFunctionId.get(item.fn.id);
      await finishDeployment(item.deployment.id, {
        status: "success",
        url: route?.url || providerResult.url,
        validation_status: item.validation.status,
        validation_summary: item.validation.summary,
      });
      await appendLog({
        function_id: item.fn.id,
        environment_id: item.fn.environment_id,
        deployment_id: item.deployment.id,
        message: `[deploy:azure] ${route?.version || item.deployVersion} ${providerResult.message}`,
      });
    }

    return prepared.map((item) => {
      if (item.blocked) {
        return {
          function_id: item.fn.id,
          function_slug: item.fn.slug,
          ok: false,
          statusCode: 422,
          error: "validation failed",
          validation: item.validation,
        };
      }
      const route = routeByFunctionId.get(item.fn.id);
      return {
        function_id: item.fn.id,
        function_slug: item.fn.slug,
        ok: true,
        deployment_id: item.deployment.id,
        url: route?.url || providerResult.url,
        provider: "azure",
        providerResult,
        validation: item.validation,
      };
    });
  } catch (error) {
    app.log.error(error);
    const statusCode = Number(error?.statusCode || error?.status || 500);
    for (const item of deployable) {
      await updateFunctionStatus(item.fn.id, { status: "error" });
      await finishDeployment(item.deployment.id, {
        status: "failed",
        validation_status: item.validation.status,
        validation_summary: item.validation.summary,
        error: String(error?.message || error),
      });
      await appendLog({
        function_id: item.fn.id,
        environment_id: item.fn.environment_id,
        deployment_id: item.deployment.id,
        message: `[deploy:error] ${error?.message || error}`,
      });
    }

    return prepared.map((item) => ({
      function_id: item.fn.id,
      function_slug: item.fn.slug,
      ok: false,
      statusCode: item.blocked ? 422 : statusCode,
      code: error?.code,
      error: item.blocked ? "validation failed" : String(error?.message || error),
      validation: item.validation,
      memory: error?.memory,
    }));
  }
}

async function reusableAzureDeployment(fn, version) {
  if (
    fn.status !== "running" ||
    !String(fn.container_id || "").startsWith("azure:") ||
    !fn.url ||
    normalizeDeployVersion(fn.active_deploy_version || "v1") !== version
  ) {
    return null;
  }

  const deployments = await listDeployments({ function_id: fn.id });
  const active = deployments.find((deployment) =>
    deployment.active &&
    deployment.status === "success" &&
    normalizeDeployVersion(deployment.version || "v1") === version &&
    deployment.url
  );
  if (!active) return null;

  const deployedAt = Date.parse(active.finished_at || active.created_at || "");
  const updatedAt = Date.parse(fn.updated_at || "");
  if (Number.isFinite(deployedAt) && Number.isFinite(updatedAt) && updatedAt > deployedAt) return null;
  return active;
}

async function deployFunction(id, { version = null, note = null, source_deployment_id = null } = {}) {
  let fn = await getFunction(id);
  if (!fn) return { ok: false, statusCode: 404, error: "not found" };
  const deployVersion = normalizeDeployVersion(version || fn.active_deploy_version || "v1");
  let target = await getDeploymentTargetForFunction(fn, { includeSecrets: true });

  if (target?.deployment_mode === "azure" && !isAzureTargetProvisioned(target)) {
    const message = azureProvisioningRequiredMessage(target);
    await appendLog({
      function_id: fn.id,
      environment_id: fn.environment_id,
      message: `[deploy:blocked] ${message}`,
    });
    return {
      ok: false,
      statusCode: 409,
      code: "AZURE_CONTAINER_REQUIRED",
      error: message,
    };
  }

  if (target?.deployment_mode === "azure") {
    const reusable = await reusableAzureDeployment(fn, deployVersion);
    if (reusable) {
      const message = `La funcion ${fn.slug || fn.name} ya esta desplegada en Azure como ${deployVersion}. No se reconstruyo la imagen.`;
      await appendLog({
        function_id: fn.id,
        environment_id: fn.environment_id,
        message: `[deploy:skip] ${message}`,
      });
      return {
        ok: true,
        skipped: true,
        url: reusable.url || fn.url,
        provider: "azure",
        validation: fn.validation_status ? {
          status: fn.validation_status,
          blocking: fn.validation_status === "failed",
          summary: fn.validation_summary || "Validacion previa",
          findings: [],
        } : null,
        providerResult: {
          provider: "azure",
          skipped: true,
          containerAppName: String(fn.container_id || "").replace(/^azure:/, ""),
          url: reusable.url || fn.url,
          message,
        },
      };
    }

    // Si no hay Docker local, deployToAzureContainerApp usa build remoto en ACR.
  }

  const validation = await validateFunctionCode(fn, { repair: !isPromotedCopy(fn) });
  fn = await applyValidationSource(fn, validation);
  await updateFunctionStatus(id, {
    validation_status: validation.status,
    validation_summary: validation.summary,
  });

  if (validation.blocking) {
    const deployment = await createDeployment(fn, {
      status: "failed",
      version: deployVersion,
      validation_status: validation.status,
      validation_summary: validation.summary,
      note,
      source_deployment_id,
    });
    await finishDeployment(deployment.id, {
      status: "failed",
      validation_status: validation.status,
      validation_summary: validation.summary,
      error: "validation failed",
    });
    await updateFunctionStatus(id, { status: "error" });
    await persistValidationLogs(fn, validation, deployment.id);
    return { ok: false, statusCode: 422, error: "validation failed", validation };
  }

  const deployment = await createDeployment(fn, {
    status: "deploying",
    version: deployVersion,
    validation_status: validation.status,
    validation_summary: validation.summary,
    note,
    source_deployment_id,
  });
  await persistValidationLogs(fn, validation, deployment.id);

  await updateFunctionStatus(id, { status: "deploying" });
  try {
    const secrets = await getSecretsForFunction(id);
    target ||= await getDeploymentTargetForFunction(fn, { includeSecrets: true });
    let containerId = null;
    let url = null;
    let provider = "local";
    let providerResult = null;

    if (target?.deployment_mode === "azure") {
      const envFunctions = await listFunctions({ project_id: fn.project_id, environment_id: fn.environment_id });
      const knownContainerAppNames = azureContainerAppNamesForEnvironment(target, envFunctions);
      const azureFunctions = envFunctions
        .map((item) => item.id === fn.id ? fn : item)
        .filter((item) => item.id === fn.id || item.status === "running");
      const environmentFunctions = [];
      for (const item of azureFunctions) {
        environmentFunctions.push({
          fn: item,
          secrets: await getSecretsForFunction(item.id),
          version: item.id === fn.id ? deployVersion : normalizeDeployVersion(item.active_deploy_version || "v1"),
        });
      }
      providerResult = await deployToAzureContainerApp(fn, secrets, target, {
        version: deployVersion,
        environmentFunctions,
        knownContainerAppNames,
      });
      provider = "azure";
      const currentRoute = providerResult.routes?.find((route) => route.function_id === id);
      containerId = `azure:${currentRoute?.container_app_name || providerResult.containerAppName}`;
      url = currentRoute?.url || providerResult.url;
      await appendLog({
        function_id: id,
        environment_id: fn.environment_id,
        deployment_id: deployment.id,
        message: `[deploy:probe] Verificando disponibilidad de ${url}`,
      });
      await waitForFunctionRoute(url, fn);
    } else if (target?.deployment_mode === "git") {
      providerResult = await triggerGitDeployment(fn, target, { version: deployVersion });
      provider = "git";
      containerId = providerResult.queued ? "git:queued" : "git:configured";
      url = providerResult.url || null;
    } else {
      const local = await buildAndDeploy(fn, secrets, { version: deployVersion });
      containerId = local.containerId;
      url = local.url;
    }

    await updateFunctionStatus(id, {
      status: provider === "git" ? "queued" : "running",
      container_id: containerId,
      url,
      active_deploy_version: deployVersion,
    });
    if (provider === "azure" && Array.isArray(providerResult?.routes)) {
      for (const route of providerResult.routes) {
        if (!route.function_id || route.function_id === id) continue;
        await updateFunctionStatus(route.function_id, {
          status: "running",
          container_id: `azure:${route.container_app_name || providerResult.containerAppName}`,
          url: route.url,
          active_deploy_version: route.version,
        });
      }
    }
    await finishDeployment(deployment.id, {
      status: provider === "git" && !providerResult?.queued ? "queued" : "success",
      url,
      validation_status: validation.status,
      validation_summary: validation.summary,
    });
    await appendLog({
      function_id: id,
      environment_id: fn.environment_id,
      deployment_id: deployment.id,
      message: `[deploy:${provider}] ${deployVersion} ${providerResult?.message || `deployed at ${url}`}`,
    });
    return { ok: true, deployment_id: deployment.id, url, validation, provider, providerResult };
  } catch (error) {
    app.log.error(error);
    const statusCode = Number(error?.statusCode || error?.status || 500);
    await updateFunctionStatus(id, { status: "error" });
    await finishDeployment(deployment.id, {
      status: "failed",
      validation_status: validation.status,
      validation_summary: validation.summary,
      error: String(error?.message || error),
    });
    await appendLog({
      function_id: id,
      environment_id: fn.environment_id,
      deployment_id: deployment.id,
      message: `[deploy:error] ${error?.message || error}`,
    });
    return {
      ok: false,
      statusCode,
      code: error?.code,
      error: String(error?.message || error),
      validation,
      memory: error?.memory,
    };
  }
}

// Deploy
app.post("/api/functions/:id/deploy", async (req, reply) => {
  const fn = await getFunction(req.params.id);
  if (!fn) return reply.code(404).send({ error: "not found" });
  if (isPromotedCopy(fn) && !canDeployPromotedCopy(fn)) {
    return reply.code(409).send({
      error: promotedDeployBlockedMessage(fn),
      code: "PROMOTED_FUNCTION_ALREADY_DEPLOYED",
    });
  }
  const result = await deployFunction(req.params.id, { version: req.body?.version });
  if (!result.ok) return reply.code(result.statusCode || 500).send(result);
  const refreshed = await getFunction(req.params.id);
  const remoteSync = await syncFunctionImpactToRemote(refreshed, { reason: "function-deploy" });
  return { ...result, remote_sync: remoteSync };
});

app.post("/api/functions/:id/deployments/:deploymentId/rollback", async (req, reply) => {
  const fn = await getFunction(req.params.id);
  if (!fn) return reply.code(404).send({ error: "not found" });

  const deployments = await listDeployments({ function_id: fn.id });
  const targetDeployment = deployments.find((deployment) => String(deployment.id) === String(req.params.deploymentId));
  if (!targetDeployment) return reply.code(404).send({ error: "deployment not found" });
  if (String(targetDeployment.environment_id || "") !== String(fn.environment_id || "")) {
    return reply.code(400).send({ error: "El deployment no pertenece al ambiente actual" });
  }
  if (targetDeployment.status !== "success") {
    return reply.code(400).send({ error: "Solo se puede volver a deployments exitosos" });
  }
  const snapshotFn = targetDeployment.snapshot?.function || null;
  if (!snapshotFn) {
    return reply.code(400).send({ error: "El deployment no tiene snapshot disponible para rollback" });
  }

  const restorePatch = {
    name: snapshotFn.name || fn.name,
    description: snapshotFn.description ?? null,
    code: snapshotFn.code || "",
    files: Array.isArray(snapshotFn.files) ? snapshotFn.files : [],
    entrypoint: snapshotFn.entrypoint || null,
    runtime: snapshotFn.runtime || "node20",
    memory_mb: Number(snapshotFn.memory_mb || 256) || 256,
    timeout_seconds: Number(snapshotFn.timeout_seconds || 30) || 30,
    auth_required: Boolean(snapshotFn.auth_required),
    auth_header_name: snapshotFn.auth_header_name || fn.auth_header_name || "x-api-key",
  };

  await updateFunction(fn.id, restorePatch, { tenant_id: getRequestTenantId() });
  await appendLog({
    function_id: fn.id,
    environment_id: fn.environment_id,
    deployment_id: targetDeployment.id,
    message: `[rollback] Volviendo a la version ${targetDeployment.version} desde el historial del ambiente ${fn.environment_slug || "actual"}.`,
  });

  const result = await deployFunction(fn.id, {
    version: targetDeployment.version,
    note: `Rollback a ${targetDeployment.version}`,
    source_deployment_id: targetDeployment.id,
  });
  if (!result.ok) return reply.code(result.statusCode || 500).send(result);

  const refreshed = await getFunction(req.params.id);
  const remoteSync = await syncFunctionImpactToRemote(refreshed, { reason: "rollback" });

  return {
    ...result,
    rollback_from_deployment_id: targetDeployment.id,
    rollback_from_version: targetDeployment.version,
    remote_sync: remoteSync,
  };
});

app.post("/api/functions/:id/stop", async (_req, reply) => {
  return reply.code(410).send({
    error: "La detencion individual fue retirada. Deten el ambiente para bajar el Container App completo y todas sus APIs.",
    code: "FUNCTION_STOP_REMOVED",
  });
});

// Deployment targets
app.get("/api/deployment-targets", async (req) =>
  listDeploymentTargets({
    project_id: req.query?.project_id,
    environment_id: req.query?.environment_id,
    environment_slug: req.query?.environment_slug,
  })
);

app.post("/api/deployment-targets", async (req, reply) => {
  try {
    return await upsertDeploymentTarget(req.body ?? {});
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

app.post("/api/deployment-targets/propagate", async (req, reply) => {
  try {
    return await propagateDeploymentTarget(req.body ?? {});
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

app.post("/api/platform/functions/:functionId/impact", async (req, reply) => {
  try {
    const snapshot = req.body?.function || req.body || {};
    if (!snapshot?.id) return reply.code(400).send({ error: "function snapshot required" });
    if (String(snapshot.id) !== String(req.params.functionId)) {
      return reply.code(400).send({ error: "function id mismatch" });
    }

    const target = await deploymentTargetForFunctionImpact(snapshot);
    if (!target) return reply.code(404).send({ error: "deployment target not found" });
    if (!platformSyncAuthorized(req, target)) {
      return reply.code(403).send({ error: "sync token invalido" });
    }

    const synced = await syncPromotedFunctionSnapshot(snapshot);
    await appendLog({
      function_id: synced.id,
      environment_id: synced.environment_id,
      message: `[sync:remote] Funcion impactada desde ${req.body?.reason || "promocion"} con codigo, configuracion y estado actualizados.`,
    });

    return {
      ok: true,
      function: compactFunction(synced),
      sync: synced.sync,
    };
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

app.get("/api/platform/container-apps", async (req) => {
  const targets = await listDeploymentTargets({
    environment_slug: req.query?.environment_slug,
  });
  return targets.filter(isPlatformDeploymentTarget).map(platformTargetView);
});

app.post("/api/platform/container-apps/:targetId/impact", async (req, reply) => {
  const target = await getDeploymentTarget(req.params.targetId, { includeSecrets: true });
  if (!target) return reply.code(404).send({ error: "target not found" });
  if (!isPlatformDeploymentTarget(target)) {
    return reply.code(400).send({ error: "El despliegue de la plataforma solo esta habilitado para test y prod" });
  }
  if (!platformSyncAuthorized(req, target)) {
    return reply.code(403).send({ error: "sync token invalido" });
  }

  const patch = platformImpactPatch(req.body || {});
  if (!Object.keys(patch).length) {
    return reply.code(400).send({ error: "payload vacio" });
  }

  const updated = await updateDeploymentTargetPlatform(target.id, patch);
  return {
    ok: true,
    target: platformTargetView(updated),
  };
});

app.post("/api/platform/container-apps/:targetId/cancel", async (req, reply) => {
  const target = await getDeploymentTarget(req.params.targetId);
  if (!target) return reply.code(404).send({ error: "target not found" });
  if (!isPlatformDeploymentTarget(target)) {
    return reply.code(400).send({ error: "El despliegue de la plataforma solo esta habilitado para test y prod" });
  }

  const percent = Math.max(0, Math.min(100, Number(target.platform_deploy_percent || 0)));
  const logs = Array.isArray(target.platform_deploy_logs) ? target.platform_deploy_logs : [];
  const message = "Deploy cancelado manualmente. Si Azure ya habia iniciado una operacion, puede terminar en segundo plano, pero la plataforma queda desbloqueada.";
  const updated = await updateDeploymentTargetPlatform(target.id, {
    platform_deploy_status: "canceled",
    platform_deploy_step: "canceled",
    platform_deploy_percent: percent,
    platform_deploy_logs: [
      ...logs,
      platformDeployLogEntry({ step: "canceled", percent, status: "canceled", message }),
    ].slice(-350),
    platform_deploy_error: null,
  });

  return {
    message,
    target: platformTargetView(updated),
  };
});

async function runPlatformDeployment(target, {
  platformVersion,
  rootDir = null,
  note = null,
  sourcePlatformDeploymentId = null,
} = {}) {
  const version = normalizePlatformVersion(platformVersion || target.platform_version || "1.0.0");
  const platformLogs = [platformDeployLogEntry({
    step: "queued",
    percent: 1,
    status: "running",
    message: `Deploy de plataforma ${version} iniciado`,
  })];
  const deployStartedAt = new Date().toISOString();
  const deploymentRecord = await createPlatformDeployment(target, {
    status: "running",
    version,
    snapshot: buildPlatformDeploymentSnapshot({ ...target, platform_version: version }, { version }),
    note: note || `Deploy de plataforma ${version} iniciado`,
    source_platform_deployment_id: sourcePlatformDeploymentId || null,
  });
  const updatePlatformProgress = async (patch = {}) => {
    const currentTarget = await getDeploymentTarget(target.id);
    if (currentTarget?.platform_deploy_status === "canceled") {
      throw platformDeployCanceledError();
    }
    const entry = platformDeployLogEntry(patch);
    if (entry.message || entry.step) platformLogs.push(entry);
    const trimmedLogs = platformLogs.slice(-350);
    platformLogs.length = 0;
    platformLogs.push(...trimmedLogs);
    await updateDeploymentTargetPlatform(target.id, {
      platform_deploy_step: patch.step || entry.step,
      platform_deploy_percent: entry.percent,
      platform_deploy_logs: platformLogs,
      ...(patch.status ? { platform_deploy_status: patch.status === "success" ? "running" : patch.status } : {}),
      ...(patch.error ? { platform_deploy_error: patch.error } : {}),
    });
  };

  await updateDeploymentTargetPlatform(target.id, {
    platform_version: version,
    platform_deploy_started_at: deployStartedAt,
    platform_deploy_step: "queued",
    platform_deploy_percent: 1,
    platform_deploy_logs: platformLogs,
    platform_deploy_status: "running",
    platform_deploy_error: null,
  });

  try {
    const result = await deployPlatformContainerApps({ ...target, platform_version: version }, {
      rootDir,
      version,
      onProgress: updatePlatformProgress,
    });
    const latest = await getDeploymentTarget(target.id);
    if (latest?.platform_deploy_status === "canceled") {
      await finishPlatformDeployment(deploymentRecord.id, {
        status: "canceled",
        snapshot: buildPlatformDeploymentSnapshot(latest || target, { version, deployedVersion: result.version || version }),
        error: null,
        finished_at: new Date().toISOString(),
      });
      throw platformDeployCanceledError();
    }
    const completeEntry = platformDeployLogEntry({
      step: "complete",
      percent: 100,
      status: "success",
      message: result.message || "Deploy completo",
    });
    const syncEntry = platformDeployLogEntry({
      step: "sync-remote",
      percent: 100,
      status: "success",
      message: "Estado de impacto sincronizado con el API destino",
    });
    const successPatch = {
      platform_api_container_app_name: result.api.containerAppName,
      platform_api_container_app_url: result.api.url,
      platform_api_image: result.api.image,
      platform_web_container_app_name: result.web.containerAppName,
      platform_web_container_app_url: result.web.url,
      platform_web_image: result.web.image,
      platform_version: version,
      platform_deployed_version: result.version || version,
      platform_deployed_at: new Date().toISOString(),
      platform_deploy_started_at: deployStartedAt,
      platform_deploy_step: "complete",
      platform_deploy_percent: 100,
      platform_deploy_logs: [...platformLogs, completeEntry, syncEntry].slice(-350),
      platform_deploy_status: "success",
      platform_deploy_error: null,
    };
    let updated = await updateDeploymentTargetPlatform(target.id, successPatch);
    const remoteSync = await syncPlatformImpactToRemote(result.api.url, target, successPatch);
    if (!remoteSync.ok) {
      const warningEntry = platformDeployLogEntry({
        step: "sync-remote",
        percent: 100,
        status: "warning",
        message: `No se pudo sincronizar el estado en el API destino: ${remoteSync.error}`,
      });
      updated = await updateDeploymentTargetPlatform(target.id, {
        platform_deploy_logs: [...successPatch.platform_deploy_logs, warningEntry].slice(-350),
      });
    }
    const finalTarget = await getDeploymentTarget(target.id);
    const finalSnapshot = buildPlatformDeploymentSnapshot(finalTarget || updated || target, {
      version,
      deployedVersion: result.version || version,
    });
    const previousDeployment = await getLatestSuccessfulPlatformDeployment(target.id);
    const changeReport = buildPlatformDeploymentChangeDetails(previousDeployment?.snapshot || null, finalSnapshot, note || `Deploy de plataforma ${version}`);
    await finishPlatformDeployment(deploymentRecord.id, {
      status: "success",
      snapshot: finalSnapshot,
      change_summary: changeReport.summary,
      change_details: changeReport.details,
      error: null,
      finished_at: new Date().toISOString(),
    });
    return { ...result, remote_sync: remoteSync, target: platformTargetView(updated), deployment_id: deploymentRecord.id };
  } catch (error) {
    const latest = await getDeploymentTarget(target.id);
    if (latest?.platform_deploy_status === "canceled" || error?.code === "PLATFORM_DEPLOY_CANCELED") {
      const canceledTarget = latest || await getDeploymentTarget(target.id);
      await finishPlatformDeployment(deploymentRecord.id, {
        status: "canceled",
        snapshot: buildPlatformDeploymentSnapshot(canceledTarget || target, { version }),
        error: null,
        finished_at: new Date().toISOString(),
      });
      return {
        canceled: true,
        target: canceledTarget ? platformTargetView(canceledTarget) : null,
        deployment_id: deploymentRecord.id,
      };
    }
    const blocked = isAzureContainerBusyError(error);
    const failedLogs = [
      ...platformLogs,
      platformDeployLogEntry({
        step: blocked ? "blocked" : "failed",
        percent: platformLogs.at(-1)?.percent || 0,
        status: blocked ? "blocked" : "failed",
        message: error?.message || String(error),
      }),
    ].slice(-350);
    const updated = await updateDeploymentTargetPlatform(target.id, {
      platform_deploy_status: blocked ? "blocked" : "failed",
      platform_deploy_step: blocked ? "blocked" : "failed",
      platform_deploy_percent: platformLogs.at(-1)?.percent || 0,
      platform_deploy_logs: failedLogs,
      platform_deploy_error: error?.message || String(error),
    });
    await finishPlatformDeployment(deploymentRecord.id, {
      status: blocked ? "blocked" : "failed",
      snapshot: buildPlatformDeploymentSnapshot(updated || target, { version }),
      error: error?.message || String(error),
      finished_at: new Date().toISOString(),
    });
    return {
      error,
      blocked,
      target: updated ? platformTargetView(updated) : null,
      deployment_id: deploymentRecord.id,
    };
  }
}

app.post("/api/platform/container-apps/:targetId/deploy", async (req, reply) => {
  const target = await getDeploymentTarget(req.params.targetId, { includeSecrets: true });
  if (!target) return reply.code(404).send({ error: "target not found" });
  if (!isPlatformDeploymentTarget(target)) {
    return reply.code(400).send({ error: "El despliegue de la plataforma solo esta habilitado para test y prod" });
  }
  if (target.deployment_mode !== "azure") {
    return reply.code(400).send({ error: "El ambiente debe estar en modo Azure automatico" });
  }
  const lock = platformDeployLock(target);
  if (lock) {
    return reply.code(409).send({
      error: lock.message,
      code: lock.status === "blocked" ? "AZURE_CONTAINER_APP_BUSY" : "PLATFORM_DEPLOY_RUNNING",
      retry_after_seconds: Math.max(1, Math.ceil((lock.expiresAt - Date.now()) / 1000)),
      target: platformTargetView(target),
    });
  }

  let platformVersion;
  try {
    platformVersion = normalizePlatformVersion(req.body?.platform_version || target.platform_version || "1.0.0");
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
  const result = await runPlatformDeployment(target, {
    platformVersion,
    rootDir: req.body?.root_dir || null,
  });
  if (result?.canceled) {
    return reply.code(409).send({
      error: "Deploy cancelado manualmente",
      code: "PLATFORM_DEPLOY_CANCELED",
      target: result.target,
    });
  }
  if (result?.error) {
    return reply.code(result.blocked ? 409 : result.error?.statusCode || 400).send({
      error: result.error?.message || String(result.error),
      code: result.blocked ? "AZURE_CONTAINER_APP_BUSY" : result.error?.code,
      retry_after_seconds: result.blocked ? Number(result.error?.retryAfterSeconds || 300) : undefined,
      target: result.target,
    });
  }
  return result;
});

app.get("/api/platform/container-apps/:targetId/deployments", async (req, reply) => {
  const target = await getDeploymentTarget(req.params.targetId);
  if (!target) return reply.code(404).send({ error: "target not found" });
  if (!isPlatformDeploymentTarget(target)) {
    return reply.code(400).send({ error: "El despliegue de la plataforma solo esta habilitado para test y prod" });
  }
  return listPlatformDeployments({
    target_id: target.id,
  });
});

app.post("/api/platform/container-apps/:targetId/deployments/:deploymentId/rollback", async (req, reply) => {
  const target = await getDeploymentTarget(req.params.targetId, { includeSecrets: true });
  if (!target) return reply.code(404).send({ error: "target not found" });
  if (!isPlatformDeploymentTarget(target)) {
    return reply.code(400).send({ error: "El despliegue de la plataforma solo esta habilitado para test y prod" });
  }
  if (target.deployment_mode !== "azure") {
    return reply.code(400).send({ error: "El ambiente debe estar en modo Azure automatico" });
  }
  const lock = platformDeployLock(target);
  if (lock) {
    return reply.code(409).send({
      error: lock.message,
      code: lock.status === "blocked" ? "AZURE_CONTAINER_APP_BUSY" : "PLATFORM_DEPLOY_RUNNING",
      retry_after_seconds: Math.max(1, Math.ceil((lock.expiresAt - Date.now()) / 1000)),
      target: platformTargetView(target),
    });
  }

  const deployments = await listPlatformDeployments({ target_id: target.id });
  const selected = deployments.find((deployment) => deployment.id === req.params.deploymentId);
  if (!selected || selected.status !== "success") {
    return reply.code(404).send({ error: "version not found" });
  }

  const rollbackVersion = normalizePlatformVersion(
    selected.version || selected.snapshot?.target?.platform_version || target.platform_version || "1.0.0"
  );
  const result = await runPlatformDeployment(target, {
    platformVersion: rollbackVersion,
    rootDir: req.body?.root_dir || null,
    note: `Rollback a ${rollbackVersion}`,
    sourcePlatformDeploymentId: selected.id,
  });
  if (result?.canceled) {
    return reply.code(409).send({
      error: "Deploy cancelado manualmente",
      code: "PLATFORM_DEPLOY_CANCELED",
      target: result.target,
    });
  }
  if (result?.error) {
    return reply.code(result.blocked ? 409 : result.error?.statusCode || 400).send({
      error: result.error?.message || String(result.error),
      code: result.blocked ? "AZURE_CONTAINER_APP_BUSY" : result.error?.code,
      retry_after_seconds: result.blocked ? Number(result.error?.retryAfterSeconds || 300) : undefined,
      target: result.target,
    });
  }
  return {
    message: `Rollback ejecutado a ${rollbackVersion}`,
    ...result,
  };
});

app.post("/api/deployment-targets/:id/create-container", async (req, reply) => {
  const progressFor = async (targetId, patch) => {
    await updateDeploymentTargetProvisioning(targetId, {
      azure_provisioning_status: patch.status,
      azure_provisioning_step: patch.step,
      azure_provisioning_percent: patch.percent,
      azure_provisioning_error: patch.error,
      azure_provisioning_steps: patch.steps,
    });
  };

  try {
    const target = await getDeploymentTarget(req.params.id, { includeSecrets: true });
    if (!target) return reply.code(404).send({ error: "target not found" });
    if (target.deployment_mode !== "azure") {
      return reply.code(400).send({ error: "El target debe estar en modo Azure automatico" });
    }

    await progressFor(target.id, {
      status: "running",
      step: "validate",
      percent: 0,
      error: null,
      steps: [],
    });

    const result = await provisionAzureContainerApp(target, {
      onProgress: (patch) => progressFor(target.id, patch),
    });
    const updatedTarget = await updateDeploymentTargetProvisioning(target.id, {
      azure_container_app_name: result.containerAppName,
      azure_container_app_url: result.url,
      azure_container_config_hash: result.configHash,
      azure_container_created_at: new Date().toISOString(),
      azure_managed_environment_created_at: target.azure_managed_environment_created_at || new Date().toISOString(),
      azure_provisioning_status: "success",
      azure_provisioning_step: "complete",
      azure_provisioning_percent: 100,
      azure_provisioning_error: null,
      azure_provisioning_steps: result.steps,
    });

    return { ...result, target: updatedTarget };
  } catch (error) {
    const target = await getDeploymentTarget(req.params.id, { includeSecrets: true }).catch(() => null);
    if (target) {
      await updateDeploymentTargetProvisioning(target.id, {
        azure_provisioning_status: "failed",
        azure_provisioning_error: error?.message || String(error),
      });
    }
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

app.delete("/api/deployment-targets/:id/container", async (req, reply) => {
  try {
    const target = await getDeploymentTarget(req.params.id, { includeSecrets: true });
    if (!target) return reply.code(404).send({ error: "target not found" });
    if (!target.azure_container_app_name && !target.container_app_name_prefix) {
      return reply.code(400).send({ error: "No hay Container App configurado para eliminar" });
    }

    const functions = await listFunctions({ project_id: target.project_id, environment_id: target.environment_id });
    const result = await deleteAzureContainerApp(target, {
      appNames: azureContainerAppNamesForEnvironment(target, functions, { includeProbe: true }),
      onProgress: (patch) => updateDeploymentTargetProvisioning(target.id, {
        azure_provisioning_status: patch.status,
        azure_provisioning_step: patch.step,
        azure_provisioning_percent: patch.percent,
        azure_provisioning_error: patch.error,
        azure_provisioning_steps: patch.steps,
      }),
    });
    const updatedTarget = await updateDeploymentTargetProvisioning(target.id, {
      azure_container_app_name: null,
      azure_container_app_url: null,
      azure_container_config_hash: null,
      azure_container_created_at: null,
      azure_provisioning_status: "deleted",
      azure_provisioning_step: "delete-container-app",
      azure_provisioning_percent: 100,
      azure_provisioning_error: null,
      azure_provisioning_steps: result.steps,
    });

    return { ...result, target: updatedTarget };
  } catch (error) {
    return reply.code(400).send({ error: error?.message || String(error) });
  }
});

// Deployments
app.get("/api/deployments", async (req) =>
  listDeployments({
    project_id: req.query?.project_id,
    environment_id: req.query?.environment_id,
    environment_slug: req.query?.environment_slug,
    function_id: req.query?.function_id,
  })
);

// Templates
app.get("/api/templates", async () => listTemplates());

// Logs - history
app.get("/api/functions/:id/logs/history", async (req) => {
  const fn = await getFunction(req.params.id);
  const version = normalizeDeployVersion(req.query?.version || fn?.active_deploy_version || "v1");
  const [stored, container] = await Promise.all([
    listLogHistory(req.params.id),
    readContainerLogHistory(req.params.id, { version }),
  ]);
  return [...stored, ...container].slice(-800);
});

// Logs - SSE
app.get("/api/functions/:id/logs", async (req, reply) => {
  const { id } = req.params;
  const fn = await getFunction(id);
  const version = normalizeDeployVersion(req.query?.version || fn?.active_deploy_version || "v1");
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders?.();

  try {
    const stop = await streamLogs(id, (line) => {
      reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
    }, { version });
    req.raw.on("close", () => stop?.());
  } catch (error) {
    reply.raw.write(`data: ${JSON.stringify(`[logs] ${error?.message || error}`)}\n\n`);
    reply.raw.end();
  }
});

app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

await initDb();
app.log.info(`Database schema ready (${getStoreMode()})`);
await app.listen({ port: Number(process.env.PORT || 4000), host: "0.0.0.0" });

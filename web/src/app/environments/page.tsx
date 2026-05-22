"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { environmentQuery, useCurrentEnvironment } from "@/lib/environment";
import { Topbar } from "@/components/Topbar";
import { Pagination } from "@/components/Pagination";
import { StatusBadge } from "@/components/StatusBadge";
import { ArrowRight, Boxes, Clock3, ExternalLink, Loader2, Play, Rocket, Search, Server, Square, Terminal, X } from "lucide-react";

type Project = { id: string; name: string; slug: string };
type Environment = { id: string; project_id: string; name: string; slug: string; description?: string; function_count?: number };
type Fn = {
  id: string;
  name: string;
  slug: string;
  status: string;
  runtime?: string;
  url?: string;
  container_id?: string | null;
  environment_id?: string;
  environment_slug?: string;
  memory_mb?: number;
  active_deploy_version?: string;
  validation_status?: string;
  source_function_id?: string | null;
  updated_at: string;
};
type DeploymentTarget = {
  id?: string;
  project_id: string;
  environment_id: string;
  deployment_mode?: string;
  auto_deploy?: boolean;
  [key: string]: any;
};

type EnvironmentRuntime = {
  project_id?: string | null;
  project_name: string;
  environment_id: string;
  environment_name: string;
  environment_slug: string;
  functions: number;
  running: number;
  failed_functions: number;
  deployments: number;
  failed_deployments: number;
  availability: number | null;
  target_mode: string;
  target_auto_deploy: boolean;
  target_configured: boolean;
  memory_assigned_mb?: number;
  memory_budget_mb?: number;
  memory_active_mb?: number;
  memory_configured_mb?: number;
  memory_available_mb?: number | null;
  memory_usage_pct?: number | null;
  container_apps?: number;
  container_name?: string;
  container_url?: string;
  runtime_source?: string;
  target_state?: string;
  status: string;
};

type DashboardData = {
  environmentStatus: EnvironmentRuntime[];
};

type PromotionLogStatus = "running" | "success" | "failed" | "warning";
type PromotionLog = {
  id: string;
  ts: string;
  percent: number;
  status: PromotionLogStatus;
  step: string;
  message: string;
};
type PromotionJob = {
  id: string;
  title: string;
  source: string;
  target: string;
  status: PromotionLogStatus;
  percent: number;
  startedAt: string;
  finishedAt?: string;
  logs: PromotionLog[];
};

const AZURE_FUNCTIONS_PER_CONTAINER_APP = 7;

function azureContainerMemoryMb(memoryMb = 256) {
  const requested = Math.max(128, Number(memoryMb || 256));
  return Math.round(Math.min(4, Math.max(0.5, Math.ceil(requested / 512) * 0.5)) * 1024);
}

function runtimeLabel(runtime?: string) {
  if (runtime === "deno") return "Deno";
  if (runtime === "python311") return "Python 3.11";
  if (runtime === "java-spring") return "Java Spring";
  if (runtime === "dotnet8") return ".NET 8";
  if (runtime === "custom") return "Dockerfile";
  return "Node 20";
}

function formatShortDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function elapsedLabel(startedAt?: string, finishedAt?: string) {
  if (!startedAt) return "0s";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function jobStatusLabel(status: PromotionLogStatus) {
  if (status === "success") return "Completado";
  if (status === "failed") return "Error";
  if (status === "warning") return "Advertencia";
  return "En progreso";
}

function jobStatusClass(status: PromotionLogStatus) {
  if (status === "success") return "text-emerald-300";
  if (status === "failed") return "text-rose-300";
  if (status === "warning") return "text-amber-300";
  return "text-cyan-300";
}

function remoteSyncItems(sync: any) {
  if (!sync) return [];
  return Array.isArray(sync) ? sync : [sync];
}

function remoteSyncFailures(sync: any) {
  return remoteSyncItems(sync).filter((item: any) => item && item.ok === false && !item.skipped);
}

function remoteSyncSuccess(sync: any) {
  return remoteSyncItems(sync).some((item: any) => item?.ok === true);
}

function remoteSyncError(sync: any) {
  const failure = remoteSyncFailures(sync)[0];
  return failure?.error || "El API remoto del ambiente destino no recibio el snapshot actualizado.";
}

function EnvironmentsInner() {
  const sp = useSearchParams();
  const currentEnv = useCurrentEnvironment();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(sp.get("project_id") || "");
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [functions, setFunctions] = useState<Fn[]>([]);
  const [targets, setTargets] = useState<DeploymentTarget[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [busyId, setBusyId] = useState("");
  const [deployAfterPromote, setDeployAfterPromote] = useState(false);
  const [bulkSourceEnvId, setBulkSourceEnvId] = useState("");
  const [bulkTargetEnvId, setBulkTargetEnvId] = useState("");
  const [functionSearch, setFunctionSearch] = useState("");
  const [functionStatus, setFunctionStatus] = useState("all");
  const [functionPage, setFunctionPage] = useState(1);
  const [functionPageSize, setFunctionPageSize] = useState(10);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [promotionJob, setPromotionJob] = useState<PromotionJob | null>(null);
  const [showPromotionLog, setShowPromotionLog] = useState(false);

  useEffect(() => {
    api<Project[]>("/api/projects")
      .then((items) => {
        setProjects(items || []);
        if (!projectId && items?.[0]) setProjectId(items[0].id);
      })
      .catch(() => {});
  }, []);

  async function loadProjectData(id: string) {
    if (!id) {
      setEnvironments([]);
      setFunctions([]);
      setDashboard(null);
      return;
    }
    setDashboard(null);
    const [envs, fns, deploymentTargets, overview] = await Promise.all([
      api<Environment[]>(`/api/environments?project_id=${id}`),
      api<Fn[]>(`/api/functions?project_id=${id}&environment_slug=${currentEnv.slug}`),
      api<DeploymentTarget[]>(`/api/deployment-targets?project_id=${id}`).catch(() => []),
      api<DashboardData>(`/api/dashboard${environmentQuery(currentEnv.slug, { project_id: id })}`).catch(() => null),
    ]);
    setEnvironments(envs || []);
    setFunctions(fns || []);
    setTargets(deploymentTargets || []);
    setDashboard(overview || null);
  }

  useEffect(() => { loadProjectData(projectId).catch(() => {}); }, [projectId, currentEnv.slug]);

  useEffect(() => {
    if (!projectId) return;
    const refresh = () => loadProjectData(projectId).catch(() => {});
    const interval = window.setInterval(refresh, 15000);
    return () => window.clearInterval(interval);
  }, [projectId, currentEnv.slug]);

  useEffect(() => {
    setFunctionPage(1);
  }, [projectId, currentEnv.slug, functionSearch, functionStatus, functionPageSize]);

  const byEnvironment = useMemo(() => {
    const map: Record<string, Fn[]> = {};
    for (const env of environments) map[env.id] = [];
    for (const fn of functions) {
      if (fn.environment_id) map[fn.environment_id] = [...(map[fn.environment_id] || []), fn];
    }
    return map;
  }, [environments, functions]);

  const targetByEnvironment = useMemo(() => {
    const map: Record<string, DeploymentTarget> = {};
    for (const target of targets) map[target.environment_id] = target;
    return map;
  }, [targets]);
  const visibleEnvironments = environments.filter((env) => env.slug === currentEnv.slug);
  const currentVisibleEnvironment = visibleEnvironments[0] || null;
  const currentEnvironmentItems = currentVisibleEnvironment ? (byEnvironment[currentVisibleEnvironment.id] || []) : [];
  const filteredEnvironmentItems = useMemo(() => {
    const term = functionSearch.trim().toLowerCase();
    return [...currentEnvironmentItems]
      .sort((a, b) =>
        String(b.updated_at || "").localeCompare(String(a.updated_at || "")) ||
        a.name.localeCompare(b.name)
      )
      .filter((fn) =>
        (functionStatus === "all" || fn.status === functionStatus || fn.validation_status === functionStatus) &&
        (!term || fn.name.toLowerCase().includes(term) || fn.slug.toLowerCase().includes(term))
      );
  }, [currentEnvironmentItems, functionSearch, functionStatus]);
  const functionTotalPages = Math.max(1, Math.ceil(filteredEnvironmentItems.length / functionPageSize));
  const currentFunctionPage = Math.min(functionPage, functionTotalPages);
  const visibleFunctions = filteredEnvironmentItems.slice((currentFunctionPage - 1) * functionPageSize, currentFunctionPage * functionPageSize);
  const bulkSourceEnv = environments.find((env) => env.slug === currentEnv.slug) || null;
  const bulkTargetOptions = environments.filter((env) => env.slug === currentEnv.nextSlug);
  const bulkTargetEnv = bulkTargetOptions.find((env) => env.id === bulkTargetEnvId) || null;

  useEffect(() => {
    if (!environments.length) {
      setBulkSourceEnvId("");
      setBulkTargetEnvId("");
      return;
    }

    const source = environments.find((env) => env.slug === currentEnv.slug)?.id || "";
    if (source !== bulkSourceEnvId) setBulkSourceEnvId(source);

    const options = environments.filter((env) => env.slug === currentEnv.nextSlug);
    const target = options[0]?.id || "";
    if (target !== bulkTargetEnvId) setBulkTargetEnvId(target);
  }, [environments, bulkSourceEnvId, bulkTargetEnvId, currentEnv.slug, currentEnv.nextSlug]);

  function memorySummary(env: Environment, items: Fn[], overview?: EnvironmentRuntime | null) {
    if (overview && overview.environment_id === env.id) {
      const deployed = Number(overview.memory_active_mb ?? overview.memory_assigned_mb ?? 0) || 0;
      const containerApps = Number(overview.container_apps ?? overview.running ?? 0) || 0;
      const runningCount = Number(overview.running ?? items.filter((fn) => fn.status === "running").length) || 0;
      const targetState = String(overview.target_state || overview.status || (runningCount > 0 ? "running" : "idle")).toLowerCase();
      const containerName = overview.container_name || "";
      const containerUrl = overview.container_url || "";
      let status = "idle";
      if (overview.runtime_source === "docker-desktop") {
        status = Number(overview.running || 0) > 0 ? "running" : containerApps > 0 ? "stopped" : "idle";
      } else if (["blocked"].includes(targetState)) status = "warning";
      else if (["deploying", "queued", "provisioning"].includes(targetState)) status = "deploying";
      else if (["failed", "error"].includes(targetState)) status = "error";
      else if (runningCount > 0 || ["running", "active"].includes(targetState)) status = "running";
      else if (containerApps > 0) status = "stopped";
      return {
        deployed,
        gatewayCount: containerApps,
        runningCount,
        status,
        configured: Boolean(overview.target_configured),
        hasContainer: containerApps > 0 || Boolean(containerName || containerUrl),
        targetState: targetState || (runningCount > 0 ? "running" : "idle"),
        containerName:
          containerName ||
          (overview.runtime_source === "docker-desktop"
            ? "Docker Desktop local"
            : env.slug === "dev"
              ? "Docker Desktop local"
              : ""),
        containerUrl:
          containerUrl ||
          (overview.runtime_source === "docker-desktop"
            ? (items.find((fn) => fn.url)?.url || "")
            : ""),
        deploymentMode: overview.target_mode || "manual",
      };
    }
    const target = targetByEnvironment[env.id];
    const runningItems = items.filter((fn) => fn.status === "running");
    const runningCount = runningItems.length;
    const configured = Boolean(target?.deployment_mode && target.deployment_mode !== "manual");
    const gatewayCount = target?.deployment_mode === "azure" && (runningCount > 0 || target?.azure_container_app_name || target?.platform_api_container_app_name)
      ? 1 + Math.ceil(runningCount / AZURE_FUNCTIONS_PER_CONTAINER_APP)
      : 0;
    const gateway = gatewayCount * azureContainerMemoryMb(128);
    const deployed = gateway + runningItems.reduce((sum, fn) => sum + azureContainerMemoryMb(fn.memory_mb || 256), 0);
    const targetState = String(
      target?.azure_provisioning_status ||
      target?.platform_deploy_status ||
      target?.status ||
      ""
    ).toLowerCase();
    const hasContainer = Boolean(
      target?.azure_container_app_name ||
      target?.platform_api_container_app_name ||
      target?.platform_web_container_app_name ||
      target?.azure_container_app_url ||
      target?.platform_api_container_app_url ||
      target?.platform_web_container_app_url
    );
    let status = "idle";
    if (["blocked"].includes(targetState)) status = "warning";
    else if (["deploying", "queued", "provisioning"].includes(targetState)) status = "deploying";
    else if (["failed", "error"].includes(targetState)) status = "error";
    else if (runningCount > 0 || ["running", "active"].includes(targetState)) status = "running";
    else if (configured || hasContainer) status = "stopped";
    return {
      deployed,
      gatewayCount,
      runningCount,
      status,
      configured,
      hasContainer,
      targetState: targetState || (runningCount > 0 ? "running" : "idle"),
      containerName:
        target?.azure_container_app_name ||
        target?.platform_api_container_app_name ||
        target?.platform_web_container_app_name ||
        "",
      containerUrl:
        target?.azure_container_app_url ||
        target?.platform_api_container_app_url ||
        target?.platform_web_container_app_url ||
        "",
      deploymentMode: target?.deployment_mode || "manual",
    };
  }

  function startPromotionJob(title: string, source: string, target: string) {
    const job: PromotionJob = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title,
      source,
      target,
      status: "running",
      percent: 3,
      startedAt: new Date().toISOString(),
      logs: [],
    };
    setPromotionJob(job);
    setShowPromotionLog(true);
    addPromotionLog(job.id, "Preparacion", "running", 3, "Preparando promocion y validando ambiente destino.");
    return job.id;
  }

  function addPromotionLog(jobId: string, step: string, status: PromotionLogStatus, percent: number, message: string) {
    setPromotionJob((current) => {
      if (!current || current.id !== jobId) return current;
      const nextPercent = Math.max(current.percent, percent);
      return {
        ...current,
        status: status === "failed" ? "failed" : current.status === "failed" ? "failed" : status === "success" && percent >= 100 ? "success" : "running",
        percent: nextPercent,
        logs: [
          ...current.logs,
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            ts: new Date().toISOString(),
            percent: nextPercent,
            status,
            step,
            message,
          },
        ],
      };
    });
  }

  function finishPromotionJob(jobId: string, status: PromotionLogStatus, message: string) {
    setPromotionJob((current) => {
      if (!current || current.id !== jobId) return current;
      const percent = status === "success" ? 100 : current.percent;
      return {
        ...current,
        status,
        percent,
        finishedAt: new Date().toISOString(),
        logs: [
          ...current.logs,
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            ts: new Date().toISOString(),
            percent,
            status,
            step: status === "success" ? "Completo" : "Detenido",
            message,
          },
        ],
      };
    });
  }

  async function promote(fn: Fn, targetEnvironmentSlug: string) {
    if (!targetEnvironmentSlug) return;
    const promoteId = `${fn.id}-${targetEnvironmentSlug}`;
    const jobId = startPromotionJob(`${fn.name} -> ${targetEnvironmentSlug.toUpperCase()}`, fn.environment_slug || currentEnv.slug, targetEnvironmentSlug);
    setBusyId(promoteId);
    setErr(null);
    setInfo(null);
    try {
      addPromotionLog(jobId, "Promocion", "running", 18, `Copiando archivos, configuracion y secrets faltantes de ${fn.environment_slug || currentEnv.slug} a ${targetEnvironmentSlug}.`);
      addPromotionLog(jobId, "Destino", "running", 36, deployAfterPromote ? "El ambiente destino queda en estado deploying mientras se publica." : "El ambiente destino queda sincronizado sin publicar automaticamente.");
      if (deployAfterPromote) {
        addPromotionLog(jobId, "Deploy", "running", 58, "Validando y publicando la funcion promovida en Azure o runtime configurado.");
      }
      const result: any = await api(`/api/functions/${fn.id}/promote`, {
        method: "POST",
        body: JSON.stringify({
          target_environment_slug: targetEnvironmentSlug,
          deploy_after_promote: deployAfterPromote,
        }),
      });
      const deployment = result?.deployment_result;
      if (deployAfterPromote) {
        if (deployment?.ok === false) {
          addPromotionLog(jobId, "Deploy", "failed", 88, deployment?.error || deployment?.message || "El deploy del destino fallo.");
          finishPromotionJob(jobId, "failed", deployment?.error || "La promocion se copio, pero el deploy automatico fallo.");
          setErr(deployment?.error || "La promocion se copio, pero el deploy automatico fallo.");
          await loadProjectData(projectId);
          return;
        }
        addPromotionLog(jobId, "Deploy", "success", 88, deployment?.message || "Deploy del destino finalizado.");
      } else {
        addPromotionLog(jobId, "Sin deploy", "success", 82, "Promocion guardada. El destino queda pendiente hasta que se promueva o despliegue desde el flujo correcto.");
      }
      if (remoteSyncFailures(result?.remote_sync).length) {
        const message = remoteSyncError(result?.remote_sync);
        addPromotionLog(jobId, "API remoto", "failed", 96, message);
        await loadProjectData(projectId);
        finishPromotionJob(jobId, "failed", `La promocion local se guardo, pero el API remoto de ${targetEnvironmentSlug.toUpperCase()} no fue impactado.`);
        setErr(`Promocion local OK, pero falta impactar el API remoto de ${targetEnvironmentSlug.toUpperCase()}: ${message}`);
        return;
      }
      if (remoteSyncSuccess(result?.remote_sync)) {
        addPromotionLog(jobId, "API remoto", "success", 96, "API remoto del ambiente destino actualizado con codigo, configuracion y estado.");
      }
      await loadProjectData(projectId);
      finishPromotionJob(jobId, "success", `${fn.name} quedo homologada en ${targetEnvironmentSlug.toUpperCase()}.`);
      setInfo(`Promocion completada hacia ${targetEnvironmentSlug.toUpperCase()}`);
    } catch (error: any) {
      finishPromotionJob(jobId, "failed", error.message || "No se pudo completar la promocion.");
      setErr(error.message);
    } finally {
      setBusyId("");
    }
  }

  async function promoteWholeProject(source: string, target: string) {
    if (!projectId) return;
    const promoteId = `${source}-${target}`;
    const jobId = startPromotionJob(`Proyecto -> ${target.toUpperCase()}`, source, target);
    setBusyId(promoteId);
    setErr(null);
    setInfo(null);
    try {
      const sourceCount = functions.length;
      addPromotionLog(jobId, "Inventario", "running", 15, `Preparando ${sourceCount} funciones del ambiente ${source.toUpperCase()}.`);
      addPromotionLog(jobId, "Sincronizacion", "running", 35, "Copiando archivos, runtimes, secrets faltantes y configuracion base al ambiente destino. Las API keys se preservan o se generan por ambiente.");
      if (deployAfterPromote) {
        addPromotionLog(jobId, "Deploy", "running", 58, "Marcando destino como deploying y publicando las funciones promovidas.");
      }
      const result: any = await api(`/api/projects/${projectId}/promote`, {
        method: "POST",
        body: JSON.stringify({
          source_environment_slug: source,
          target_environment_slug: target,
          deploy_after_promote: deployAfterPromote,
        }),
      });
      const deployedCount = Array.isArray(result?.deployed) ? result.deployed.length : 0;
      const failedDeploys = Array.isArray(result?.deployed) ? result.deployed.filter((item: any) => item?.ok === false) : [];
      addPromotionLog(
        jobId,
        deployAfterPromote ? "Deploy" : "Promocion",
        failedDeploys.length ? "failed" : "success",
        88,
        failedDeploys.length
          ? `${failedDeploys.length} despliegues fallaron en ${target.toUpperCase()}.`
          : deployAfterPromote
          ? `${deployedCount} despliegues procesados para ${target.toUpperCase()}.`
          : `${result?.promoted?.length || 0} funciones sincronizadas sin deploy automatico.`
      );
      const syncFailures = remoteSyncFailures(result?.remote_sync);
      if (syncFailures.length) {
        const message = remoteSyncError(result?.remote_sync);
        addPromotionLog(jobId, "API remoto", "failed", 96, `${syncFailures.length} sincronizaciones remotas fallaron. ${message}`);
        await loadProjectData(projectId);
        finishPromotionJob(jobId, "failed", `La promocion local se guardo, pero el API remoto de ${target.toUpperCase()} no fue impactado completamente.`);
        setErr(`Promocion local OK, pero falta impactar el API remoto de ${target.toUpperCase()}: ${message}`);
        return;
      }
      if (remoteSyncSuccess(result?.remote_sync)) {
        addPromotionLog(jobId, "API remoto", "success", 96, "APIs remotos del ambiente destino actualizados con codigo, configuracion y estado.");
      }
      await loadProjectData(projectId);
      if (failedDeploys.length) {
        finishPromotionJob(jobId, "failed", failedDeploys[0]?.error || "La promocion se copio, pero uno o mas deploys fallaron.");
        setErr(failedDeploys[0]?.error || "La promocion se copio, pero uno o mas deploys fallaron.");
        return;
      }
      finishPromotionJob(jobId, "success", `Proyecto homologado de ${source.toUpperCase()} a ${target.toUpperCase()}.`);
      setInfo(`Proyecto promovido hacia ${target.toUpperCase()}`);
    } catch (error: any) {
      finishPromotionJob(jobId, "failed", error.message || "No se pudo completar la promocion del proyecto.");
      setErr(error.message);
    } finally {
      setBusyId("");
    }
  }

  async function stopEnvironment(env: Environment) {
    if (!projectId) return;
    if (!confirm(`Detener el Container App del ambiente ${env.name}? Todas las APIs de este ambiente quedaran fuera de servicio.`)) return;
    setBusyId(`stop-env-${env.id}`);
    setErr(null);
    setInfo(null);
    try {
      const result = await api<{ message?: string }>(`/api/environments/${env.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ project_id: projectId }),
      });
      setInfo(result.message || `Ambiente ${env.name} detenido`);
      await loadProjectData(projectId);
    } catch (error: any) {
      setErr(error.message);
    } finally {
      setBusyId("");
    }
  }

  async function startEnvironment(env: Environment) {
    if (!projectId) return;
    setBusyId(`start-env-${env.id}`);
    setErr(null);
    setInfo(null);
    try {
      const result = await api<{ message?: string }>(`/api/environments/${env.id}/start`, {
        method: "POST",
        body: JSON.stringify({ project_id: projectId }),
      });
      setInfo(result.message || `Ambiente ${env.name} iniciado`);
      await loadProjectData(projectId);
    } catch (error: any) {
      setErr(error.message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <div>
      <Topbar title="Entornos" subtitle={`Trabajando en ${currentEnv.label}; solo se promueve al siguiente ambiente`} />

      <div className="card mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <Server className="w-4 h-4 text-cyan-300" />
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input max-w-sm">
            <option value="">Selecciona un proyecto</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Link href="/projects" className="btn-ghost text-xs">Proyectos</Link>
          {projectId && <Link href={`/new?project_id=${projectId}`} className="btn-primary text-xs">Nueva función</Link>}
          {projectId && <Link href="/container-apps" className="btn-ghost text-xs">Container Apps</Link>}
        </div>
        {projectId && (
          <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-[var(--border)]">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={deployAfterPromote} onChange={(e) => setDeployAfterPromote(e.target.checked)} />
              Deploy automático después de promover
            </label>
            <select value={bulkSourceEnvId} onChange={(e) => setBulkSourceEnvId(e.target.value)} className="input h-9 max-w-40 text-xs" disabled>
              {visibleEnvironments.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
            </select>
            <ArrowRight className="w-4 h-4 text-slate-500" />
            <select value={bulkTargetEnvId} onChange={(e) => setBulkTargetEnvId(e.target.value)} className="input h-9 max-w-40 text-xs" disabled>
              {!currentEnv.nextSlug && <option value="">Sin siguiente ambiente</option>}
              {bulkTargetOptions.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
            </select>
            <button
              onClick={() => bulkSourceEnv && bulkTargetEnv && promoteWholeProject(bulkSourceEnv.slug, bulkTargetEnv.slug)}
              disabled={!bulkSourceEnv || !bulkTargetEnv || busyId === `${bulkSourceEnv?.slug}-${bulkTargetEnv?.slug}`}
              className="btn-primary h-9 text-xs disabled:opacity-50"
            >
              {busyId === `${bulkSourceEnv?.slug}-${bulkTargetEnv?.slug}` ? "Promoviendo..." : "Promover proyecto"}
            </button>
          </div>
        )}
        {err && <div className="text-sm text-rose-300 mt-3">{err}</div>}
        {info && <div className="text-sm text-emerald-300 mt-3">{info}</div>}
      </div>

      {!projectId && <div className="card text-center text-slate-500 py-12">Crea o selecciona un proyecto para ver sus entornos.</div>}

      {promotionJob && (
        <div className="card mb-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {promotionJob.status === "running" ? <Loader2 className="w-4 h-4 animate-spin text-cyan-300" /> : <Terminal className="w-4 h-4 text-cyan-300" />}
                <span className="font-semibold truncate">{promotionJob.title}</span>
                <span className={`text-xs font-semibold ${jobStatusClass(promotionJob.status)}`}>{jobStatusLabel(promotionJob.status)}</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {promotionJob.source.toUpperCase()} a {promotionJob.target.toUpperCase()} - {promotionJob.percent}% - {elapsedLabel(promotionJob.startedAt, promotionJob.finishedAt)}
              </div>
            </div>
            <button type="button" onClick={() => setShowPromotionLog(true)} className="btn-ghost h-9 text-xs">
              <Terminal className="w-3.5 h-3.5" /> Ver log
            </button>
          </div>
          <div className="mt-3 h-2 rounded-full bg-slate-800 overflow-hidden">
            <div className={`h-full ${promotionJob.status === "failed" ? "bg-rose-400" : promotionJob.status === "success" ? "bg-emerald-400" : "bg-cyan-400"}`} style={{ width: `${promotionJob.percent}%` }} />
          </div>
        </div>
      )}

      {projectId && (
        <div className="space-y-5">
          {visibleEnvironments.map((env) => {
            const items = env.id === currentVisibleEnvironment?.id ? currentEnvironmentItems : (byEnvironment[env.id] || []);
            const rows = env.id === currentVisibleEnvironment?.id ? visibleFunctions : items;
            const promotionTargets = environments.filter((item) => item.slug === currentEnv.nextSlug);
            const memory = memorySummary(env, items, dashboard?.environmentStatus?.[0] || null);
            const canToggleContainer = memory.hasContainer || items.length > 0;
            return (
              <div key={env.id} className="card p-0 overflow-hidden">
                <div className="p-4 border-b border-[var(--border)] flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Server className="w-4 h-4 text-cyan-300" />
                      <h3 className="font-semibold">{env.name}</h3>
                      <span className="chip uppercase" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{env.slug}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{env.description}</p>
                  </div>
                  <div className="text-right text-xs text-slate-500">
                    <div>{filteredEnvironmentItems.length} funciones visibles</div>
                    <div>{currentEnv.nextSlug ? `Siguiente: ${currentEnv.nextSlug.toUpperCase()}` : "Ambiente final"}</div>
                  </div>
                </div>

                <div className="p-4 border-b border-[var(--border)] bg-black/10">
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
                    <div className="rounded-xl border border-[var(--border)] bg-black/20 p-4">
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                          <div className="text-xs uppercase text-slate-500">Memoria en vivo</div>
                          <div className="text-sm text-slate-200">
                            {memory.deployed} MB referenciales
                            <span className="text-slate-500"> · {memory.runningCount} funciones activas</span>
                            {memory.gatewayCount > 0 && <span className="text-slate-500"> · {memory.gatewayCount} Container Apps</span>}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">Se actualiza automaticamente con el estado del ambiente.</div>
                        </div>
                        <StatusBadge status={memory.status} label={memory.runningCount > 0 ? "En uso" : memory.hasContainer ? "Esperando" : "Sin actividad"} />
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <span className="text-slate-500">Memoria activa</span>
                          <div className="font-mono text-slate-200">{memory.deployed} MB</div>
                        </div>
                        <div>
                          <span className="text-slate-500">Funciones running</span>
                          <div className="font-mono text-slate-200">{memory.runningCount}</div>
                        </div>
                        <div>
                          <span className="text-slate-500">Container apps</span>
                          <div className="font-mono text-slate-200">{memory.gatewayCount}</div>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-[var(--border)] bg-black/20 p-4 flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs uppercase text-slate-500">Estado del container</div>
                          <div className="text-sm text-slate-200 mt-1 truncate">
                            {memory.containerName || "Sin Container App configurado"}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            {memory.containerUrl ? (
                              <a href={memory.containerUrl} target="_blank" rel="noreferrer" className="text-cyan-300 hover:text-cyan-200">
                                {memory.containerUrl}
                              </a>
                            ) : (
                              "Sin URL publica disponible"
                            )}
                          </div>
                        </div>
                        <StatusBadge
                          status={memory.status}
                          label={memory.targetState || (memory.hasContainer ? "configurado" : "idle")}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-slate-500">Modo</span>
                          <div className="font-mono text-slate-200 capitalize">{memory.deploymentMode}</div>
                        </div>
                        <div>
                          <span className="text-slate-500">Estado</span>
                          <div className="font-mono text-slate-200 capitalize">{memory.targetState || "idle"}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => memory.status === "running" ? stopEnvironment(env) : startEnvironment(env)}
                        disabled={!canToggleContainer || busyId === `stop-env-${env.id}` || busyId === `start-env-${env.id}`}
                        className={`h-9 text-xs justify-center disabled:opacity-50 ${memory.status === "running" ? "btn-ghost" : "btn-primary"}`}
                        title={memory.status === "running" ? "Detener el Container App del ambiente" : "Iniciar el Container App del ambiente"}
                      >
                        {memory.status === "running" ? (
                          <>
                            <Square className="w-3.5 h-3.5" />
                            {busyId === `stop-env-${env.id}` ? "Deteniendo ambiente..." : "Detener ambiente"}
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5" />
                            {busyId === `start-env-${env.id}` ? "Iniciando ambiente..." : "Iniciar ambiente"}
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="px-4 pt-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--panel-2)] border border-[var(--border)] flex-1 min-w-[240px]">
                      <Search className="w-4 h-4 text-slate-500" />
                      <input
                        value={functionSearch}
                        onChange={(e) => setFunctionSearch(e.target.value)}
                        placeholder="Buscar funciones..."
                        className="bg-transparent outline-none text-sm flex-1"
                      />
                    </div>
                    <select value={functionStatus} onChange={(e) => setFunctionStatus(e.target.value)} className="input w-48">
                      <option value="all">Todos los estados</option>
                      <option value="running">Running</option>
                      <option value="idle">Idle</option>
                      <option value="stopped">Stopped</option>
                      <option value="deploying">Deploying</option>
                      <option value="queued">Queued</option>
                      <option value="error">Error</option>
                      <option value="passed">Passed</option>
                      <option value="failed">Failed</option>
                    </select>
                  </div>
                </div>

                {rows.length === 0 ? (
                  <div className="p-10 text-center text-sm text-slate-500">
                    Sin funciones para los filtros seleccionados en {env.slug.toUpperCase()}.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[920px] text-sm">
                      <thead className="bg-[var(--panel-2)] text-xs uppercase text-slate-500">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold">Funcion</th>
                          <th className="px-4 py-3 text-left font-semibold">Estado</th>
                          <th className="px-4 py-3 text-left font-semibold">Runtime</th>
                          <th className="px-4 py-3 text-left font-semibold">Version</th>
                          <th className="px-4 py-3 text-left font-semibold">Actualizada</th>
                          <th className="px-4 py-3 text-left font-semibold">Destino</th>
                          <th className="px-4 py-3 text-right font-semibold">Acciones</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {rows.map((fn) => {
                          const promotedReadOnly = Boolean(fn.source_function_id);
                          const canOpenDeploy = !promotedReadOnly || !["running", "deploying", "queued"].includes(String(fn.status || ""));
                          return (
                            <tr key={fn.id} className="hover:bg-white/[0.03]">
                              <td className="px-4 py-3">
                                <div className="flex items-start gap-3">
                                  <div className="mt-0.5 rounded-md border border-cyan-400/20 bg-cyan-400/10 p-2 text-cyan-200">
                                    <Rocket className="w-4 h-4" />
                                  </div>
                                  <div className="min-w-0">
                                    <div className="font-semibold truncate">{fn.name}</div>
                                    <div className="font-mono text-xs text-slate-500 truncate">/{fn.slug}</div>
                                    {promotedReadOnly && (
                                      <div className="mt-1 text-[11px] text-amber-300">
                                        Homologada: cambios solo desde el ambiente origen.
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex flex-col items-start gap-1">
                                  <StatusBadge status={fn.status} />
                                  {fn.validation_status && <StatusBadge status={fn.validation_status} />}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-slate-200">{runtimeLabel(fn.runtime)}</div>
                                <div className="text-xs text-slate-500">{fn.memory_mb || 256} MB</div>
                              </td>
                              <td className="px-4 py-3 font-mono text-xs text-slate-300">{fn.active_deploy_version || "v1"}</td>
                              <td className="px-4 py-3 text-xs text-slate-400">
                                <div className="flex items-center gap-1.5">
                                  <Clock3 className="w-3.5 h-3.5 text-slate-500" />
                                  {formatShortDate(fn.updated_at)}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                {promotionTargets.length ? (
                                  <div className="flex flex-wrap gap-1.5">
                                    {promotionTargets.map((targetEnv) => (
                                      <span key={targetEnv.id} className="chip uppercase" style={{ borderColor: "rgba(139,92,246,.45)", color: "#c4b5fd", background: "rgba(139,92,246,.08)" }}>
                                        {env.slug} <ArrowRight className="w-3 h-3" /> {targetEnv.slug}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-xs text-slate-500">Sin siguiente ambiente</span>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex flex-wrap items-center justify-end gap-2">
                                  {fn.url && (
                                    <a href={fn.url} target="_blank" rel="noreferrer" className="btn-ghost h-8 text-xs">
                                      <ExternalLink className="w-3.5 h-3.5" /> URL
                                    </a>
                                  )}
                                  <Link href={`/functions/${fn.id}`} className="btn-ghost h-8 text-xs">Abrir</Link>
                                  <Link href={`/functions/${fn.id}?tab=logs`} className="btn-ghost h-8 text-xs">
                                    <Terminal className="w-3.5 h-3.5" /> Logs
                                  </Link>
                                  {canOpenDeploy && (
                                    <Link href={`/functions/${fn.id}`} className="btn-ghost h-8 text-xs">
                                      <Rocket className="w-3.5 h-3.5" /> {promotedReadOnly ? "Deploy inicial" : "Deploy"}
                                    </Link>
                                  )}
                                  {promotionTargets.map((targetEnv) => {
                                    const promoteId = `${fn.id}-${targetEnv.slug}`;
                                    return (
                                      <button
                                        key={targetEnv.id}
                                        onClick={() => promote(fn, targetEnv.slug)}
                                        disabled={busyId === promoteId}
                                        className="btn-primary h-8 text-xs disabled:opacity-50 justify-center min-w-0"
                                        title={`Promover a ${targetEnv.name}`}
                                      >
                                        {busyId === promoteId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Boxes className="w-3.5 h-3.5" />}
                                        {busyId === promoteId ? "Promoviendo..." : `A ${targetEnv.slug}`}
                                        <ArrowRight className="w-3.5 h-3.5" />
                                      </button>
                                    );
                                  })}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {rows.length > 0 && (
                  <div className="px-4 pb-4">
                    <Pagination
                      page={currentFunctionPage}
                      totalPages={functionTotalPages}
                      totalItems={filteredEnvironmentItems.length}
                      pageSize={functionPageSize}
                      onPageChange={setFunctionPage}
                      onPageSizeChange={(next) => {
                        setFunctionPageSize(next);
                        setFunctionPage(1);
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {promotionJob && showPromotionLog && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-5xl max-h-[85vh] rounded-lg border border-[var(--border-2)] bg-[#070711] shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-[var(--border)] flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-cyan-200">
                  <Terminal className="w-4 h-4" />
                  <span className="font-semibold">Consola de promocion</span>
                </div>
                <h3 className="mt-2 text-lg font-semibold">{promotionJob.title}</h3>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className={jobStatusClass(promotionJob.status)}>{jobStatusLabel(promotionJob.status)}</span>
                  <span>{promotionJob.percent}%</span>
                  <span>{elapsedLabel(promotionJob.startedAt, promotionJob.finishedAt)}</span>
                </div>
              </div>
              <button type="button" onClick={() => setShowPromotionLog(false)} className="btn-ghost h-9 w-9 p-0 justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 border-b border-[var(--border)]">
              <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                <div className={`h-full ${promotionJob.status === "failed" ? "bg-rose-400" : promotionJob.status === "success" ? "bg-emerald-400" : "bg-cyan-400"}`} style={{ width: `${promotionJob.percent}%` }} />
              </div>
            </div>
            <div className="max-h-[55vh] overflow-auto font-mono text-xs">
              {promotionJob.logs.map((log) => (
                <div key={log.id} className="grid grid-cols-[130px_86px_78px_minmax(0,1fr)] gap-3 px-4 py-3 border-b border-white/5">
                  <span className="text-slate-500">{new Date(log.ts).toLocaleTimeString()}</span>
                  <span className={jobStatusClass(log.status)}>{log.status}</span>
                  <span className="text-slate-400">{log.percent}%</span>
                  <span className="text-slate-200 whitespace-pre-wrap">[{log.step}] {log.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function EnvironmentsPage() {
  return <Suspense fallback={<div className="text-slate-400">Cargando...</div>}><EnvironmentsInner /></Suspense>;
}

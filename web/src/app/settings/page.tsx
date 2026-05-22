"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Topbar } from "@/components/Topbar";
import { api, API } from "@/lib/api";
import { useCurrentEnvironment } from "@/lib/environment";
import { AlertTriangle, BrainCircuit, CheckCircle2, Cloud, Database, ExternalLink, History, Loader2, Rocket, RotateCcw, Server, Terminal, X } from "lucide-react";

type Meta = { ok: boolean; store: string; ai_validation: boolean };
type PlatformTarget = {
  id: string;
  project_id?: string | null;
  environment_id?: string | null;
  project_name?: string | null;
  environment_name?: string | null;
  environment_slug?: string | null;
  deployment_mode?: string;
  azure_resource_group?: string;
  azure_location?: string;
  container_app_environment?: string;
  platform_api_container_app_url?: string | null;
  platform_web_container_app_url?: string | null;
  auth_redirect_uri?: string | null;
  platform_version?: string | null;
  platform_deployed_version?: string | null;
  platform_deployed_at?: string | null;
  platform_deploy_started_at?: string | null;
  platform_deploy_step?: string | null;
  platform_deploy_percent?: number | null;
  platform_deploy_logs?: { ts?: string; step?: string; percent?: number; status?: string; message?: string }[] | null;
  platform_deploy_status?: string | null;
  platform_deploy_error?: string | null;
  platform_ready?: boolean;
  updated_at?: string | null;
};

type PlatformDeploymentHistory = {
  id: string;
  target_id: string;
  project_id?: string | null;
  environment_id?: string | null;
  target_name?: string | null;
  project_name?: string | null;
  environment_name?: string | null;
  environment_slug?: string | null;
  version: string;
  status: string;
  active?: boolean;
  change_summary?: string | null;
  change_details?: { label?: string; message?: string; before?: string | null; after?: string | null }[];
  snapshot?: { target?: Record<string, any>; meta?: Record<string, any> } | null;
  error?: string | null;
  source_platform_deployment_id?: string | null;
  created_at: string;
  updated_at?: string | null;
  finished_at?: string | null;
};

function deployStatus(target: PlatformTarget) {
  if (target.platform_deploy_status === "running") return "running";
  if (target.platform_deploy_status === "blocked") return "blocked";
  if (target.platform_deploy_status === "failed") return "failed";
  if (target.platform_deploy_status === "canceled") return "canceled";
  if (target.platform_ready) return "success";
  if (target.deployment_mode !== "azure") return "missing";
  return "pending";
}

function statusTone(status: string) {
  if (status === "success") return "text-emerald-300 border-emerald-500/30";
  if (status === "failed") return "text-rose-300 border-rose-500/30";
  if (status === "canceled") return "text-slate-300 border-slate-500/30";
  if (status === "running") return "text-cyan-300 border-cyan-500/30";
  if (status === "blocked") return "text-amber-300 border-amber-500/30";
  if (status === "warning") return "text-amber-300 border-amber-500/30";
  if (status === "missing") return "text-amber-300 border-amber-500/30";
  return "text-slate-300 border-slate-500/30";
}

function statusLabel(status: string) {
  if (status === "success") return "Desplegado";
  if (status === "failed") return "Error";
  if (status === "canceled") return "Cancelado";
  if (status === "running") return "Desplegando";
  if (status === "blocked") return "Azure ocupado";
  if (status === "missing") return "Configurar Azure";
  return "Pendiente";
}

function deployLockedUntil(target: PlatformTarget) {
  const status = target.platform_deploy_status;
  if (status !== "running" && status !== "blocked") return null;
  const updated = Date.parse(target.updated_at || target.platform_deployed_at || "");
  const ttlMs = status === "blocked" ? 10 * 60 * 1000 : 60 * 60 * 1000;
  if (!Number.isFinite(updated)) return Date.now() + ttlMs;
  const until = updated + ttlMs;
  return until > Date.now() ? until : null;
}

function messageSummary(message: string) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (/failed to copy|broken pipe|The push refers|docker push|Pushed failed/i.test(text)) {
    return "No se pudo subir la imagen al ACR. Revisa el registry, permisos y vuelve a desplegar.";
  }
  if (/active provisioning operation|Cannot modify a container app|provisioning operation.*progress/i.test(text)) {
    return "Azure todavia esta procesando ese Container App. Espera unos minutos y vuelve a desplegar.";
  }
  if (/container app|not found|ResourceNotFound|no existe/i.test(text)) {
    return "Azure no encontro un recurso esperado. Puedes volver a ejecutar el despliegue para recrearlo.";
  }
  if (text.length <= 180) return text;
  return `${text.slice(0, 177).trim()}...`;
}

function elapsedLabel(started?: string | null, ended?: string | null) {
  const start = Date.parse(started || "");
  if (!Number.isFinite(start)) return "-";
  const end = ended ? Date.parse(ended) : Date.now();
  const ms = Math.max(0, (Number.isFinite(end) ? end : Date.now()) - start);
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function shortStep(step?: string | null) {
  if (!step) return "Esperando";
  return String(step).replace(/-/g, " ");
}

export default function SettingsPage() {
  const currentEnv = useCurrentEnvironment();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [platformTargets, setPlatformTargets] = useState<PlatformTarget[]>([]);
  const [platformVersions, setPlatformVersions] = useState<Record<string, string>>({});
  const [deployingTarget, setDeployingTarget] = useState("");
  const [cancelingTarget, setCancelingTarget] = useState("");
  const [platformMessage, setPlatformMessage] = useState("");
  const [logTargetId, setLogTargetId] = useState("");
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({});
  const [platformHistoryTarget, setPlatformHistoryTarget] = useState<PlatformTarget | null>(null);
  const [platformHistoryItems, setPlatformHistoryItems] = useState<PlatformDeploymentHistory[]>([]);
  const [platformHistorySelectedId, setPlatformHistorySelectedId] = useState("");
  const [platformHistoryLoading, setPlatformHistoryLoading] = useState(false);
  const [platformHistoryError, setPlatformHistoryError] = useState("");
  const [rollbackingPlatformDeploymentId, setRollbackingPlatformDeploymentId] = useState("");

  async function loadPlatformTargets() {
    const targets = await api<PlatformTarget[]>("/api/platform/container-apps");
    const allowed = new Set(
      currentEnv.slug === "dev"
        ? ["test"]
        : currentEnv.nextSlug
          ? [currentEnv.slug, currentEnv.nextSlug]
          : [currentEnv.slug]
    );
    const visibleTargets = (targets || []).filter((target) => allowed.has(String(target.environment_slug || "").toLowerCase()));
    setPlatformTargets(visibleTargets);
    setPlatformVersions((current) => {
      const next = { ...current };
      for (const target of visibleTargets) {
        next[target.id] ||= target.platform_version || target.platform_deployed_version || "1.0.0";
      }
      return next;
    });
  }

  useEffect(() => {
    api<Meta>("/api/meta").then(setMeta).catch(() => {});
    loadPlatformTargets().catch(() => {});
  }, [currentEnv.slug, currentEnv.nextSlug]);

  useEffect(() => {
    closePlatformHistory();
  }, [currentEnv.slug, currentEnv.nextSlug]);

  useEffect(() => {
    const active = platformTargets.some((target) => ["running", "blocked"].includes(String(target.platform_deploy_status || "")));
    if (!active && !logTargetId) return;
    const timer = setInterval(() => {
      loadPlatformTargets().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [platformTargets, logTargetId]);

  async function deployPlatform(target: PlatformTarget) {
    if (!target.id || deployingTarget) return;
    setDeployingTarget(target.id);
    setPlatformMessage("");
    try {
      const result = await api<{ message?: string; target: PlatformTarget }>(`/api/platform/container-apps/${target.id}/deploy`, {
        method: "POST",
        body: JSON.stringify({ platform_version: platformVersions[target.id] || target.platform_version || "1.0.0" }),
      });
      setPlatformTargets((current) => current.map((item) => item.id === target.id ? result.target : item));
      setPlatformVersions((current) => ({ ...current, [target.id]: result.target.platform_version || current[target.id] || "1.0.0" }));
      setPlatformMessage(result.message || "Plataforma desplegada");
    } catch (error: any) {
      setPlatformMessage(error?.message || "No se pudo desplegar la plataforma");
      await loadPlatformTargets().catch(() => {});
    } finally {
      setDeployingTarget("");
    }
  }

  async function cancelPlatformDeploy(target: PlatformTarget) {
    if (!target.id || cancelingTarget) return;
    setCancelingTarget(target.id);
    setPlatformMessage("");
    try {
      const result = await api<{ message?: string; target: PlatformTarget }>(`/api/platform/container-apps/${target.id}/cancel`, {
        method: "POST",
      });
      setPlatformTargets((current) => current.map((item) => item.id === target.id ? result.target : item));
      setPlatformMessage(result.message || "Deploy cancelado");
    } catch (error: any) {
      setPlatformMessage(error?.message || "No se pudo cancelar el deploy");
      await loadPlatformTargets().catch(() => {});
    } finally {
      setCancelingTarget("");
    }
  }

  async function openPlatformHistory(target: PlatformTarget) {
    if (!target.id) return;
    setPlatformHistoryTarget(target);
    setPlatformHistoryLoading(true);
    setPlatformHistoryError("");
    setPlatformHistoryItems([]);
    setPlatformHistorySelectedId("");
    try {
      const items = await api<PlatformDeploymentHistory[]>(`/api/platform/container-apps/${target.id}/deployments`);
      const ordered = (items || []).slice().sort((a, b) =>
        String(b.finished_at || b.updated_at || b.created_at || "").localeCompare(String(a.finished_at || a.updated_at || a.created_at || ""))
      );
      setPlatformHistoryItems(ordered);
      setPlatformHistorySelectedId(ordered.find((item) => item.active)?.id || ordered[0]?.id || "");
    } catch (error: any) {
      setPlatformHistoryError(error?.message || "No se pudo cargar el historial");
    } finally {
      setPlatformHistoryLoading(false);
    }
  }

  function closePlatformHistory() {
    setPlatformHistoryTarget(null);
    setPlatformHistoryItems([]);
    setPlatformHistorySelectedId("");
    setPlatformHistoryLoading(false);
    setPlatformHistoryError("");
  }

  async function rollbackPlatformDeployment(deployment: PlatformDeploymentHistory) {
    if (!platformHistoryTarget?.id || rollbackingPlatformDeploymentId) return;
    setRollbackingPlatformDeploymentId(deployment.id);
    setPlatformHistoryError("");
    try {
      const result = await api<{ message?: string; target: PlatformTarget }>(
        `/api/platform/container-apps/${platformHistoryTarget.id}/deployments/${deployment.id}/rollback`,
        { method: "POST", body: JSON.stringify({}) }
      );
      setPlatformTargets((current) => current.map((item) => item.id === result.target.id ? result.target : item));
      setPlatformVersions((current) => ({
        ...current,
        [result.target.id]: result.target.platform_version || current[result.target.id] || deployment.version,
      }));
      setPlatformMessage(result.message || `Rollback ejecutado a ${deployment.version}`);
      await openPlatformHistory(result.target);
    } catch (error: any) {
      setPlatformHistoryError(error?.message || "No se pudo ejecutar el rollback");
    } finally {
      setRollbackingPlatformDeploymentId("");
    }
  }

  function toggleMessage(key: string) {
    setExpandedMessages((current) => ({ ...current, [key]: !current[key] }));
  }

  function notice(key: string, message: string, isError = false) {
    const summary = messageSummary(message);
    const expanded = Boolean(expandedMessages[key]);
    const hasMore = summary !== message;
    return (
      <div className={`rounded-lg border px-3 py-2 text-sm ${isError ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"}`}>
        <div className="flex items-start gap-2">
          {isError && <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
          <div className="min-w-0 flex-1">
            <div className="break-words">{summary}</div>
            {hasMore && (
              <button
                type="button"
                onClick={() => toggleMessage(key)}
                className="mt-1 text-xs font-medium text-violet-200 hover:text-violet-100"
              >
                {expanded ? "Ver menos" : "Ver mas"}
              </button>
            )}
          </div>
        </div>
        {hasMore && expanded && (
          <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-rose-500/20 bg-black/30 p-2 text-[11px] leading-relaxed text-rose-100 whitespace-pre-wrap break-words">
            {message}
          </pre>
        )}
      </div>
    );
  }

  const logTarget = logTargetId ? platformTargets.find((target) => target.id === logTargetId) || null : null;
  const logStatus = logTarget ? deployStatus(logTarget) : "";
  const logProgress = logTarget ? Math.max(0, Math.min(100, Number(logTarget.platform_deploy_percent || 0))) : 0;
  const logEntries = logTarget?.platform_deploy_logs || [];
  const platformHistorySelected = platformHistorySelectedId
    ? platformHistoryItems.find((item) => item.id === platformHistorySelectedId) || platformHistoryItems[0] || null
    : platformHistoryItems[0] || null;
  const platformHistorySnapshot = platformHistorySelected?.snapshot?.target || {};

  return (
    <>
    <div>
      <Topbar title="Configuracion" subtitle={`Estado operativo visto desde ${currentEnv.label}`} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="card lg:col-span-2 space-y-4">
          <h3 className="font-semibold">General</h3>
          <div>
            <label className="text-xs text-slate-400">Nombre de la plataforma</label>
            <input className="input mt-1" defaultValue="Function Platform" />
          </div>
          <div>
            <label className="text-xs text-slate-400">URL de la API</label>
            <input className="input mt-1" value={API} readOnly />
          </div>
          <div>
            <label className="text-xs text-slate-400">Entornos estandar</label>
            <div className="flex flex-wrap gap-2 mt-2">
              {["dev", "test", "prod"].map((env) => (
                <span key={env} className="chip uppercase" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{env}</span>
              ))}
            </div>
          </div>
          <button className="btn-primary">Guardar cambios</button>

          <div className="border-t border-[var(--border)] pt-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-cyan-500/15 text-cyan-300 grid place-items-center">
                  <Cloud className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-semibold">Web y API en Azure</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Redeploy pesado solo de la plataforma. Las funciones y sus archivos viajan desde Entornos al promover o desplegar.
                  </p>
                </div>
              </div>
              <Link href="/container-apps" className="btn-ghost h-9 text-xs">
                <Server className="w-4 h-4" /> Configurar targets
              </Link>
            </div>

            {platformMessage && (
              notice("platform-message", platformMessage, /^No se pudo|Falta|El ambiente|Azure no pudo/i.test(platformMessage))
            )}

            {platformTargets.length === 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                No hay targets guardados para test o prod. Configura primero los ambientes en Container Apps.
              </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {platformTargets.map((target) => {
                const status = deployStatus(target);
                const lockedUntil = deployLockedUntil(target);
                const locked = Boolean(lockedUntil);
                const busy = deployingTarget === target.id || status === "running";
                const desiredVersion = platformVersions[target.id] || target.platform_version || "1.0.0";
                const deployedVersion = target.platform_deployed_version || "";
                const versionPending = Boolean(desiredVersion && deployedVersion && desiredVersion !== deployedVersion);
                const progress = Math.max(0, Math.min(100, Number(target.platform_deploy_percent || 0)));
                const canDeploy = target.deployment_mode === "azure" && !busy && !locked;
                const buttonLabel = busy
                  ? "Desplegando..."
                  : locked
                    ? "Esperando Azure"
                    : status === "success"
                      ? "Redeploy"
                      : status === "blocked"
                        ? "Reintentar"
                        : "Crear y desplegar";
                return (
                  <div key={target.id} className="rounded-lg border border-[var(--border)] bg-black/20 p-3 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{target.project_name || "Proyecto"}</span>
                          <span className="chip uppercase" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>
                            {target.environment_slug || target.environment_name}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {target.azure_resource_group || "resource group pendiente"} - {target.azure_location || "region pendiente"}
                        </div>
                      </div>
                      <span className={`chip ${statusTone(status)}`}>{statusLabel(status)}</span>
                    </div>

                    <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="text-xs text-slate-500">Version plataforma</label>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openPlatformHistory(target)}
                            className="inline-flex items-center gap-1 text-[11px] text-violet-300 hover:text-violet-200 hover:underline"
                          >
                            <History className="w-3.5 h-3.5" />
                            Ver historial
                          </button>
                          <span className={`chip ${versionPending ? "text-amber-300 border-amber-500/30" : "text-emerald-300 border-emerald-500/30"}`}>
                            {deployedVersion ? (versionPending ? "Pendiente de impactar" : "Homologada") : "Sin impactar"}
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-center">
                        <input
                          value={desiredVersion}
                          onChange={(event) => setPlatformVersions((current) => ({ ...current, [target.id]: event.target.value }))}
                          className="input font-mono"
                          placeholder="1.0.0"
                        />
                        <div className="text-xs text-slate-500 sm:text-right">
                          Impactada: <span className="font-mono text-slate-300">{deployedVersion || "-"}</span>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-2 text-xs">
                      <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2">
                        <div className="text-slate-500">API</div>
                        {target.platform_api_container_app_url ? (
                          <a href={target.platform_api_container_app_url} target="_blank" className="mt-1 text-violet-300 hover:underline inline-flex items-center gap-1 break-all">
                            <ExternalLink className="w-3.5 h-3.5 shrink-0" /> {target.platform_api_container_app_url}
                          </a>
                        ) : (
                          <div className="mt-1 text-slate-400">Pendiente</div>
                        )}
                      </div>
                      <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2">
                        <div className="text-slate-500">Web</div>
                        {target.platform_web_container_app_url ? (
                          <a href={target.platform_web_container_app_url} target="_blank" className="mt-1 text-violet-300 hover:underline inline-flex items-center gap-1 break-all">
                            <ExternalLink className="w-3.5 h-3.5 shrink-0" /> {target.platform_web_container_app_url}
                          </a>
                        ) : (
                          <div className="mt-1 text-slate-400">Pendiente</div>
                        )}
                      </div>
                      <div className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2">
                        <div className="text-slate-500">Callback auth</div>
                        {target.auth_redirect_uri ? (
                          <div className="mt-1 font-mono text-[11px] leading-5 text-cyan-200 break-all">
                            {target.auth_redirect_uri}
                          </div>
                        ) : (
                          <div className="mt-1 text-slate-400">Se calcula automaticamente al desplegar Web</div>
                        )}
                      </div>
                    </div>

                    {target.platform_deploy_error && (
                      notice(`target-error-${target.id}`, target.platform_deploy_error, true)
                    )}
                    {["running", "blocked", "failed", "canceled"].includes(status) && (
                      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-slate-300">
                            {shortStep(target.platform_deploy_step)} - {progress}% - {elapsedLabel(target.platform_deploy_started_at, status === "running" ? null : target.updated_at)}
                          </div>
                          <button type="button" onClick={() => setLogTargetId(target.id)} className="inline-flex items-center gap-1 text-cyan-300 hover:underline">
                            <Terminal className="w-3.5 h-3.5" />
                            Ver log
                          </button>
                        </div>
                        <div className="mt-2 h-1.5 rounded-full bg-black/40 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${status === "failed" ? "bg-rose-400" : status === "canceled" ? "bg-slate-400" : status === "blocked" ? "bg-amber-400" : "bg-cyan-400"}`}
                            style={{ width: `${Math.max(4, progress)}%` }}
                          />
                        </div>
                      </div>
                    )}
                    {locked && (
                      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        Bloqueado temporalmente para no ejecutar otro deploy mientras Azure termina la operacion actual.
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-xs text-slate-500">
                        {target.platform_deployed_at
                          ? `Ultimo deploy ${deployedVersion || ""}: ${new Date(target.platform_deployed_at).toLocaleString()}`
                          : target.container_app_environment || "Managed Environment pendiente"}
                      </div>
                      <button type="button" onClick={() => setLogTargetId(target.id)} className="btn-ghost h-9 text-xs">
                        <Terminal className="w-4 h-4" />
                        Ver log
                      </button>
                      {["running", "blocked"].includes(status) && (
                        <button
                          type="button"
                          onClick={() => cancelPlatformDeploy(target)}
                          disabled={cancelingTarget === target.id}
                          className="btn-ghost h-9 text-xs border-rose-500/30 text-rose-200 disabled:opacity-50"
                          title="Cancelar este deploy y liberar el bloqueo"
                        >
                          {cancelingTarget === target.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                          Cancelar
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={!canDeploy}
                        onClick={() => deployPlatform(target)}
                        className="btn-primary h-9 text-xs disabled:opacity-50"
                        title={locked ? "Azure esta procesando una operacion sobre este Container App" : target.deployment_mode === "azure" ? "Crear o actualizar Web y API" : "El target debe estar en modo Azure automatico"}
                      >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : locked ? <AlertTriangle className="w-4 h-4" /> : status === "success" ? <CheckCircle2 className="w-4 h-4" /> : <Rocket className="w-4 h-4" />}
                        {buttonLabel}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card">
            <div className="flex items-center gap-3 mb-3">
              <Database className="w-5 h-5 text-violet-300" />
              <h3 className="font-semibold">Datos</h3>
            </div>
            <div className="text-sm text-slate-400">Modo activo</div>
            <div className="mt-2 text-2xl font-semibold">{meta?.store || "..."}</div>
            <p className="text-xs text-slate-500 mt-3">Si PostgreSQL no responde, el API usa almacenamiento local persistente del volumen Docker.</p>
          </div>

          <div className="card">
            <div className="flex items-center gap-3 mb-3">
              <BrainCircuit className="w-5 h-5 text-cyan-300" />
              <h3 className="font-semibold">Validacion IA</h3>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-400">OPENAI_API_KEY</span>
              <span className={`chip ${meta?.ai_validation ? "text-emerald-300 border-emerald-500/30" : "text-amber-300 border-amber-500/30"}`}>
                {meta?.ai_validation ? "Activa" : "Pendiente"}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-3">La validacion estatica siempre corre; la revision IA se suma cuando configuras la clave.</p>
          </div>

          <div className="card">
            <div className="flex items-center gap-3 mb-3">
              <Server className="w-5 h-5 text-emerald-300" />
              <h3 className="font-semibold">Runtime</h3>
            </div>
            <div className="text-sm text-slate-400">Node 20 - Docker containers</div>
          </div>
        </div>
      </div>
    </div>
    {platformHistoryTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
        <div className="w-full max-w-6xl max-h-[90vh] overflow-hidden rounded-xl border border-[var(--border)] bg-[#0b0b14] shadow-2xl">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-cyan-200">
                <History className="w-4 h-4" />
                Historial de plataforma
              </div>
              <h3 className="mt-1 truncate text-lg font-semibold">
                {platformHistoryTarget.project_name || "Proyecto"} - {String(platformHistoryTarget.environment_slug || platformHistoryTarget.environment_name || "").toUpperCase()}
              </h3>
              <div className="mt-1 text-xs text-slate-400">
                Versionado del motor Web/API para este ambiente
              </div>
            </div>
            <button
              type="button"
              onClick={closePlatformHistory}
              className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] text-slate-300 hover:bg-white/5"
              aria-label="Cerrar historial"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] max-h-[calc(90vh-73px)]">
            <div className="border-b lg:border-b-0 lg:border-r border-[var(--border)] bg-black/20">
              <div className="border-b border-[var(--border)] px-4 py-3 text-xs text-slate-400">
                {platformHistoryLoading ? "Cargando versiones..." : `${platformHistoryItems.length} versiones registradas`}
              </div>
              <div className="max-h-[calc(90vh-140px)] overflow-auto p-3 space-y-2">
                {platformHistoryError && (
                  <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                    {platformHistoryError}
                  </div>
                )}
                {platformHistoryLoading ? (
                  <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-white/[0.03] p-3 text-sm text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Cargando historial...
                  </div>
                ) : platformHistoryItems.length === 0 ? (
                  <div className="rounded-lg border border-[var(--border)] bg-white/[0.03] p-3 text-sm text-slate-400">
                    Aun no hay deployments de plataforma para este ambiente.
                  </div>
                ) : (
                  platformHistoryItems.map((deployment) => {
                    const selected = deployment.id === platformHistorySelected?.id;
                    return (
                      <button
                        key={deployment.id}
                        type="button"
                        onClick={() => setPlatformHistorySelectedId(deployment.id)}
                        className={`w-full rounded-lg border p-3 text-left transition ${
                          selected
                            ? "border-violet-500/40 bg-violet-500/10"
                            : "border-[var(--border)] bg-white/[0.03] hover:bg-white/[0.05]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-mono text-sm text-cyan-200">{deployment.version}</div>
                            <div className="mt-1 text-[11px] text-slate-400">
                              {new Date(deployment.finished_at || deployment.updated_at || deployment.created_at).toLocaleString()}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <span className={`chip ${statusTone(deployment.status)}`}>{statusLabel(deployment.status)}</span>
                            <span className={`chip ${deployment.active ? "text-emerald-300 border-emerald-500/30" : "text-slate-300 border-slate-500/30"}`}>
                              {deployment.active ? "Actual" : "Historico"}
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 text-xs text-slate-300 break-words">
                          {deployment.change_summary || "Sin resumen de cambios"}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="max-h-[calc(90vh-140px)] overflow-auto p-4">
              {!platformHistorySelected ? (
                <div className="rounded-lg border border-[var(--border)] bg-white/[0.03] p-4 text-sm text-slate-400">
                  Selecciona una version para ver el detalle.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-lg border border-[var(--border)] bg-black/20 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-lg text-cyan-200">{platformHistorySelected.version}</span>
                          <span className={`chip ${statusTone(platformHistorySelected.status)}`}>{statusLabel(platformHistorySelected.status)}</span>
                          <span className={`chip ${platformHistorySelected.active ? "text-emerald-300 border-emerald-500/30" : "text-slate-300 border-slate-500/30"}`}>
                            {platformHistorySelected.active ? "Actual" : "Historico"}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-slate-400">
                          {new Date(platformHistorySelected.finished_at || platformHistorySelected.updated_at || platformHistorySelected.created_at).toLocaleString()}
                        </div>
                      </div>
                      {platformHistorySelected.status === "success" && !platformHistorySelected.active && (
                        <button
                          type="button"
                          onClick={() => rollbackPlatformDeployment(platformHistorySelected)}
                          disabled={rollbackingPlatformDeploymentId === platformHistorySelected.id}
                          className="btn-primary h-9 text-xs disabled:opacity-50"
                        >
                          {rollbackingPlatformDeploymentId === platformHistorySelected.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RotateCcw className="w-4 h-4" />
                          )}
                          Rollback
                        </button>
                      )}
                    </div>
                    <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-sm text-slate-300">
                      {platformHistorySelected.change_summary || "Sin resumen de cambios"}
                    </div>
                    {platformHistorySelected.change_details?.length ? (
                      <div className="mt-3 space-y-2">
                        {platformHistorySelected.change_details.map((detail, index) => (
                          <div key={`${detail.label || "detail"}-${index}`} className="rounded-md border border-white/5 bg-white/[0.03] p-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-medium text-slate-200">{detail.label || "Cambio"}</div>
                              <div className="text-slate-500">{detail.message || ""}</div>
                            </div>
                            {(detail.before !== undefined || detail.after !== undefined) && (
                              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="rounded-md border border-white/5 bg-black/20 p-2">
                                  <div className="text-slate-500">Antes</div>
                                  <div className="mt-1 break-words text-slate-200">{String(detail.before ?? "-")}</div>
                                </div>
                                <div className="rounded-md border border-white/5 bg-black/20 p-2">
                                  <div className="text-slate-500">Despues</div>
                                  <div className="mt-1 break-words text-slate-200">{String(detail.after ?? "-")}</div>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {[
                      ["Version activa", platformHistorySnapshot.platform_version || "-"],
                      ["Version impactada", platformHistorySnapshot.platform_deployed_version || "-"],
                      ["API", platformHistorySnapshot.platform_api_container_app_url || "Pendiente"],
                      ["Web", platformHistorySnapshot.platform_web_container_app_url || "Pendiente"],
                      ["Callback auth", platformHistorySnapshot.auth_redirect_uri || "Pendiente"],
                      ["Region", platformHistorySnapshot.azure_location || "Pendiente"],
                      ["Resource group", platformHistorySnapshot.azure_resource_group || "Pendiente"],
                      ["ACR", platformHistorySnapshot.acr_name || "Pendiente"],
                      ["Managed Environment", platformHistorySnapshot.container_app_environment || "Pendiente"],
                      ["Memoria", platformHistorySnapshot.memory_budget_mb ? `${platformHistorySnapshot.memory_budget_mb} MB` : "Pendiente"],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-sm">
                        <div className="text-slate-500">{label}</div>
                        <div className="mt-1 break-words font-mono text-xs text-slate-200">{String(value)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )}
    {logTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="w-full max-w-5xl max-h-[88vh] overflow-hidden rounded-xl border border-[var(--border)] bg-[#0b0b14] shadow-2xl">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-cyan-200">
                <Terminal className="w-4 h-4" />
                Consola de deploy
              </div>
              <h3 className="mt-1 truncate text-lg font-semibold">
                {logTarget.project_name || "Proyecto"} - {String(logTarget.environment_slug || logTarget.environment_name || "").toUpperCase()}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span className={`chip ${statusTone(logStatus)}`}>{statusLabel(logStatus)}</span>
                <span>Version {platformVersions[logTarget.id] || logTarget.platform_version || "1.0.0"}</span>
                <span>{logProgress}%</span>
                <span>{elapsedLabel(logTarget.platform_deploy_started_at, logStatus === "running" ? null : logTarget.updated_at)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setLogTargetId("")}
              className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] text-slate-300 hover:bg-white/5"
              aria-label="Cerrar log"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="border-b border-[var(--border)] px-4 py-3">
            {["running", "blocked"].includes(logStatus) && (
              <div className="mb-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => cancelPlatformDeploy(logTarget)}
                  disabled={cancelingTarget === logTarget.id}
                  className="btn-ghost h-9 text-xs border-rose-500/30 text-rose-200 disabled:opacity-50"
                >
                  {cancelingTarget === logTarget.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                  Cancelar deploy
                </button>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 text-xs text-slate-300">
              <span className="truncate">{shortStep(logTarget.platform_deploy_step)}</span>
              <span className="font-mono">{logProgress}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-950">
              <div
                className={`h-full rounded-full transition-all ${logStatus === "failed" ? "bg-rose-400" : logStatus === "canceled" ? "bg-slate-400" : logStatus === "blocked" ? "bg-amber-400" : logStatus === "success" ? "bg-emerald-400" : "bg-cyan-400"}`}
                style={{ width: `${Math.max(logProgress, logStatus === "pending" ? 0 : 4)}%` }}
              />
            </div>
            {logTarget.platform_deploy_error && (
              <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-100">
                <div className="mb-1 font-semibold text-rose-200">Error detectado</div>
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed">{logTarget.platform_deploy_error}</pre>
              </div>
            )}
          </div>

          <div className="max-h-[56vh] overflow-auto bg-black px-4 py-3 font-mono text-[11px] leading-relaxed">
            {logEntries.length === 0 ? (
              <div className="rounded-lg border border-[var(--border)] bg-white/[0.03] p-3 text-slate-500">
                Todavia no hay eventos guardados para este deploy.
              </div>
            ) : (
              logEntries.map((entry, index) => {
                const entryStatus = entry.status || "running";
                const tone = entryStatus === "failed"
                  ? "text-rose-300"
                  : entryStatus === "canceled"
                    ? "text-slate-300"
                  : entryStatus === "blocked" || entryStatus === "warning"
                    ? "text-amber-300"
                    : entryStatus === "success"
                      ? "text-emerald-300"
                      : "text-cyan-300";
                return (
                  <div key={`${entry.ts || index}-${index}`} className="grid grid-cols-1 gap-1 border-b border-white/5 py-2 last:border-b-0 md:grid-cols-[150px_86px_72px_1fr]">
                    <span className="text-slate-500">{entry.ts ? new Date(entry.ts).toLocaleTimeString() : "--:--:--"}</span>
                    <span className={tone}>{entryStatus}</span>
                    <span className="text-slate-400">{Number(entry.percent || 0)}%</span>
                    <span className="min-w-0 whitespace-pre-wrap break-words text-slate-200">
                      [{shortStep(entry.step)}] {entry.message || "Actualizando estado"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}

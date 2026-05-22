"use client";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Topbar } from "@/components/Topbar";
import { AlertTriangle, CheckCircle2, Cloud, Copy, ExternalLink, GitBranch, Loader2, Save, Server, Trash2 } from "lucide-react";

type Project = { id: string; name: string; slug: string };
type Environment = { id: string; project_id: string; name: string; slug: string; project_name?: string | null };
type ProvisioningStep = {
  id: string;
  label: string;
  percent: number;
  status?: "pending" | "running" | "success" | "failed" | "deleted" | string;
  message?: string;
};
type Target = {
  id?: string;
  project_id: string;
  environment_id: string;
  name?: string;
  provider?: string;
  deployment_mode?: "manual" | "azure" | "git";
  auto_deploy?: boolean;
  azure_subscription_id?: string;
  azure_tenant_id?: string;
  azure_client_id?: string;
  azure_client_secret?: string;
  azure_resource_group?: string;
  azure_location?: string;
  acr_name?: string;
  acr_login_server?: string;
  acr_username?: string;
  acr_password?: string;
  container_app_environment?: string;
  container_app_name_prefix?: string;
  azure_container_app_name?: string;
  azure_container_app_url?: string;
  azure_container_config_hash?: string;
  azure_container_created_at?: string;
  azure_managed_environment_created_at?: string;
  azure_provisioning_status?: "running" | "success" | "failed" | "deleted" | string;
  azure_provisioning_step?: string;
  azure_provisioning_percent?: number;
  azure_provisioning_error?: string;
  azure_provisioning_steps?: ProvisioningStep[];
  memory_budget_mb?: number;
  git_repo_url?: string;
  git_branch?: string;
  git_workflow_path?: string;
  git_token?: string;
};

const slugify = (value?: string) =>
  String(value || "item")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "item";

function azureDefaults(project?: Project, env?: Environment) {
  const base = `${slugify(project?.slug || project?.name || "project")}-${slugify(env?.slug || env?.name || "env")}`;
  return {
    name: `${env?.slug || "env"} Container Apps`,
    container_app_name_prefix: base,
    container_app_environment: base,
  };
}

function provisioningSignature(target?: Target | null) {
  if (!target) return "";
  return JSON.stringify({
    subscription: target.azure_subscription_id || "",
    resourceGroup: target.azure_resource_group || "",
    location: target.azure_location || "",
    managedEnvironment: target.container_app_environment || "",
    appName: slugify(target.container_app_name_prefix || target.container_app_environment || "fpm").slice(0, 32).replace(/-$/, ""),
  });
}

function isAzureConnectivityMessage(message = "") {
  return /certificado tls|NODE_EXTRA_CA_CERTS|Azure AD|Azure Resource Manager|conectar con Azure/i.test(message);
}

function stepTone(status?: string) {
  if (status === "success" || status === "deleted") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (status === "failed") return "border-rose-500/30 bg-rose-500/10 text-rose-200";
  if (status === "running") return "border-cyan-500/30 bg-cyan-500/10 text-cyan-200";
  return "border-[var(--border)] bg-black/20 text-slate-400";
}

function stepLabel(status?: string) {
  if (status === "success") return "ok";
  if (status === "failed") return "error";
  if (status === "running") return "en curso";
  if (status === "deleted") return "eliminado";
  return "pendiente";
}

function applyDerivedNames(item: Target, defaults: ReturnType<typeof azureDefaults>, env?: Environment): Target {
  const legacyPrefix = env?.slug ? `fpm-${env.slug}` : "";
  return {
    ...item,
    name: item.name || defaults.name,
    container_app_name_prefix: (!item.container_app_name_prefix || item.container_app_name_prefix === legacyPrefix)
      ? defaults.container_app_name_prefix
      : item.container_app_name_prefix,
    container_app_environment: (!item.container_app_environment || item.container_app_environment === env?.slug)
      ? defaults.container_app_environment
      : item.container_app_environment,
  };
}

const blankTarget = (projectId: string, environmentId: string, project?: Project, env?: Environment): Target => ({
  project_id: projectId,
  environment_id: environmentId,
  name: azureDefaults(project, env).name,
  provider: "azure",
  deployment_mode: "manual",
  auto_deploy: false,
  azure_subscription_id: "",
  azure_tenant_id: "",
  azure_client_id: "",
  azure_client_secret: "",
  azure_resource_group: "",
  azure_location: "",
  acr_name: "",
  acr_login_server: "",
  acr_username: "",
  acr_password: "",
  container_app_environment: azureDefaults(project, env).container_app_environment,
  container_app_name_prefix: azureDefaults(project, env).container_app_name_prefix,
  memory_budget_mb: 0,
  git_repo_url: "",
  git_branch: "main",
  git_workflow_path: ".github/workflows/deploy-container-app.yml",
  git_token: "",
});

export default function ContainerAppsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [allEnvironments, setAllEnvironments] = useState<Environment[]>([]);
  const [targets, setTargets] = useState<Record<string, Target>>({});
  const [selectedEnvId, setSelectedEnvId] = useState("");
  const [propagateProjectId, setPropagateProjectId] = useState("");
  const [propagateEnvId, setPropagateEnvId] = useState("");
  const [saving, setSaving] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api<Project[]>("/api/projects")
      .then((items) => {
        setProjects(items || []);
        if (items?.[0]) setProjectId(items[0].id);
        if (items?.[0]) setPropagateProjectId(items[0].id);
      })
      .catch(() => {});
    api<Environment[]>("/api/environments")
      .then((items) => setAllEnvironments(items || []))
      .catch(() => {});
  }, []);

  async function loadProject(id: string) {
    if (!id) return;
    const [envs, savedTargets] = await Promise.all([
      api<Environment[]>(`/api/environments?project_id=${id}`),
      api<Target[]>(`/api/deployment-targets?project_id=${id}`),
    ]);
    setEnvironments(envs || []);
    setSelectedEnvId((current) => current || envs?.[0]?.id || "");
    const map: Record<string, Target> = {};
    const project = projects.find((item) => item.id === id);
    for (const env of envs || []) {
      const defaults = azureDefaults(project, env);
      const blank = blankTarget(id, env.id, project, env);
      const saved = savedTargets.find((target) => target.environment_id === env.id);
      map[env.id] = saved ? applyDerivedNames({ ...blank, ...saved }, defaults, env) : blank;
    }
    setTargets(map);
  }

  useEffect(() => { loadProject(projectId).catch(() => {}); }, [projectId, projects]);

  const selectedEnv = useMemo(() => environments.find((env) => env.id === selectedEnvId), [environments, selectedEnvId]);
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projects, projectId]);
  const target = selectedEnvId ? targets[selectedEnvId] : null;
  const currentDefaults = azureDefaults(selectedProject, selectedEnv);
  const otherEnvironments = environments.filter((env) => env.id !== selectedEnvId);
  const propagateEnvironments = allEnvironments.filter((env) => env.project_id === propagateProjectId && env.id !== selectedEnvId);
  const propagateProject = projects.find((project) => project.id === propagateProjectId);
  const currentProvisioningSignature = provisioningSignature(target);
  const azureContainerReady = Boolean(target?.azure_container_app_url && target.azure_container_config_hash === currentProvisioningSignature);
  const provisioningSteps = target?.azure_provisioning_steps || [];
  const provisioningPercent = Math.max(0, Math.min(100, Number(target?.azure_provisioning_percent || (azureContainerReady ? 100 : 0))));
  const provisioningFailed = target?.azure_provisioning_status === "failed";
  const canDeleteAzureContainer = Boolean(target?.id && (target.azure_container_app_name || target.azure_container_app_url));
  const azureActionBusy = provisioning || deleting;
  const createAzureLabel = provisioning
    ? "Ejecutando..."
    : azureContainerReady
      ? "Container creado"
      : provisioningFailed
        ? "Reintentar"
        : target?.azure_container_app_url
          ? "Actualizar en Azure"
          : "Crear en Azure";

  useEffect(() => {
    if (!propagateProjectId && projects[0]) {
      setPropagateProjectId(projects[0].id);
      return;
    }
    const envs = allEnvironments.filter((env) => env.project_id === propagateProjectId && env.id !== selectedEnvId);
    setPropagateEnvId((current) => envs.some((env) => env.id === current) ? current : envs[0]?.id || "");
  }, [allEnvironments, projects, propagateProjectId, selectedEnvId]);

  function updateTarget(patch: Partial<Target>) {
    if (!selectedEnvId || !target) return;
    setTargets((current) => ({
      ...current,
      [selectedEnvId]: { ...target, ...patch },
    }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setSaving(true);
    setMessage("");
    try {
      const saved = await api<Target>("/api/deployment-targets", {
        method: "POST",
        body: JSON.stringify(withDefaults(target)),
      });
      setTargets((current) => ({ ...current, [saved.environment_id]: saved }));
      setMessage("Configuración guardada");
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  function withDefaults(item: Target, env = selectedEnv): Target {
    const defaults = azureDefaults(selectedProject, env);
    return applyDerivedNames(item, defaults, env);
  }

  async function propagate(targetEnvIds: string[]) {
    if (!target || !projectId || !selectedEnvId || targetEnvIds.length === 0) return;
    setSaving(true);
    setMessage("");
    try {
      const saved = await api<Target>("/api/deployment-targets", {
        method: "POST",
        body: JSON.stringify(withDefaults(target)),
      });
      const propagated = await api<Target[]>("/api/deployment-targets/propagate", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          source_environment_id: saved.environment_id,
          target_environment_ids: targetEnvIds,
        }),
      });
      setTargets((current) => {
        const next = { ...current, [saved.environment_id]: saved };
        for (const item of propagated) next[item.environment_id] = item;
        return next;
      });
      setMessage(`Configuracion propagada a ${propagated.length} ambiente(s)`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function propagateToProjectEnvironment() {
    if (!target || !projectId || !selectedEnvId || !propagateProjectId || !propagateEnvId) return;
    setSaving(true);
    setMessage("");
    try {
      const saved = await api<Target>("/api/deployment-targets", {
        method: "POST",
        body: JSON.stringify(withDefaults(target)),
      });
      setTargets((current) => ({ ...current, [saved.environment_id]: saved }));
      const propagated = await api<Target[]>("/api/deployment-targets/propagate", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          source_environment_id: saved.environment_id,
          target_destinations: [{ project_id: propagateProjectId, environment_id: propagateEnvId }],
        }),
      });
      if (propagateProjectId === projectId) {
        setTargets((current) => {
          const next = { ...current, [saved.environment_id]: saved };
          for (const item of propagated) next[item.environment_id] = item;
          return next;
        });
      }
      const env = allEnvironments.find((item) => item.id === propagateEnvId);
      const projectName = propagateProject?.name || env?.project_name || "proyecto destino";
      setMessage(`Configuracion propagada a ${projectName} / ${env?.name || "ambiente destino"}. Crea el Container App en Azure para generar su URL.`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function createAzureContainer() {
    if (!target || !selectedEnvId || provisioning || deleting || azureContainerReady) return;
    setProvisioning(true);
    setMessage("");
    let pollTimer: number | undefined;
    try {
      const saved = await api<Target>("/api/deployment-targets", {
        method: "POST",
        body: JSON.stringify(withDefaults({ ...target, deployment_mode: "azure" })),
      });
      setTargets((current) => ({
        ...current,
        [saved.environment_id]: {
          ...saved,
          azure_provisioning_status: "running",
          azure_provisioning_step: "validate",
          azure_provisioning_percent: 0,
          azure_provisioning_error: "",
          azure_provisioning_steps: [],
        },
      }));
      pollTimer = window.setInterval(() => {
        loadProject(projectId).catch(() => {});
      }, 1200);
      const result = await api<{ url?: string | null; message?: string; target: Target }>(`/api/deployment-targets/${saved.id}/create-container`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setTargets((current) => ({ ...current, [result.target.environment_id]: result.target }));
      setMessage(result.message || (result.url ? `Container creado: ${result.url}` : "Container creado en Azure"));
    } catch (error: any) {
      const raw = error.message || "No se pudo crear el Container App en Azure";
      setMessage(isAzureConnectivityMessage(raw)
        ? raw
        : `Azure no pudo crear el Container App con la configuracion actual. ${raw}`);
    } finally {
      if (pollTimer) window.clearInterval(pollTimer);
      await loadProject(projectId).catch(() => {});
      setProvisioning(false);
    }
  }

  async function deleteAzureContainer() {
    if (!target?.id || deleting || provisioning || !canDeleteAzureContainer) return;
    const name = target.azure_container_app_name || target.container_app_name_prefix || "Container App";
    if (!window.confirm(`Eliminar ${name} de Azure?`)) return;
    setDeleting(true);
    setMessage("");
    let pollTimer: number | undefined;
    try {
      setTargets((current) => ({
        ...current,
        [target.environment_id]: {
          ...target,
          azure_provisioning_status: "running",
          azure_provisioning_step: "delete-container-app",
          azure_provisioning_percent: 35,
          azure_provisioning_error: "",
          azure_provisioning_steps: [
            { id: "delete-container-app", label: "Eliminar Container App base", percent: 70, status: "running", message: `Eliminando ${name}` },
          ],
        },
      }));
      pollTimer = window.setInterval(() => {
        loadProject(projectId).catch(() => {});
      }, 1200);
      const result = await api<{ message?: string; target: Target }>(`/api/deployment-targets/${target.id}/container`, {
        method: "DELETE",
      });
      setTargets((current) => ({ ...current, [result.target.environment_id]: result.target }));
      setMessage(result.message || "Container App eliminado de Azure");
    } catch (error: any) {
      const raw = error.message || "No se pudo eliminar el Container App en Azure";
      setMessage(`Azure no pudo eliminar el Container App. ${raw}`);
    } finally {
      if (pollTimer) window.clearInterval(pollTimer);
      await loadProject(projectId).catch(() => {});
      setDeleting(false);
    }
  }

  return (
    <div>
      <Topbar title="Container Apps" subtitle="Configura el destino Azure o Git por ambiente del proyecto" />

      <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-5">
        <div className="card space-y-4">
          <div>
            <label className="text-xs text-slate-400">Proyecto</label>
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setSelectedEnvId(""); }} className="input mt-1">
              <option value="">Selecciona proyecto</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>

          <div className="space-y-2">
            <div className="text-xs text-slate-400">Ambientes</div>
            {environments.map((env) => {
              const current = targets[env.id];
              const active = env.id === selectedEnvId;
              return (
                <button key={env.id} onClick={() => setSelectedEnvId(env.id)}
                  className={`w-full text-left rounded-lg border p-3 transition ${active ? "border-violet-500 bg-violet-500/10" : "border-[var(--border)] bg-[var(--panel-2)] hover:border-violet-500/40"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{env.name}</span>
                    <span className="chip uppercase" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{env.slug}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-2">
                    {current?.deployment_mode === "azure" ? "Azure Container Apps" : current?.deployment_mode === "git" ? "Git workflow" : "Manual/local"}
                  </div>
                </button>
              );
            })}
            {environments.length === 0 && <div className="text-sm text-slate-500">Crea un proyecto para configurar targets.</div>}
          </div>
        </div>

        <form onSubmit={save} className="card space-y-5">
          {!target && <div className="text-slate-500">Selecciona un ambiente.</div>}
          {target && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-cyan-500/15 text-cyan-300 grid place-items-center">
                    {target.deployment_mode === "git" ? <GitBranch className="w-5 h-5" /> : <Cloud className="w-5 h-5" />}
                  </div>
                  <div>
                    <h3 className="font-semibold">{selectedEnv?.name}</h3>
                    <p className="text-xs text-slate-500">Esta configuración se usa al hacer deploy de funciones en este ambiente.</p>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" checked={Boolean(target.auto_deploy)} onChange={(e) => updateTarget({ auto_deploy: e.target.checked })} />
                  Deploy automático
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-slate-400">Nombre</label>
                  <input value={target.name || ""} onChange={(e) => updateTarget({ name: e.target.value })} className="input mt-1" />
                </div>
                <div>
                  <label className="text-xs text-slate-400">Modo</label>
                  <select
                    value={target.deployment_mode || "manual"}
                    onChange={(e) => {
                      const mode = e.target.value as Target["deployment_mode"];
                      updateTarget({
                        deployment_mode: mode,
                        ...(mode === "azure" ? {
                          container_app_name_prefix: target.container_app_name_prefix || currentDefaults.container_app_name_prefix,
                          container_app_environment: target.container_app_environment || currentDefaults.container_app_environment,
                        } : {}),
                      });
                    }}
                    className="input mt-1"
                  >
                    <option value="manual">Manual/local</option>
                    <option value="azure">Azure automático</option>
                    <option value="git">Git workflow</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Prefijo Container App</label>
                  <input value={target.container_app_name_prefix || ""} onChange={(e) => updateTarget({ container_app_name_prefix: e.target.value })} className="input mt-1" placeholder="fpm-dev" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                <button type="button" onClick={() => updateTarget(currentDefaults)} className="text-violet-300 hover:underline">
                  Usar nombres proyecto-ambiente
                </button>
                <span>Prefijo: <span className="font-mono text-slate-300">{currentDefaults.container_app_name_prefix}</span></span>
                <span>Environment: <span className="font-mono text-slate-300">{currentDefaults.container_app_environment}</span></span>
              </div>

              {(target.deployment_mode === "azure" || target.deployment_mode === "manual") && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold"><Server className="w-4 h-4 text-cyan-300" /> Azure Container Apps</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <input className="input" placeholder="Subscription ID" value={target.azure_subscription_id || ""} onChange={(e) => updateTarget({ azure_subscription_id: e.target.value })} />
                    <input className="input" placeholder="Tenant ID" value={target.azure_tenant_id || ""} onChange={(e) => updateTarget({ azure_tenant_id: e.target.value })} />
                    <input className="input" placeholder="Client ID service principal" value={target.azure_client_id || ""} onChange={(e) => updateTarget({ azure_client_id: e.target.value })} />
                    <input className="input" placeholder="Client Secret" type="password" value={target.azure_client_secret || ""} onChange={(e) => updateTarget({ azure_client_secret: e.target.value })} />
                    <input className="input" placeholder="Resource Group" value={target.azure_resource_group || ""} onChange={(e) => updateTarget({ azure_resource_group: e.target.value })} />
                    <input className="input" placeholder="Location, ej: eastus" value={target.azure_location || ""} onChange={(e) => updateTarget({ azure_location: e.target.value })} />
                    <input className="input" placeholder="ACR name" value={target.acr_name || ""} onChange={(e) => updateTarget({ acr_name: e.target.value })} />
                    <input className="input" placeholder="ACR login server, ej: myacr.azurecr.io" value={target.acr_login_server || ""} onChange={(e) => updateTarget({ acr_login_server: e.target.value })} />
                    <input className="input" placeholder="ACR username opcional" value={target.acr_username || ""} onChange={(e) => updateTarget({ acr_username: e.target.value })} />
                    <input className="input" placeholder="ACR password opcional" type="password" value={target.acr_password || ""} onChange={(e) => updateTarget({ acr_password: e.target.value })} />
                    <input className="input md:col-span-2" placeholder="Container Apps Environment name" value={target.container_app_environment || ""} onChange={(e) => updateTarget({ container_app_environment: e.target.value })} />
                    <div className="md:col-span-2">
                      <label className="text-xs text-slate-400">Presupuesto memoria ambiente MB</label>
                      <input
                        type="number"
                        min={0}
                        className="input mt-1"
                        placeholder="0 = sin limite"
                        value={target.memory_budget_mb || 0}
                        onChange={(e) => updateTarget({ memory_budget_mb: Number(e.target.value) })}
                      />
                      <p className="text-xs text-slate-500 mt-1">
                        Define la memoria del Container App del ambiente. Al guardar el umbral desde Entornos se sincroniza este valor con Azure.
                      </p>
                    </div>
                  </div>
                  {target.deployment_mode === "azure" && (
                    <>
                      <div className="rounded-lg border border-[var(--border)] bg-black/20 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold">Container App base</div>
                            <p className="text-xs text-slate-500 mt-1">
                              Crea o valida el Managed Environment, crea el Container App y guarda la URL devuelta por Azure. Si falla, el siguiente intento continua con los recursos ya existentes.
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={saving || azureActionBusy || azureContainerReady}
                              onClick={createAzureContainer}
                              className="btn-primary h-9 text-xs disabled:opacity-50"
                              title={azureContainerReady ? "El Container App ya coincide con la configuracion actual" : "Crear Container App en Azure"}
                            >
                              {provisioning ? <Loader2 className="w-4 h-4 animate-spin" /> : azureContainerReady ? <CheckCircle2 className="w-4 h-4" /> : provisioningFailed ? <AlertTriangle className="w-4 h-4" /> : <Server className="w-4 h-4" />}
                              {createAzureLabel}
                            </button>
                            <button
                              type="button"
                              disabled={saving || azureActionBusy || !canDeleteAzureContainer}
                              onClick={deleteAzureContainer}
                              className="btn-ghost h-9 text-xs disabled:opacity-50"
                              title={canDeleteAzureContainer ? "Eliminar Container App base en Azure" : "No hay Container App creado para eliminar"}
                            >
                              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                              {deleting ? "Eliminando..." : "Eliminar"}
                            </button>
                          </div>
                        </div>
                        {target.azure_container_app_url && (
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                            <span className="chip" style={{ borderColor: azureContainerReady ? "rgba(34,197,94,.35)" : "rgba(245,158,11,.35)", color: azureContainerReady ? "#86efac" : "#fcd34d" }}>
                              {azureContainerReady ? "actual" : "requiere recrear"}
                            </span>
                            <span className="font-mono text-slate-300">{target.azure_container_app_name}</span>
                            <a href={target.azure_container_app_url} target="_blank" className="text-violet-300 hover:underline inline-flex items-center gap-1">
                              <ExternalLink className="w-3.5 h-3.5" /> {target.azure_container_app_url}
                            </a>
                          </div>
                        )}
                        {(provisioningSteps.length > 0 || target.azure_provisioning_status) && (
                          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-xs text-slate-400">
                                Paso actual: <span className="font-mono text-slate-200">{target.azure_provisioning_step || "pendiente"}</span>
                              </div>
                              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${stepTone(target.azure_provisioning_status)}`}>
                                {stepLabel(target.azure_provisioning_status)} - {provisioningPercent}%
                              </span>
                            </div>
                            <div className="h-2 rounded-full bg-slate-900 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${provisioningFailed ? "bg-rose-400" : "bg-cyan-400"}`}
                                style={{ width: `${provisioningPercent}%` }}
                              />
                            </div>
                            {provisioningSteps.length > 0 && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                {provisioningSteps.map((step) => (
                                  <div key={step.id} className={`rounded-md border px-3 py-2 text-xs ${stepTone(step.status)}`}>
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-medium text-slate-100">{step.label}</span>
                                      <span className="font-mono">{step.percent}%</span>
                                    </div>
                                    <div className="mt-1 flex items-start gap-2 text-[11px] opacity-90">
                                      {step.status === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin mt-0.5" />}
                                      {step.status === "success" && <CheckCircle2 className="w-3.5 h-3.5 mt-0.5" />}
                                      {step.status === "failed" && <AlertTriangle className="w-3.5 h-3.5 mt-0.5" />}
                                      <span>{step.message || stepLabel(step.status)}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {target.azure_provisioning_error && (
                          <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200 flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>Fallo en {target.azure_provisioning_step || "Azure"}: {target.azure_provisioning_error}</span>
                          </div>
                        )}
                        {message && (provisioning || isAzureConnectivityMessage(message) || /Container App|Azure/i.test(message)) && (
                          <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${isAzureConnectivityMessage(message) || /^Azure no pudo/i.test(message) ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"}`}>
                            {message}
                          </div>
                        )}
                      </div>

                      <div className="rounded-lg border border-[var(--border)] bg-black/20 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold">Propagar configuracion Azure</div>
                            <p className="text-xs text-slate-500 mt-1">
                              Copia subscription, service principal, resource group, region y ACR. El prefijo y Container Apps Environment se recalculan como proyecto-ambiente.
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={saving || otherEnvironments.length === 0}
                            onClick={() => propagate(otherEnvironments.map((env) => env.id))}
                            className="btn-ghost h-9 text-xs disabled:opacity-50"
                          >
                            <Copy className="w-4 h-4" /> Propagar a todos
                          </button>
                        </div>
                        {otherEnvironments.length > 0 && (
                          <div className="flex flex-wrap gap-2 mt-3">
                            {otherEnvironments.map((env) => (
                              <button
                                key={env.id}
                                type="button"
                                disabled={saving}
                                onClick={() => propagate([env.id])}
                                className="chip hover:border-violet-400 disabled:opacity-50"
                              >
                                {env.name}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="mt-4 border-t border-[var(--border)] pt-4">
                          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2">
                            <div>
                              <label className="text-xs text-slate-400">Proyecto destino</label>
                              <select
                                value={propagateProjectId}
                                onChange={(e) => { setPropagateProjectId(e.target.value); setPropagateEnvId(""); }}
                                className="input mt-1"
                              >
                                {projects.map((project) => (
                                  <option key={project.id} value={project.id}>{project.name}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="text-xs text-slate-400">Ambiente destino</label>
                              <select
                                value={propagateEnvId}
                                onChange={(e) => setPropagateEnvId(e.target.value)}
                                className="input mt-1"
                              >
                                {propagateEnvironments.map((env) => (
                                  <option key={env.id} value={env.id}>{env.name}</option>
                                ))}
                              </select>
                            </div>
                            <button
                              type="button"
                              disabled={saving || !propagateEnvId}
                              onClick={propagateToProjectEnvironment}
                              className="btn-ghost h-10 self-end text-xs disabled:opacity-50"
                              title="Copiar esta configuracion al proyecto y ambiente seleccionados"
                            >
                              <Copy className="w-4 h-4" /> Propagar destino
                            </button>
                          </div>
                          <p className="text-xs text-slate-500 mt-2">
                            Se copian credenciales, resource group, region, ACR, modo y presupuesto. El prefijo y Managed Environment se recalculan para {propagateProject?.name || "el proyecto"}.
                          </p>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {target.deployment_mode === "git" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-semibold"><GitBranch className="w-4 h-4 text-violet-300" /> Git workflow</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <input className="input md:col-span-2" placeholder="GitHub repo URL" value={target.git_repo_url || ""} onChange={(e) => updateTarget({ git_repo_url: e.target.value })} />
                    <input className="input" placeholder="Branch" value={target.git_branch || ""} onChange={(e) => updateTarget({ git_branch: e.target.value })} />
                    <input className="input" placeholder="Workflow path" value={target.git_workflow_path || ""} onChange={(e) => updateTarget({ git_workflow_path: e.target.value })} />
                    <input className="input md:col-span-2" placeholder="GitHub token opcional para workflow_dispatch" type="password" value={target.git_token || ""} onChange={(e) => updateTarget({ git_token: e.target.value })} />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button disabled={saving} className="btn-primary disabled:opacity-50"><Save className="w-4 h-4" /> {saving ? "Guardando..." : "Guardar target"}</button>
                {message && <span className="text-sm text-slate-400">{message}</span>}
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

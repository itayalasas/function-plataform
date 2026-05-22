"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { environmentQuery, useCurrentEnvironment } from "@/lib/environment";
import { Topbar } from "@/components/Topbar";
import { Pagination } from "@/components/Pagination";
import { ArrowRight, Copy, Eye, EyeOff, Filter, KeyRound, Pencil, Plus, Save, Trash2, X } from "lucide-react";

type Secret = {
  id: string;
  key: string;
  value: string;
  project_id?: string;
  environment_id?: string;
  environment_name?: string;
  environment_slug?: string;
  created_at?: string;
  updated_at?: string;
};
type Project = { id: string; name: string; slug: string };
type Environment = { id: string; project_id: string; name: string; slug: string };
type ProjectSecrets = Project & { secrets: Secret[] };

const envOrder = (slug?: string) => ({ dev: 1, test: 2, prod: 3 }[slug || ""] || 9);

export default function SecretsPage() {
  const currentEnv = useCurrentEnvironment();
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [items, setItems] = useState<ProjectSecrets[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [secretVal, setSecretVal] = useState("");
  const [search, setSearch] = useState("");
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [pageByProject, setPageByProject] = useState<Record<string, number>>({});
  const [pageSize, setPageSize] = useState(10);
  const [editingId, setEditingId] = useState("");
  const [editKey, setEditKey] = useState("");
  const [editVal, setEditVal] = useState("");
  const [busyId, setBusyId] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const environmentOptions = useMemo(
    () => environments.filter((env) => !projectId || env.project_id === projectId),
    [environments, projectId]
  );

  async function loadProjects() {
    const rows = await api<Project[]>("/api/projects");
    setProjects(rows || []);
    return rows || [];
  }

  async function loadEnvironments(selectedProjectId = projectId) {
    const query = environmentQuery(currentEnv.slug, {
      project_id: selectedProjectId || undefined,
    });
    const rows = await api<Environment[]>(`/api/environments${query}`).catch(() => []);
    setEnvironments(rows || []);
    setEnvironmentId((rows || [])[0]?.id || "");
    return rows || [];
  }

  async function load(nextProjects = projects) {
    try {
      const selected = projectId ? nextProjects.filter((project) => project.id === projectId) : nextProjects;
      const detailed = await Promise.all(
        selected.map(async (project) => {
          const params = environmentQuery(currentEnv.slug);
          return {
            ...project,
            secrets: await api<Secret[]>(`/api/projects/${project.id}/secrets${params}`).catch(() => []),
          };
        })
      );
      setItems(detailed);
      setErr("");
    } catch (error: any) {
      setErr(error.message);
    }
  }

  useEffect(() => {
    loadProjects()
      .then(async (rows) => {
        await loadEnvironments("");
        await load(rows);
      })
      .catch(() => {});
  }, [currentEnv.slug]);

  useEffect(() => {
    loadEnvironments(projectId).then(() => load()).catch(() => {});
  }, [projectId, currentEnv.slug]);

  useEffect(() => {
    load().catch(() => {});
  }, [environmentId]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const searched = !term ? items : items
      .map((project) => ({
        ...project,
        secrets: project.secrets.filter((secret) =>
          [project.name, project.slug, secret.environment_name, secret.environment_slug, secret.key, secret.value]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(term))
        ),
      }))
      .filter((project) =>
        project.secrets.length > 0 ||
        project.name.toLowerCase().includes(term) ||
        project.slug.toLowerCase().includes(term)
      );

    return searched.map((project) => ({
      ...project,
      secrets: [...project.secrets].sort((a, b) =>
        String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")) ||
        envOrder(a.environment_slug) - envOrder(b.environment_slug) ||
        String(a.key).localeCompare(String(b.key))
      ),
    }));
  }, [items, search]);

  const pagedProjects = useMemo(() => filtered.map((project) => {
    const totalPages = Math.max(1, Math.ceil(project.secrets.length / pageSize));
    const currentPage = Math.min(pageByProject[project.id] || 1, totalPages);
    const start = (currentPage - 1) * pageSize;
    return {
      ...project,
      totalPages,
      currentPage,
      pagedSecrets: project.secrets.slice(start, start + pageSize),
    };
  }), [filtered, pageSize, pageByProject]);

  function showMessage(text: string) {
    setMsg(text);
    setTimeout(() => setMsg(""), 1800);
  }

  async function addSecret() {
    if (!projectId || !environmentId || !secretKey.trim()) return;
    setBusyId("create");
    setErr("");
    try {
      await api(`/api/projects/${projectId}/secrets`, {
        method: "POST",
        body: JSON.stringify({ environment_id: environmentId, key: secretKey, value: secretVal }),
      });
      setSecretKey("");
      setSecretVal("");
      showMessage("Secret creado");
      await load();
    } catch (error: any) {
      setMsg("");
      setErr(error.message);
    } finally {
      setBusyId("");
    }
  }

  function startEdit(secret: Secret) {
    setEditingId(secret.id);
    setEditKey(secret.key);
    setEditVal(secret.value);
  }

  async function saveEdit(secret: Secret) {
    if (!editKey.trim()) return;
    setBusyId(`edit:${secret.id}`);
    setErr("");
    try {
      await api(`/api/secrets/${secret.id}`, {
        method: "PATCH",
        body: JSON.stringify({ key: editKey, value: editVal }),
      });
      setEditingId("");
      showMessage("Secret actualizado");
      await load();
    } catch (error: any) {
      setMsg("");
      setErr(error.message);
    } finally {
      setBusyId("");
    }
  }

  async function delSecret(id: string) {
    setBusyId(`delete:${id}`);
    try {
      await api(`/api/secrets/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusyId("");
    }
  }

  async function copyToNextEnvironment() {
    if (!projectId || !currentEnv.nextSlug) return;
    setBusyId("copy");
    setErr("");
    try {
      const result = await api<{ copied: number; skipped: number }>(`/api/projects/${projectId}/secrets/copy`, {
        method: "POST",
        body: JSON.stringify({ source_environment_slug: currentEnv.slug, target_environment_slug: currentEnv.nextSlug }),
      });
      showMessage(`Copiados ${result.copied}; existentes ${result.skipped}`);
      await load();
    } catch (error: any) {
      setMsg("");
      setErr(error.message);
    } finally {
      setBusyId("");
    }
  }

  function clearFilters() {
    setProjectId("");
    setSearch("");
    setSecretKey("");
    setSecretVal("");
    setEditingId("");
    setPageByProject({});
    setErr("");
  }

  useEffect(() => {
    setPageByProject({});
  }, [projectId, environmentId, search, currentEnv.slug]);

  return (
    <div>
      <Topbar title="Secrets" subtitle={`Variables solo del ambiente ${currentEnv.label}`} />

      {err && <div className="card mb-5 text-rose-300 text-sm">{err}</div>}

      <div className="card mb-5">
        <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_1fr_1fr_1.4fr_auto] gap-3 items-end">
          <div>
            <label className="text-xs text-slate-400">Proyecto</label>
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setEnvironmentId(""); }} className="input mt-1">
              <option value="">Todos los proyectos</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400">Ambiente</label>
            <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} className="input mt-1" disabled>
              <option value="">{currentEnv.label}</option>
              {environmentOptions.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400">Nuevo secret</label>
            <input value={secretKey} onChange={(e) => setSecretKey(e.target.value.toUpperCase())} placeholder="KEY" className="input mt-1 font-mono" disabled={!projectId || !environmentId} />
          </div>
          <div>
            <label className="text-xs text-slate-400">Valor</label>
            <input value={secretVal} onChange={(e) => setSecretVal(e.target.value)} placeholder={environmentId ? "value" : "Selecciona proyecto y ambiente"} className="input mt-1" disabled={!projectId || !environmentId} />
          </div>
          <button onClick={addSecret} disabled={!projectId || !environmentId || !secretKey.trim() || busyId === "create"} className="btn-primary disabled:opacity-50">
            <Plus className="w-4 h-4" /> {busyId === "create" ? "Creando..." : "Crear"}
          </button>
        </div>
        <div className="flex flex-wrap gap-3 mt-3">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar secret, proyecto o ambiente..." className="input flex-1 min-w-[220px]" />
          <button type="button" onClick={copyToNextEnvironment} disabled={!projectId || !currentEnv.nextSlug || busyId === "copy"} className="btn-ghost disabled:opacity-50" title="Copia solo las keys que falten en el siguiente ambiente">
            <Copy className="w-4 h-4" /> {currentEnv.slug.toUpperCase()} <ArrowRight className="w-3.5 h-3.5" /> {(currentEnv.nextSlug || "-").toUpperCase()}
          </button>
          <button type="button" onClick={clearFilters} className="btn-ghost">
            <Filter className="w-4 h-4" /> Limpiar
          </button>
          {msg && <span className="text-xs text-emerald-300 self-center">{msg}</span>}
        </div>
        <p className="text-xs text-slate-500 mt-3">
          No se permite repetir la misma KEY dentro del mismo proyecto y ambiente. Al validar y desplegar una funcion se inyectan solo los secrets de su ambiente.
        </p>
      </div>

      <div className="grid gap-4">
        {pagedProjects.map((project) => (
          <div key={project.id} className="card">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-violet-500/15 text-violet-300 grid place-items-center shrink-0">
                  <KeyRound className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="font-medium truncate">{project.name}</div>
                  <div className="text-xs text-slate-500 font-mono truncate">/{project.slug}</div>
                </div>
              </div>
              <span className="chip" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{project.secrets.length} secrets</span>
            </div>

            {project.secrets.length === 0 ? (
              <div className="text-sm text-slate-500 py-4 text-center border border-dashed border-[var(--border-2)] rounded-lg">Sin secrets para este filtro</div>
            ) : (
              <div className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
                {project.pagedSecrets.map((secret) => {
                  const editing = editingId === secret.id;
                  return (
                    <div key={secret.id} className="p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 text-sm">
                      <div className="flex flex-wrap items-center gap-3 min-w-0 flex-1">
                        <span className="chip uppercase" style={{ borderColor: "rgba(34,211,238,.35)", color: "#67e8f9", background: "rgba(34,211,238,.08)" }}>
                          {secret.environment_slug || "env"}
                        </span>
                        {editing ? (
                          <>
                            <input value={editKey} onChange={(e) => setEditKey(e.target.value.toUpperCase())} className="input h-9 font-mono md:w-64" />
                            <input value={editVal} onChange={(e) => setEditVal(e.target.value)} className="input h-9 min-w-[220px] flex-1" />
                          </>
                        ) : (
                          <>
                            <span className="font-mono text-violet-300 shrink-0">{secret.key}</span>
                            <span className={`font-mono truncate ${reveal[secret.id] ? "text-slate-200" : "text-slate-500"}`}>
                              {reveal[secret.id] ? secret.value : "********"}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {editing ? (
                          <>
                            <button onClick={() => saveEdit(secret)} disabled={busyId === `edit:${secret.id}`} className="p-1.5 rounded text-emerald-300 hover:bg-emerald-500/10">
                              <Save className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setEditingId("")} className="p-1.5 rounded text-slate-400 hover:text-white">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => setReveal((current) => ({ ...current, [secret.id]: !current[secret.id] }))} className="p-1.5 rounded text-slate-400 hover:text-white">
                              {reveal[secret.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                            <button onClick={() => startEdit(secret)} className="p-1.5 rounded text-cyan-300 hover:bg-cyan-500/10">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => delSecret(secret.id)} disabled={busyId === `delete:${secret.id}`} className="p-1.5 rounded text-rose-400 hover:bg-rose-500/10 disabled:opacity-50">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {project.secrets.length > 0 && (
              <Pagination
                page={project.currentPage}
                totalPages={project.totalPages}
                totalItems={project.secrets.length}
                pageSize={pageSize}
                onPageChange={(nextPage) => setPageByProject((current) => ({ ...current, [project.id]: nextPage }))}
                onPageSizeChange={(next) => {
                  setPageSize(next);
                  setPageByProject({});
                }}
              />
            )}
          </div>
        ))}
        {pagedProjects.length === 0 && <div className="card text-center text-slate-500">No hay secrets para los filtros seleccionados.</div>}
      </div>
    </div>
  );
}

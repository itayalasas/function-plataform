"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { buildCurlCommand, copyText } from "@/lib/curl";
import { environmentQuery, useCurrentEnvironment } from "@/lib/environment";
import { Topbar } from "@/components/Topbar";
import { Pagination } from "@/components/Pagination";
import { StatusBadge } from "@/components/StatusBadge";
import { BrainCircuit, Check, Copy, ExternalLink, Filter, Rocket } from "lucide-react";

type Project = { id: string; name: string; slug: string };
type Environment = { id: string; name: string; slug: string };
type Deployment = {
  id: string;
  function_id: string;
  function_name?: string;
  function_slug?: string;
  project_name?: string;
  environment_name?: string;
  environment_slug?: string;
  version: string;
  status: string;
  active?: boolean;
  url?: string;
  validation_status?: string;
  validation_summary?: string;
  error?: string;
  deprecated_at?: string | null;
  deprecated_reason?: string | null;
  change_summary?: string | null;
  change_details?: { label?: string; message?: string; before?: string | null; after?: string | null }[];
  source_deployment_id?: string | null;
  snapshot?: { function?: Record<string, any>; meta?: Record<string, any> } | null;
  created_at: string;
  finished_at?: string;
};
type Fn = {
  id: string;
  url?: string;
  auth_required?: boolean;
  auth_header_name?: string;
  api_tokens?: { id: string; name: string; value: string }[];
};

export default function DeploymentsPage() {
  const currentEnv = useCurrentEnvironment();
  const [items, setItems] = useState<Deployment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [err, setErr] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState("");

  async function loadProjects() {
    setProjects(await api<Project[]>("/api/projects"));
  }

  async function loadEnvironments(nextProjectId = projectId) {
    const rows = await api<Environment[]>(`/api/environments${environmentQuery(currentEnv.slug, {
      project_id: nextProjectId || undefined,
    })}`);
    setEnvironments(rows);
    setEnvironmentId("current");
  }

  async function load() {
    try {
      setItems(await api<Deployment[]>(`/api/deployments${environmentQuery(currentEnv.slug, {
        project_id: projectId || undefined,
      })}`));
      setErr(null);
    } catch (error: any) {
      setErr(error.message);
    }
  }

  useEffect(() => { loadProjects().catch(() => {}); }, []);
  useEffect(() => { loadEnvironments(projectId).catch(() => {}); }, [projectId, currentEnv.slug]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [projectId, currentEnv.slug]);

  const filtered = useMemo(() => {
    return [...items]
      .sort((a, b) =>
        String(b.created_at || b.finished_at || "").localeCompare(String(a.created_at || a.finished_at || "")) ||
        String(b.version || "").localeCompare(String(a.version || ""))
      )
      .filter((deployment) =>
        status === "all" ||
        (status === "active" && deployment.active) ||
        (status === "deprecated" && deployment.status === "success" && !deployment.active) ||
        deployment.status === status ||
        deployment.validation_status === status
      );
  }, [items, status]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [projectId, environmentId, status, currentEnv.slug]);

  async function copyCurl(deployment: Deployment) {
    if (!deployment.url) return;
    try {
      const fn = await api<Fn>(`/api/functions/${deployment.function_id}`);
      await copyText(buildCurlCommand(fn, deployment.url));
      setCopiedId(deployment.id);
      setTimeout(() => setCopiedId((current) => current === deployment.id ? "" : current), 1800);
    } catch (error: any) {
      setErr(error.message || "No se pudo copiar el cURL");
    }
  }

  return (
    <div>
      <Topbar title="Deployments" subtitle={`Historial del ambiente ${currentEnv.label}`} />

      {err && <div className="card mb-5 text-rose-300 text-sm">No se pudieron cargar deployments: {err}</div>}

      <div className="card mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <label className="text-xs text-slate-400">Proyecto</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input mt-1">
              <option value="">Todos los proyectos</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>
          <div className="min-w-[180px] flex-1">
            <label className="text-xs text-slate-400">Ambiente</label>
            <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} className="input mt-1" disabled>
              <option value="current">Ambiente {currentEnv.slug.toUpperCase()}</option>
              {environments.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
            </select>
          </div>
          <div className="min-w-[180px] flex-1">
            <label className="text-xs text-slate-400">Estado</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="input mt-1">
              <option value="all">Todos</option>
              <option value="active">Activo</option>
              <option value="deprecated">Deprecado</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
              <option value="warning">Warning</option>
              <option value="passed">Passed</option>
              <option value="deploying">Deploying</option>
              <option value="queued">Queued</option>
            </select>
          </div>
          <button type="button" onClick={() => { setProjectId(""); setStatus("all"); }} className="btn-ghost">
            <Filter className="w-4 h-4" /> Limpiar
          </button>
        </div>
      </div>

      <div className="card">
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--panel-2)] text-xs uppercase text-slate-500">
              <tr>
                <th className="text-left px-4 py-3">Version</th>
                <th className="text-left px-4 py-3">Uso</th>
                <th className="text-left px-4 py-3">Funcion</th>
                <th className="text-left px-4 py-3">Proyecto</th>
                <th className="text-left px-4 py-3">Ambiente</th>
                <th className="text-left px-4 py-3">Validacion</th>
                <th className="text-left px-4 py-3">Estado</th>
                <th className="text-left px-4 py-3">Cuando</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={9} className="text-center text-slate-500 py-12">Sin deployments para los filtros seleccionados.</td></tr>}
              {visible.map((deployment) => (
                <tr key={deployment.id} className="border-t border-[var(--border)] hover:bg-white/[.02] align-top">
                  <td className="px-4 py-3 font-mono text-xs">{deployment.version}</td>
                  <td className="px-4 py-3">
                    {deployment.status === "success" ? (
                      <StatusBadge status={deployment.active ? "active" : "deprecated"} />
                    ) : (
                      <span className="text-slate-600">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/functions/${deployment.function_id}`} className="flex items-center gap-2 hover:text-violet-300">
                      <div className="w-7 h-7 rounded-md bg-violet-500/15 text-violet-300 grid place-items-center"><Rocket className="w-3.5 h-3.5" /></div>
                      <div>
                        <span>{deployment.function_name || deployment.function_slug || deployment.function_id}</span>
                        {deployment.change_summary && (
                          <div className="text-xs text-slate-500 mt-1 max-w-md">{deployment.change_summary}</div>
                        )}
                      </div>
                    </Link>
                    {deployment.error && <div className="text-xs text-rose-300 mt-1 max-w-md">{deployment.error}</div>}
                    {deployment.status === "success" && !deployment.active && (
                      <div className="text-xs text-slate-500 mt-1 max-w-md">{deployment.deprecated_reason || "Version disponible solo para trafico existente."}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{deployment.project_name || "-"}</td>
                  <td className="px-4 py-3">
                    <span className="chip uppercase" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{deployment.environment_slug || "-"}</span>
                  </td>
                  <td className="px-4 py-3">
                    {deployment.validation_status ? (
                      <div className="space-y-1">
                        <StatusBadge status={deployment.validation_status} />
                        <div className="text-xs text-slate-500 max-w-xs">{deployment.validation_summary}</div>
                      </div>
                    ) : (
                      <span className="text-slate-600">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={deployment.status} /></td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{new Date(deployment.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    {deployment.url && deployment.active ? (
                      <div className="flex items-center justify-end gap-3">
                        <button type="button" onClick={() => copyCurl(deployment)} className="text-cyan-300 hover:underline inline-flex items-center gap-1 text-xs" title="Copiar cURL">
                          {copiedId === deployment.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          {copiedId === deployment.id ? "Copiado" : "cURL"}
                        </button>
                        <a href={deployment.url} target="_blank" className="text-violet-300 hover:underline inline-flex items-center gap-1 text-xs">
                          <ExternalLink className="w-3.5 h-3.5" /> Abrir
                        </a>
                      </div>
                    ) : deployment.url ? (
                      <div className="flex items-center justify-end gap-2 text-xs text-slate-500">
                        <span>Deprecado</span>
                      </div>
                    ) : (
                      <BrainCircuit className="w-4 h-4 text-slate-600 ml-auto" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          page={currentPage}
          totalPages={totalPages}
          totalItems={filtered.length}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
        />
      </div>
    </div>
  );
}

"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { buildCurlCommand, copyText } from "@/lib/curl";
import { environmentQuery, useCurrentEnvironment } from "@/lib/environment";
import { Topbar } from "@/components/Topbar";
import { Pagination } from "@/components/Pagination";
import { StatusBadge } from "@/components/StatusBadge";
import { Check, Copy, Plus, Search, Terminal } from "lucide-react";

type Fn = {
  id: string;
  slug: string;
  name: string;
  status: string;
  updated_at: string;
  url?: string;
  active_deploy_version?: string;
  project_id?: string;
  project_name?: string;
  environment_slug?: string;
  validation_status?: string;
  auth_required?: boolean;
  auth_header_name?: string;
  api_tokens?: { id: string; name: string; value: string }[];
};
type Project = { id: string; name: string; slug: string };
type Environment = { id: string; name: string; slug: string; project_id?: string; project_name?: string };

export default function FunctionsPage() {
  const currentEnv = useCurrentEnvironment();
  const [items, setItems] = useState<Fn[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [projectId, setProjectId] = useState("all");
  const [environmentId, setEnvironmentId] = useState("all");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [err, setErr] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState("");

  async function load() {
    try {
      const query = environmentQuery(currentEnv.slug, {
        project_id: projectId !== "all" ? projectId : undefined,
      });
      setItems(await api<Fn[]>(`/api/functions${query}`));
      setErr(null);
    } catch (error: any) {
      setErr(error.message);
    }
  }

  useEffect(() => { api<Project[]>("/api/projects").then(setProjects).catch(() => {}); }, []);
  useEffect(() => {
    const query = environmentQuery(currentEnv.slug, {
      project_id: projectId !== "all" ? projectId : undefined,
    });
    api<Environment[]>(`/api/environments${query}`).then((items) => {
      setEnvironments(items);
      setEnvironmentId("current");
    }).catch(() => {});
  }, [projectId, currentEnv.slug]);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [projectId, currentEnv.slug]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return [...items]
      .sort((a, b) =>
        String(b.updated_at || "").localeCompare(String(a.updated_at || "")) ||
        a.name.localeCompare(b.name)
      )
      .filter((fn) =>
        (filter === "all" || fn.status === filter) &&
        (!term || fn.name.toLowerCase().includes(term) || fn.slug.toLowerCase().includes(term))
      );
  }, [items, filter, q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [projectId, environmentId, filter, q, currentEnv.slug]);

  async function copyCurl(fn: Fn) {
    if (!fn.url) return;
    try {
      const fullFn = await api<Fn>(`/api/functions/${fn.id}`);
      await copyText(buildCurlCommand(fullFn, fn.url));
      setCopiedId(fn.id);
      setTimeout(() => setCopiedId((current) => current === fn.id ? "" : current), 1800);
    } catch (error: any) {
      setErr(error.message || "No se pudo copiar el cURL");
    }
  }

  return (
    <div>
      <Topbar title="Funciones" subtitle={`Funciones visibles solo en ${currentEnv.label}`}
        actions={<Link href="/new" className="btn-primary"><Plus className="w-4 h-4" /> Nueva funcion</Link>} />

      {err && <div className="card mb-5 text-rose-300 text-sm">No se pudo conectar con el API: {err}</div>}

      <div className="card">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--panel-2)] border border-[var(--border)] flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar funciones..." className="bg-transparent outline-none text-sm flex-1" />
          </div>
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setEnvironmentId("all"); }} className="input w-56">
            <option value="all">Todos los proyectos</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} className="input w-56" disabled>
            <option value="current">Ambiente {currentEnv.slug.toUpperCase()}</option>
            {environments.map((env) => (
              <option key={env.id} value={env.id}>
                {projectId === "all" && env.project_name ? `${env.project_name} / ${env.name}` : env.name}
              </option>
            ))}
          </select>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="input w-44">
            <option value="all">Todos los estados</option>
            <option value="running">Running</option>
            <option value="idle">Idle</option>
            <option value="stopped">Stopped</option>
            <option value="error">Error</option>
          </select>
        </div>

        <div className="overflow-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-[var(--panel-2)] text-xs uppercase text-slate-500">
              <tr>
                <th className="text-left px-4 py-3">Nombre</th>
                <th className="text-left px-4 py-3">Proyecto</th>
                <th className="text-left px-4 py-3">Entorno</th>
                <th className="text-left px-4 py-3">Estado</th>
                <th className="text-left px-4 py-3">Validacion</th>
                <th className="text-left px-4 py-3">URL</th>
                <th className="text-left px-4 py-3">Actualizado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="text-center text-slate-500 py-12">Sin resultados</td></tr>
              )}
              {visible.map((fn) => (
                <tr key={fn.id} className="border-t border-[var(--border)] hover:bg-white/[.02]">
                  <td className="px-4 py-3">
                    <div className="font-medium">{fn.name}</div>
                    <div className="text-xs text-slate-500 font-mono">/{fn.slug}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{fn.project_name || "-"}</td>
                  <td className="px-4 py-3">
                    <span className="chip uppercase" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{fn.environment_slug || "-"}</span>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={fn.status} /></td>
                  <td className="px-4 py-3">{fn.validation_status ? <StatusBadge status={fn.validation_status} /> : <span className="text-slate-600">-</span>}</td>
                  <td className="px-4 py-3 text-violet-300 font-mono text-xs">
                    {fn.url ? (
                      <a href={fn.url} target="_blank">
                        {fn.url}
                      </a>
                    ) : (
                      <span className="text-slate-600">/{fn.active_deploy_version || "v1"}/{fn.slug}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{new Date(fn.updated_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      {fn.url && (
                        <button type="button" onClick={() => copyCurl(fn)} className="text-cyan-300 hover:underline text-xs inline-flex items-center gap-1" title="Copiar cURL">
                          {copiedId === fn.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          {copiedId === fn.id ? "Copiado" : "cURL"}
                        </button>
                      )}
                      <Link href={`/functions/${fn.id}?tab=logs`} className="text-cyan-300 hover:underline text-xs inline-flex items-center gap-1">
                        <Terminal className="w-3.5 h-3.5" /> Logs
                      </Link>
                      <Link href={`/functions/${fn.id}`} className="text-violet-300 hover:underline text-xs">Abrir</Link>
                    </div>
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

"use client";
import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Topbar } from "@/components/Topbar";
import { FolderKanban, Plus, Server, Boxes } from "lucide-react";

type Environment = { id: string; name: string; slug: string; function_count?: number };
type Project = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  function_count?: number;
  environments?: Environment[];
  functions?: any[];
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const items = await api<Project[]>("/api/projects");
    const detailed = await Promise.all(items.map((project) => api<Project>(`/api/projects/${project.id}`).catch(() => project)));
    setProjects(detailed);
  }

  useEffect(() => { load().catch(() => {}); }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, description }),
      });
      setName("");
      setDescription("");
      await load();
    } catch (error: any) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Topbar title="Proyectos" subtitle="Agrupa funciones, secrets, deployments y entornos por producto" />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <form onSubmit={create} className="card xl:col-span-1 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-violet-500/15 text-violet-300 grid place-items-center">
              <FolderKanban className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold">Nuevo proyecto</h3>
              <p className="text-xs text-slate-500">Se crearán entornos dev, test y prod.</p>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400">Nombre</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input mt-1" placeholder="Payments Platform" />
          </div>
          <div>
            <label className="text-xs text-slate-400">Descripción</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} className="input mt-1" rows={4} placeholder="Servicios y automatizaciones del proyecto" />
          </div>
          {err && <div className="text-sm text-rose-300">{err}</div>}
          <button disabled={busy || !name.trim()} className="btn-primary disabled:opacity-50">
            <Plus className="w-4 h-4" /> {busy ? "Creando..." : "Crear proyecto"}
          </button>
        </form>

        <div className="xl:col-span-2 space-y-4">
          {projects.length === 0 && (
            <div className="card text-center text-slate-500 py-12">Todavía no hay proyectos.</div>
          )}
          {projects.map((project) => (
            <div key={project.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-violet-500/15 text-violet-300 grid place-items-center">
                    <FolderKanban className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold">{project.name}</h3>
                    <div className="text-xs text-slate-500 font-mono">/{project.slug}</div>
                    {project.description && <p className="text-sm text-slate-400 mt-2">{project.description}</p>}
                  </div>
                </div>
                <Link href={`/new?project_id=${project.id}`} className="btn-primary text-xs">
                  <Plus className="w-4 h-4" /> Nueva función
                </Link>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-5">
                <div className="rounded-lg bg-[var(--panel-2)] border border-[var(--border)] p-3">
                  <div className="flex items-center gap-2 text-slate-400 text-xs">
                    <Boxes className="w-4 h-4" /> Funciones
                  </div>
                  <div className="text-2xl font-semibold mt-2">{project.functions?.length ?? project.function_count ?? 0}</div>
                </div>
                {(project.environments || []).map((env) => (
                  <Link key={env.id} href={`/environments?project_id=${project.id}`} className="rounded-lg bg-[var(--panel-2)] border border-[var(--border)] p-3 hover:border-violet-500/40 transition">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-slate-400 text-xs">
                        <Server className="w-4 h-4" /> {env.name}
                      </div>
                      <span className="chip uppercase" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{env.slug}</span>
                    </div>
                    <div className="text-2xl font-semibold mt-2">{env.function_count ?? project.functions?.filter((fn: any) => fn.environment_id === env.id).length ?? 0}</div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

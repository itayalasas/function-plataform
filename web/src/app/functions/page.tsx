"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Topbar } from "@/components/Topbar";
import { StatusBadge } from "@/components/StatusBadge";
import { Plus, Search } from "lucide-react";

type Fn = { id: string; slug: string; name: string; status: string; updated_at: string; url?: string };

export default function FunctionsPage() {
  const [items, setItems] = useState<Fn[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>("all");

  async function load() { try { setItems(await api<Fn[]>("/api/functions")); } catch {} }
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  const filtered = items.filter(f =>
    (filter === "all" || f.status === filter) &&
    (f.name.toLowerCase().includes(q.toLowerCase()) || f.slug.includes(q.toLowerCase()))
  );

  return (
    <div>
      <Topbar title="Funciones" subtitle="Gestiona todas tus funciones serverless"
        actions={<Link href="/new" className="btn-primary"><Plus className="w-4 h-4" /> Nueva función</Link>} />

      <div className="card">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--panel-2)] border border-[var(--border)] flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-500" />
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Buscar funciones..." className="bg-transparent outline-none text-sm flex-1" />
          </div>
          <select value={filter} onChange={e=>setFilter(e.target.value)} className="input w-44">
            <option value="all">Todos los estados</option>
            <option value="running">Running</option>
            <option value="idle">Idle</option>
            <option value="stopped">Stopped</option>
            <option value="error">Error</option>
          </select>
        </div>

        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--panel-2)] text-xs uppercase text-slate-500">
              <tr>
                <th className="text-left px-4 py-3">Nombre</th>
                <th className="text-left px-4 py-3">Estado</th>
                <th className="text-left px-4 py-3">URL</th>
                <th className="text-left px-4 py-3">Actualizado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="text-center text-slate-500 py-12">Sin resultados</td></tr>
              )}
              {filtered.map(fn => (
                <tr key={fn.id} className="border-t border-[var(--border)] hover:bg-white/[.02]">
                  <td className="px-4 py-3">
                    <div className="font-medium">{fn.name}</div>
                    <div className="text-xs text-slate-500 font-mono">/{fn.slug}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={fn.status} /></td>
                  <td className="px-4 py-3 text-violet-300 font-mono text-xs">
                    {fn.url ? <a href={fn.url} target="_blank">{fn.url}</a> : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{new Date(fn.updated_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/functions/${fn.id}`} className="text-violet-300 hover:underline text-xs">Abrir →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

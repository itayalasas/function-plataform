"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Topbar } from "@/components/Topbar";
import { KeyRound, Plus, Trash2, Eye, EyeOff } from "lucide-react";

type Fn = { id: string; name: string; slug: string; secrets?: { id: string; key: string }[] };

export default function SecretsPage() {
  const [items, setItems] = useState<Fn[]>([]);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  async function load() {
    try {
      const fns = await api<any[]>("/api/functions");
      const detailed = await Promise.all(fns.map(f => api<Fn>(`/api/functions/${f.id}`).catch(() => ({ ...f, secrets: [] }))));
      setItems(detailed);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <Topbar title="Secrets" subtitle="Gestiona variables de entorno seguras por función" />
      <div className="grid gap-4">
        {items.map(fn => (
          <div key={fn.id} className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-violet-500/15 text-violet-300 grid place-items-center">
                  <KeyRound className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-medium">{fn.name}</div>
                  <div className="text-xs text-slate-500 font-mono">/{fn.slug}</div>
                </div>
              </div>
              <a href={`/functions/${fn.id}`} className="btn-ghost text-xs"><Plus className="w-3 h-3" /> Añadir secret</a>
            </div>

            {(!fn.secrets || fn.secrets.length === 0) ? (
              <div className="text-sm text-slate-500 py-4 text-center border border-dashed border-[var(--border-2)] rounded-lg">Sin secrets</div>
            ) : (
              <div className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
                {fn.secrets.map(s => (
                  <div key={s.id} className="p-3 flex items-center justify-between text-sm">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-violet-300">{s.key}</span>
                      <span className="text-slate-500 font-mono">{reveal[s.id] ? "••••••••" : "••••••••"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setReveal(r => ({ ...r, [s.id]: !r[s.id] }))} className="p-1.5 rounded text-slate-400 hover:text-white">
                        {reveal[s.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                      <button className="p-1.5 rounded text-rose-400 hover:bg-rose-500/10"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && <div className="card text-center text-slate-500">Crea una función para añadir secrets.</div>}
      </div>
    </div>
  );
}

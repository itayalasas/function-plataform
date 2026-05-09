"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Topbar } from "@/components/Topbar";
import { StatusBadge } from "@/components/StatusBadge";
import { Rocket } from "lucide-react";

type Fn = { id: string; name: string; slug: string; status: string; updated_at: string };

export default function DeploymentsPage() {
  const [items, setItems] = useState<Fn[]>([]);
  useEffect(() => { api<Fn[]>("/api/functions").then(setItems).catch(() => {}); }, []);

  return (
    <div>
      <Topbar title="Deployments" subtitle="Historial de despliegues" />
      <div className="card">
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--panel-2)] text-xs uppercase text-slate-500">
              <tr>
                <th className="text-left px-4 py-3">Versión</th>
                <th className="text-left px-4 py-3">Función</th>
                <th className="text-left px-4 py-3">Entorno</th>
                <th className="text-left px-4 py-3">Estado</th>
                <th className="text-left px-4 py-3">Cuándo</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={5} className="text-center text-slate-500 py-12">Sin deployments todavía.</td></tr>}
              {items.map((fn, idx) => (
                <tr key={fn.id} className="border-t border-[var(--border)] hover:bg-white/[.02]">
                  <td className="px-4 py-3 font-mono text-xs">v1.{items.length - idx}.0</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-md bg-violet-500/15 text-violet-300 grid place-items-center"><Rocket className="w-3.5 h-3.5" /></div>
                      {fn.name}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-400">Producción</td>
                  <td className="px-4 py-3"><StatusBadge status={fn.status} /></td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{new Date(fn.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

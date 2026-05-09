"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Topbar } from "@/components/Topbar";
import { CheckCircle2 } from "lucide-react";

const TEMPLATE = `export default async function handler(req) {
  const name = new URL(req.url).searchParams.get("name") ?? "world";
  return new Response(JSON.stringify({ hello: name, env: process.env.GREETING ?? null }), {
    headers: { "content-type": "application/json" }
  });
}
`;

function NewFnInner() {
  const r = useRouter();
  const sp = useSearchParams();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [code, setCode] = useState(sp.get("code") || TEMPLATE);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const fn = await api<any>("/api/functions", { method: "POST", body: JSON.stringify({ name, code }) });
      r.push(`/functions/${fn.id}`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  const steps = ["Información", "Código", "Configuración", "Deploy"];

  return (
    <div>
      <Topbar title="Crear Función" subtitle="Sigue los pasos para desplegar una nueva función serverless" />

      <div className="card mb-6">
        <div className="flex items-center justify-between">
          {steps.map((s, i) => {
            const n = i + 1;
            const active = step === n;
            const done = step > n;
            return (
              <div key={s} className="flex items-center flex-1">
                <div className={`w-8 h-8 rounded-full grid place-items-center text-xs font-semibold border ${done ? "bg-emerald-500/20 border-emerald-400 text-emerald-300" : active ? "bg-violet-500/20 border-violet-400 text-violet-200" : "bg-slate-800 border-slate-700 text-slate-500"}`}>
                  {done ? <CheckCircle2 className="w-4 h-4" /> : n}
                </div>
                <div className={`ml-2 text-sm ${active ? "text-white" : "text-slate-500"}`}>{s}</div>
                {i < steps.length - 1 && <div className="flex-1 h-px bg-[var(--border)] mx-3" />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="card lg:col-span-2">
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="font-semibold">Información básica</h3>
              <div>
                <label className="text-xs text-slate-400">Nombre</label>
                <input value={name} onChange={e=>setName(e.target.value)} placeholder="send-email" className="input mt-1" />
              </div>
              <div>
                <label className="text-xs text-slate-400">Descripción</label>
                <textarea value={desc} onChange={e=>setDesc(e.target.value)} rows={3} placeholder="Mi función increíble" className="input mt-1" />
              </div>
              <div>
                <label className="text-xs text-slate-400">Runtime</label>
                <select className="input mt-1"><option>Node 20 (Recomendado)</option><option>Deno 1.41</option></select>
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-3">
              <h3 className="font-semibold">Código (handler.mjs)</h3>
              <textarea value={code} onChange={e=>setCode(e.target.value)} rows={22}
                className="w-full font-mono text-xs px-3 py-3 rounded-lg bg-black/60 border border-[var(--border)] focus:border-violet-500 outline-none" />
            </div>
          )}
          {step === 3 && (
            <div className="space-y-4">
              <h3 className="font-semibold">Configuración</h3>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs text-slate-400">Memoria</label><select className="input mt-1"><option>128 MB</option><option>256 MB</option><option>512 MB</option></select></div>
                <div><label className="text-xs text-slate-400">Timeout (s)</label><input className="input mt-1" defaultValue={30} /></div>
              </div>
              <p className="text-xs text-slate-500">Podrás añadir secrets después en el detalle de la función.</p>
            </div>
          )}
          {step === 4 && (
            <div className="space-y-3">
              <h3 className="font-semibold">Listo para desplegar</h3>
              <div className="rounded-lg bg-[var(--panel-2)] border border-[var(--border)] p-4 text-sm">
                <div><span className="text-slate-400">Nombre:</span> <strong>{name || "—"}</strong></div>
                <div><span className="text-slate-400">Descripción:</span> {desc || "—"}</div>
                <div><span className="text-slate-400">Líneas de código:</span> {code.split("\n").length}</div>
              </div>
              {err && <div className="text-rose-400 text-sm">Error: {err}</div>}
            </div>
          )}

          <div className="flex justify-between mt-6">
            <button disabled={step===1} onClick={()=>setStep(s=>s-1)} className="btn-ghost disabled:opacity-40">Atrás</button>
            {step < 4 ? (
              <button disabled={step===1 && !name} onClick={()=>setStep(s=>s+1)} className="btn-primary disabled:opacity-50">Siguiente</button>
            ) : (
              <button disabled={busy || !name} onClick={submit} className="btn-primary disabled:opacity-50">{busy ? "Creando…" : "Crear y desplegar"}</button>
            )}
          </div>
        </div>

        <div className="card">
          <h3 className="font-semibold mb-3">Resumen</h3>
          <div className="text-sm space-y-2">
            <div className="flex justify-between"><span className="text-slate-400">Paso</span><span>{step}/4</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Nombre</span><span className="truncate max-w-[150px]">{name || "—"}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Runtime</span><span>Node 20</span></div>
          </div>
          <div className="mt-5 p-4 rounded-lg bg-gradient-to-br from-violet-600/15 to-cyan-500/10 border border-violet-500/20 text-xs text-slate-300">
            💡 Tip: después del deploy verás una URL local única, por ejemplo <code className="text-violet-300">http://localhost:32770</code>.
          </div>
        </div>
      </div>
    </div>
  );
}

import { Suspense } from "react";
export default function NewFn() {
  return <Suspense fallback={<div className="text-slate-400">Cargando…</div>}><NewFnInner /></Suspense>;
}

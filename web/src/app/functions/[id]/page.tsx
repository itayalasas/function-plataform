"use client";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, API } from "@/lib/api";
import { Topbar } from "@/components/Topbar";
import { StatusBadge } from "@/components/StatusBadge";
import { Code2, KeyRound, FileText, Rocket, Square, Trash2, Save, ExternalLink } from "lucide-react";

type Secret = { id: string; key: string; value: string };
type Fn = {
  id: string; slug: string; name: string; code: string; status: string;
  url?: string; container_id?: string; secrets: Secret[];
};

export default function Detail() {
  const { id } = useParams<{ id: string }>();
  const r = useRouter();
  const [fn, setFn] = useState<Fn | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [tab, setTab] = useState<"code" | "secrets" | "logs" | "settings">("code");
  const [savingMsg, setSavingMsg] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [secretVal, setSecretVal] = useState("");
  const esRef = useRef<EventSource | null>(null);

  async function load() { setFn(await api<Fn>(`/api/functions/${id}`)); }
  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab !== "logs" || !id) return;
    setLogs([]);
    const es = new EventSource(`${API}/api/functions/${id}/logs`);
    esRef.current = es;
    es.onmessage = (e) => { try { setLogs((l) => [...l.slice(-500), JSON.parse(e.data)]); } catch {} };
    es.onerror = () => es.close();
    return () => es.close();
  }, [tab, id]);

  if (!fn) return <div className="text-slate-400">Cargando…</div>;

  async function save() {
    setSavingMsg("Guardando…");
    await api(`/api/functions/${id}`, { method: "PUT", body: JSON.stringify({ name: fn!.name, code: fn!.code }) });
    setSavingMsg("Guardado ✓"); setTimeout(() => setSavingMsg(""), 1500);
  }
  async function deploy() {
    setSavingMsg("Desplegando…");
    try { await api(`/api/functions/${id}/deploy`, { method: "POST" }); setSavingMsg("Desplegado ✓"); }
    catch (e: any) { setSavingMsg("Error: " + e.message); }
    await load();
  }
  async function stop() { await api(`/api/functions/${id}/stop`, { method: "POST" }); await load(); }
  async function del() {
    if (!confirm("¿Eliminar esta función?")) return;
    await api(`/api/functions/${id}`, { method: "DELETE" });
    r.push("/functions");
  }
  async function addSecret() {
    if (!secretKey) return;
    await api(`/api/functions/${id}/secrets`, { method: "POST", body: JSON.stringify({ key: secretKey, value: secretVal }) });
    setSecretKey(""); setSecretVal(""); load();
  }
  async function delSecret(sid: string) { await api(`/api/secrets/${sid}`, { method: "DELETE" }); load(); }

  const tabs = [
    { id: "code", label: "Código", icon: Code2 },
    { id: "secrets", label: "Secrets", icon: KeyRound },
    { id: "logs", label: "Logs", icon: FileText },
    { id: "settings", label: "Configuración", icon: Rocket },
  ] as const;

  return (
    <div>
      <Topbar
        title={fn.name}
        subtitle={`/${fn.slug}`}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={save} className="btn-ghost"><Save className="w-4 h-4" /> Guardar</button>
            <button onClick={deploy} className="btn-primary"><Rocket className="w-4 h-4" /> Deploy</button>
            {fn.status === "running" && <button onClick={stop} className="btn-ghost"><Square className="w-4 h-4" /> Detener</button>}
            <button onClick={del} className="btn-danger"><Trash2 className="w-4 h-4" /></button>
          </div>
        }
      />

      <div className="card mb-5 flex flex-wrap items-center gap-4">
        <StatusBadge status={fn.status} />
        {fn.url && (
          <a href={fn.url} target="_blank" className="text-violet-300 text-sm flex items-center gap-1 hover:underline">
            <ExternalLink className="w-3.5 h-3.5" /> {fn.url}
          </a>
        )}
        {savingMsg && <span className="text-xs text-slate-400 ml-auto">{savingMsg}</span>}
      </div>

      <div className="card">
        <div className="flex gap-1 border-b border-[var(--border)] mb-4 -mx-5 px-5">
          {tabs.map(t => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm transition ${active ? "border-b-2 border-violet-400 text-white" : "text-slate-400 hover:text-white"}`}>
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>

        {tab === "code" && (
          <div>
            <div className="flex items-center gap-2 mb-2 text-xs text-slate-500">
              <span className="px-2 py-0.5 rounded bg-[var(--panel-2)] border border-[var(--border)]">handler.mjs</span>
              <span>·</span><span>Node 20</span>
            </div>
            <textarea value={fn.code} onChange={(e) => setFn({ ...fn, code: e.target.value })} rows={22}
              className="w-full font-mono text-xs px-4 py-3 rounded-lg bg-black/60 border border-[var(--border)] focus:border-violet-500 outline-none leading-relaxed" />
          </div>
        )}

        {tab === "secrets" && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input placeholder="KEY" value={secretKey} onChange={e=>setSecretKey(e.target.value.toUpperCase())} className="input w-48" />
              <input placeholder="value" value={secretVal} onChange={e=>setSecretVal(e.target.value)} className="input flex-1" />
              <button onClick={addSecret} className="btn-primary">Añadir</button>
            </div>
            <div className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
              {fn.secrets.length === 0 && <div className="p-6 text-sm text-slate-500 text-center">Sin secrets configurados.</div>}
              {fn.secrets.map(s => (
                <div key={s.id} className="p-3 flex items-center justify-between text-sm">
                  <div><span className="font-mono text-violet-300">{s.key}</span> <span className="text-slate-500 ml-2">= ••••••••</span></div>
                  <button onClick={() => delSecret(s.id)} className="text-rose-400 hover:text-rose-300 text-xs">eliminar</button>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500">Los secrets se inyectan como variables de entorno al contenedor en cada deploy.</p>
          </div>
        )}

        {tab === "logs" && (
          <div className="rounded-lg border border-[var(--border)] bg-black/60 p-4 h-[480px] overflow-auto font-mono text-xs">
            {logs.length === 0 && <div className="text-slate-500">Esperando logs…</div>}
            {logs.map((l, i) => <div key={i} className="whitespace-pre-wrap text-slate-300 py-0.5">{l}</div>)}
          </div>
        )}

        {tab === "settings" && (
          <div className="space-y-4 max-w-xl">
            <div>
              <label className="text-xs text-slate-400">Nombre</label>
              <input className="input mt-1" value={fn.name} onChange={e=>setFn({ ...fn, name: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-slate-400">Slug</label>
              <input className="input mt-1" value={fn.slug} disabled />
            </div>
            <button onClick={save} className="btn-primary">Guardar cambios</button>
          </div>
        )}
      </div>
    </div>
  );
}

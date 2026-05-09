"use client";
import { useEffect, useRef, useState } from "react";
import { api, API } from "@/lib/api";
import { Topbar } from "@/components/Topbar";
import { Trash2 } from "lucide-react";

type Fn = { id: string; name: string };

export default function LogsPage() {
  const [items, setItems] = useState<Fn[]>([]);
  const [sel, setSel] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [level, setLevel] = useState("all");
  const [q, setQ] = useState("");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => { api<Fn[]>("/api/functions").then(setItems).catch(() => {}); }, []);
  useEffect(() => {
    if (!sel) return;
    setLogs([]);
    const es = new EventSource(`${API}/api/functions/${sel}/logs`);
    esRef.current = es;
    es.onmessage = (e) => { try { setLogs(l => [...l.slice(-1000), JSON.parse(e.data)]); } catch {} };
    es.onerror = () => es.close();
    return () => es.close();
  }, [sel]);

  const filtered = logs.filter(l => l.toLowerCase().includes(q.toLowerCase()));

  function colorFor(line: string) {
    if (/error|fail/i.test(line)) return "text-rose-300";
    if (/warn/i.test(line)) return "text-amber-300";
    if (/info/i.test(line)) return "text-cyan-300";
    return "text-slate-300";
  }

  return (
    <div>
      <Topbar title="Logs" subtitle="Visualiza los logs de tus funciones en tiempo real" />
      <div className="card">
        <div className="flex flex-wrap gap-3 mb-4">
          <select value={sel} onChange={e => setSel(e.target.value)} className="input w-60">
            <option value="">Selecciona una función</option>
            {items.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select value={level} onChange={e => setLevel(e.target.value)} className="input w-44">
            <option value="all">Todos los niveles</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar logs..." className="input flex-1 min-w-[200px]" />
          <button onClick={() => setLogs([])} className="btn-ghost"><Trash2 className="w-4 h-4" /> Limpiar</button>
        </div>

        <div className="rounded-lg border border-[var(--border)] bg-black/50 p-4 h-[520px] overflow-auto font-mono text-xs">
          {!sel && <div className="text-slate-500">Selecciona una función para ver logs.</div>}
          {sel && filtered.length === 0 && <div className="text-slate-500">Esperando logs…</div>}
          {filtered.map((l, i) => (
            <div key={i} className={`whitespace-pre-wrap ${colorFor(l)} py-0.5`}>
              <span className="text-slate-600 mr-2">{new Date().toLocaleTimeString()}</span>{l}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

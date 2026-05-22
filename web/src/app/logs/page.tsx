"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API } from "@/lib/api";
import { environmentQuery, useCurrentEnvironment } from "@/lib/environment";
import { mergeLogEntries, parseLogEntry } from "@/lib/logs";
import { Topbar } from "@/components/Topbar";
import { Filter, Trash2 } from "lucide-react";

type Project = { id: string; name: string; slug: string };
type Environment = { id: string; name: string; slug: string };
type Fn = { id: string; name: string; slug: string; project_name?: string; environment_slug?: string };
type LogEntry = { message: string; ts?: string };

export default function LogsPage() {
  const currentEnv = useCurrentEnvironment();
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [items, setItems] = useState<Fn[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [sel, setSel] = useState<string>("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [scope, setScope] = useState("runtime");
  const [level, setLevel] = useState("all");
  const [q, setQ] = useState("");
  const esRef = useRef<EventSource | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  function scrollLogsToBottom() {
    const el = logContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

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

  async function loadFunctions() {
    const rows = await api<Fn[]>(`/api/functions${environmentQuery(currentEnv.slug, {
      project_id: projectId || undefined,
    })}`);
    setItems(rows);
    setSel((current) => rows.some((fn) => fn.id === current) ? current : "");
  }

  const loadLogHistory = useCallback(async (functionId: string) => {
    const history = await api<LogEntry[]>(`/api/functions/${functionId}/logs/history`);
    setLogs((current) => mergeLogEntries(current, history || [], 1000));
  }, []);

  useEffect(() => { loadProjects().catch(() => {}); }, []);
  useEffect(() => { loadEnvironments(projectId).catch(() => {}); }, [projectId, currentEnv.slug]);
  useEffect(() => { loadFunctions().catch(() => {}); }, [projectId, currentEnv.slug]);

  useEffect(() => {
    if (!sel) {
      setLogs([]);
      return;
    }
    setLogs([]);
    const refresh = () => loadLogHistory(sel).then(scrollLogsToBottom).catch(() => {});
    refresh();
    const es = new EventSource(`${API}/api/functions/${sel}/logs`);
    esRef.current = es;
    es.onopen = () => scrollLogsToBottom();
    es.onmessage = (e) => {
      try {
        setLogs((current) => mergeLogEntries(current, [{ message: JSON.parse(e.data), ts: new Date().toISOString() }], 1000));
      } catch {}
    };
    es.onerror = () => {};
    const timer = window.setInterval(refresh, 4000);
    return () => {
      window.clearInterval(timer);
      es.close();
    };
  }, [sel, loadLogHistory]);

  useEffect(() => {
    if (!sel) return;
    const frame = window.requestAnimationFrame(scrollLogsToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [sel, logs, scope, level, q]);

  function isPlatformLog(line: string) {
    return /\[(validation|deploy):/i.test(line);
  }

  const filtered = logs.filter((entry) => {
    const message = entry.message || "";
    if (scope === "runtime" && isPlatformLog(message)) return false;
    if (scope === "platform" && !isPlatformLog(message)) return false;
    return message.toLowerCase().includes(q.toLowerCase()) &&
      (level === "all" || new RegExp(level, "i").test(message));
  });

  function logLevel(message: string) {
    return parseLogEntry(message).level;
  }

  function logLevelClass(level: string) {
    if (level === "ERROR") return "text-rose-300 border-rose-500/30 bg-rose-500/10";
    if (level === "WARNING") return "text-amber-300 border-amber-500/30 bg-amber-500/10";
    return "text-cyan-300 border-cyan-500/30 bg-cyan-500/10";
  }

  function logTextClass(level: string) {
    if (level === "ERROR") return "text-rose-200";
    if (level === "WARNING") return "text-amber-200";
    return "text-slate-300";
  }

  return (
    <div>
      <Topbar title="Logs" subtitle={`Logs solo del ambiente ${currentEnv.label}`} />
      <div className="card">
        <div className="grid grid-cols-1 xl:grid-cols-6 gap-3 mb-4">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input">
            <option value="">Todos los proyectos</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} className="input" disabled>
            <option value="current">Ambiente {currentEnv.slug.toUpperCase()}</option>
            {environments.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
          </select>
          <select value={sel} onChange={(e) => setSel(e.target.value)} className="input">
            <option value="">Selecciona una funcion</option>
            {items.map((fn) => (
              <option key={fn.id} value={fn.id}>
                {fn.name} {fn.environment_slug ? `(${fn.environment_slug})` : ""}
              </option>
            ))}
          </select>
          <select value={scope} onChange={(e) => setScope(e.target.value)} className="input">
            <option value="runtime">Solicitudes API</option>
            <option value="platform">Deploy/plataforma</option>
            <option value="all">Todo</option>
          </select>
          <select value={level} onChange={(e) => setLevel(e.target.value)} className="input">
            <option value="all">Todos los niveles</option>
            <option value="info">Info</option>
            <option value="warn|warning">Warning</option>
            <option value="error|fail|failed">Error</option>
          </select>
          <div className="flex gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar logs..." className="input flex-1 min-w-0" />
            <button onClick={() => { setProjectId(""); setSel(""); setScope("runtime"); setQ(""); setLogs([]); }} className="btn-ghost shrink-0" title="Limpiar filtros">
              <Filter className="w-4 h-4" />
            </button>
            <button onClick={() => setLogs([])} className="btn-ghost shrink-0" title="Limpiar vista">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div ref={logContainerRef} className="rounded-lg border border-[var(--border)] bg-black/50 p-4 h-[520px] overflow-auto font-mono text-xs">
          {!sel && <div className="text-slate-500">Selecciona una funcion para ver logs.</div>}
          {sel && filtered.length === 0 && (
            <div className="text-slate-500">
              Esperando logs de solicitudes API. Haz una llamada al endpoint o cambia el filtro a Deploy/plataforma.
            </div>
          )}
          {filtered.map((entry, i) => {
            const parsed = parseLogEntry(entry.message || "");
            const level = parsed.level;
            return (
              <div key={i} className={`flex items-start gap-2 ${logTextClass(level)} py-1`}>
                <span className={`chip font-sans text-[10px] leading-none mt-0.5 ${logLevelClass(level)}`}>{level}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-slate-600 text-[11px] mb-1">{new Date(entry.ts || Date.now()).toLocaleString()}</div>
                  {parsed.structured ? (
                    <div className="rounded-md border border-[var(--border)] bg-black/30 p-3">
                      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
                        <span className="chip font-sans text-[10px] leading-none" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>
                          {parsed.structured.type || "JSON"}
                        </span>
                        {parsed.tx ? <span className="text-cyan-200">tx {parsed.tx}</span> : null}
                        {parsed.method ? <span className="text-violet-200">{parsed.method}</span> : null}
                        {parsed.path ? <span className="text-slate-300 break-all">{parsed.path}</span> : null}
                        {parsed.status ? <span className="chip font-sans text-[10px]" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{parsed.status}</span> : null}
                        {parsed.duration ? <span className="text-slate-500">{parsed.duration}ms</span> : null}
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-300">{parsed.pretty || parsed.raw}</pre>
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{entry.message}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

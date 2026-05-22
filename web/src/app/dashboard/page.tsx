"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { buildCurlCommand, copyText } from "@/lib/curl";
import { environmentQuery, useCurrentEnvironment } from "@/lib/environment";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Activity,
  AlertTriangle,
  Bell,
  Box,
  BrainCircuit,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  FolderKanban,
  Plus,
  Search,
  Server,
  ShieldAlert,
} from "lucide-react";
import { Line, LineChart, ResponsiveContainer } from "recharts";

type DashboardFunction = {
  id: string;
  slug: string;
  name: string;
  status: string;
  url?: string | null;
  project_name?: string | null;
  environment_slug?: string | null;
  validation_status?: string | null;
  updated_at?: string;
  auth_required?: boolean;
  auth_header_name?: string;
  api_tokens?: { id: string; name: string; value: string }[];
};

type EnvironmentStatus = {
  project_id?: string | null;
  project_name: string;
  environment_id: string;
  environment_name: string;
  environment_slug: string;
  functions: number;
  running: number;
  failed_functions: number;
  deployments: number;
  failed_deployments: number;
  availability: number | null;
  target_mode: string;
  target_auto_deploy: boolean;
  target_configured: boolean;
  memory_assigned_mb?: number;
  memory_budget_mb?: number;
  memory_available_mb?: number | null;
  memory_usage_pct?: number | null;
  status: string;
};

type DashboardData = {
  totals: {
    projects: number;
    environments: number;
    functions: number;
    running: number;
    deployments: number;
    successful: number;
    failed: number;
    failedFunctions: number;
    issues: number;
    availabilityRate: number;
    targets: number;
  };
  recentFunctions: DashboardFunction[];
  environmentStatus: EnvironmentStatus[];
  system: {
    docker: {
      available: boolean;
      status: string;
      containers: number;
      running: number;
      message?: string;
    };
    targets: {
      total: number;
      configured: number;
      autoDeploy: number;
    };
  };
  store: string;
  ai_validation: boolean;
};

const emptyDashboard: DashboardData = {
  totals: {
    projects: 0,
    environments: 0,
    functions: 0,
    running: 0,
    deployments: 0,
    successful: 0,
    failed: 0,
    failedFunctions: 0,
    issues: 0,
    availabilityRate: 100,
    targets: 0,
  },
  recentFunctions: [],
  environmentStatus: [],
  system: {
    docker: { available: false, status: "unavailable", containers: 0, running: 0 },
    targets: { total: 0, configured: 0, autoDeploy: 0 },
  },
  store: "file",
  ai_validation: false,
};

const spark = (seed: number, value: number) =>
  Array.from({ length: 12 }).map((_, i) => ({
    v: 30 + ((seed * 17 + value * 7 + i * 13) % 58),
  }));

function timeAgo(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const diff = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Ahora";
  if (minutes < 60) return `Hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `Hace ${days} d`;
}

function targetLabel(env: EnvironmentStatus) {
  const mode = env.target_mode || "manual";
  if (!env.target_configured) return "Sin target";
  return `${mode}${env.target_auto_deploy ? " auto" : ""}`;
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  color,
  data,
}: {
  icon: any;
  label: string;
  value: string;
  hint: string;
  color: string;
  data: { v: number }[];
}) {
  return (
    <div className="card relative overflow-hidden">
      <div className="flex items-start justify-between gap-4">
        <div className="w-11 h-11 rounded-xl grid place-items-center" style={{ background: `${color}1f`, color }}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="w-24 h-10 -mt-1 -mr-1">
          <ResponsiveContainer>
            <LineChart data={data}>
              <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="mt-3 text-[13px] text-slate-400">{label}</div>
      <div className="mt-1 text-[28px] font-semibold tracking-tight leading-none">{value}</div>
      <div className="mt-3 text-[11px] text-slate-500">{hint}</div>
    </div>
  );
}

function PlatformItem({ icon: Icon, label, value, status, statusLabel }: { icon: any; label: string; value: string; status?: string; statusLabel?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-black/20 px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg grid place-items-center bg-white/5 text-cyan-300">
          <Icon className="w-4 h-4" />
        </div>
        <span className="text-sm text-slate-300">{label}</span>
      </div>
      {status ? <StatusBadge status={status} label={statusLabel || value} /> : <span className="text-sm font-medium text-white">{value}</span>}
    </div>
  );
}

export default function DashboardPage() {
  const currentEnv = useCurrentEnvironment();
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState("");

  async function load() {
    try {
      setData(await api<DashboardData>(`/api/dashboard${environmentQuery(currentEnv.slug)}`));
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [currentEnv.slug]);

  async function copyCurl(fn: DashboardFunction) {
    if (!fn.url) return;
    try {
      const fullFn = await api<DashboardFunction>(`/api/functions/${fn.id}`);
      await copyText(buildCurlCommand(fullFn, fn.url));
      setCopiedId(fn.id);
      setTimeout(() => setCopiedId((current) => current === fn.id ? "" : current), 1800);
    } catch (e: any) {
      setErr(e.message || "No se pudo copiar el cURL");
    }
  }

  const totals = data.totals;
  const docker = data.system?.docker || emptyDashboard.system.docker;
  const remoteBuildReady = !docker.available && data.system.targets.configured > 0;
  const dockerStatus = docker.available ? docker.status : remoteBuildReady ? "remote_build" : docker.status;
  const dockerLabel = docker.available ? `${docker.running}/${docker.containers} running` : remoteBuildReady ? "ACR remoto" : docker.message || "No disponible";

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-7">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[26px] font-semibold tracking-tight">Dashboard</h1>
            <span className="chip uppercase" style={{ borderColor: "rgba(34,211,238,.35)", color: "#67e8f9", background: "rgba(34,211,238,.08)" }}>{currentEnv.slug}</span>
          </div>
          <p className="text-sm text-slate-400 mt-1">Resumen del ambiente {currentEnv.label}: funciones, disponibilidad y plataforma.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost h-10 w-10 !p-0" title="Buscar">
            <Search className="w-[18px] h-[18px]" />
          </button>
          <button className="btn-ghost h-10 w-10 !p-0 relative" title="Alertas">
            <Bell className="w-[18px] h-[18px]" />
            {totals.issues > 0 && (
              <span className="absolute -top-1 -right-1 text-[10px] bg-rose-500 text-white rounded-full min-w-4 h-4 px-1 grid place-items-center">
                {totals.issues}
              </span>
            )}
          </button>
          <Link href="/new" className="btn-primary h-10">
            <Plus className="w-4 h-4" /> Nueva Funcion
          </Link>
        </div>
      </div>

      {err && <div className="card mb-5 text-rose-300 text-sm">No se pudo conectar con el API: {err}</div>}
      {loading && !err && <div className="card mb-5 text-slate-400 text-sm">Cargando metricas...</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <StatCard icon={Box} label="Funciones" value={String(totals.functions)} hint={`${totals.running} running, ${totals.failedFunctions} con error`} color="#8b5cf6" data={spark(1, totals.functions)} />
        <StatCard icon={FolderKanban} label="Proyectos" value={String(totals.projects)} hint={`${totals.environments} ambientes, ${totals.targets} targets`} color="#22d3ee" data={spark(2, totals.projects)} />
        <StatCard icon={ShieldAlert} label="Problemas" value={String(totals.issues)} hint={`${totals.failedFunctions} funciones, ${totals.failed} deploys`} color={totals.issues ? "#f43f5e" : "#22c55e"} data={spark(3, totals.issues)} />
        <StatCard icon={Activity} label="Salud funciones" value={`${totals.availabilityRate}%`} hint={`${totals.functions - totals.failedFunctions}/${totals.functions} funciones sanas`} color="#22c55e" data={spark(4, Math.round(totals.availabilityRate))} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="card xl:col-span-2 p-0 overflow-hidden">
          <div className="flex items-center justify-between p-5 pb-3">
            <h3 className="font-semibold">Funciones recientes</h3>
            <Link href="/functions" className="text-xs text-violet-300 hover:underline">Ver todas</Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-[var(--border)]">
                <tr>
                  <th className="text-left px-5 py-3 font-normal">Nombre</th>
                  <th className="text-left px-5 py-3 font-normal">Proyecto</th>
                  <th className="text-left px-5 py-3 font-normal">Estado</th>
                  <th className="text-left px-5 py-3 font-normal">Actualizacion</th>
                  <th className="text-right px-5 py-3 font-normal">URL</th>
                </tr>
              </thead>
              <tbody>
                {data.recentFunctions.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-12 text-center text-slate-500">Todavia no hay funciones creadas.</td>
                  </tr>
                )}
                {data.recentFunctions.map((fn) => (
                  <tr key={fn.id} className="border-b last:border-b-0 border-[var(--border)] hover:bg-white/[.02]">
                    <td className="px-5 py-4">
                      <Link href={`/functions/${fn.id}`} className="font-medium text-white hover:text-violet-300">{fn.name}</Link>
                      <div className="text-[11px] text-slate-500">/{fn.slug}</div>
                    </td>
                    <td className="px-5 py-4 text-slate-300">
                      {fn.project_name || "Sin proyecto"}
                      {fn.environment_slug && <span className="ml-2 text-[11px] uppercase text-cyan-300">{fn.environment_slug}</span>}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-2">
                        <StatusBadge status={fn.status} />
                        {fn.validation_status && <StatusBadge status={fn.validation_status} />}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-slate-400">{timeAgo(fn.updated_at)}</td>
                    <td className="px-5 py-4 text-right">
                      {fn.url ? (
                        <div className="flex items-center justify-end gap-3">
                          <button type="button" onClick={() => copyCurl(fn)} className="inline-flex items-center gap-1 text-cyan-300 hover:underline" title="Copiar cURL">
                            <Copy className="w-3.5 h-3.5" /> {copiedId === fn.id ? "copiado" : "cURL"}
                          </button>
                          <a href={fn.url} target="_blank" className="inline-flex items-center gap-1 text-violet-300 hover:underline">
                            abrir <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Estado de plataforma</h3>
            {totals.issues > 0 || (!docker.available && !remoteBuildReady) ? <AlertTriangle className="w-4 h-4 text-amber-300" /> : <CheckCircle2 className="w-4 h-4 text-emerald-300" />}
          </div>
          <div className="space-y-3">
            <PlatformItem icon={Database} label="Store" value={data.store} />
            <PlatformItem icon={BrainCircuit} label="Validacion IA" value={data.ai_validation ? "Activa" : "Pendiente"} />
            <PlatformItem icon={Server} label="Docker" value={dockerLabel} status={dockerStatus} />
            <PlatformItem icon={Cloud} label="Container Apps" value={`${data.system.targets.autoDeploy}/${data.system.targets.total} auto`} />
          </div>
        </div>

        <div className="card xl:col-span-3 p-0 overflow-hidden">
          <div className="flex items-center justify-between p-5 pb-3">
            <h3 className="font-semibold">Disponibilidad por ambiente</h3>
            <Link href="/container-apps" className="text-xs text-violet-300 hover:underline">Configurar targets</Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-[var(--border)]">
                <tr>
                  <th className="text-left px-5 py-3 font-normal">Proyecto</th>
                  <th className="text-left px-5 py-3 font-normal">Ambiente</th>
                  <th className="text-left px-5 py-3 font-normal">Funciones</th>
                  <th className="text-left px-5 py-3 font-normal">Disponibilidad</th>
                  <th className="text-left px-5 py-3 font-normal">Target</th>
                  <th className="text-left px-5 py-3 font-normal">Deploys</th>
                  <th className="text-left px-5 py-3 font-normal">Estado</th>
                </tr>
              </thead>
              <tbody>
                {data.environmentStatus.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center text-slate-500">Todavia no hay ambientes creados.</td>
                  </tr>
                )}
                {data.environmentStatus.map((env) => (
                  <tr key={env.environment_id} className="border-b last:border-b-0 border-[var(--border)] hover:bg-white/[.02]">
                    <td className="px-5 py-4 text-slate-300">{env.project_name}</td>
                    <td className="px-5 py-4">
                      <span className="chip uppercase" style={{ borderColor: "rgba(34,211,238,.35)", color: "#67e8f9", background: "rgba(34,211,238,.08)" }}>
                        {env.environment_slug}
                      </span>
                      <div className="text-[11px] text-slate-500 mt-1">{env.environment_name}</div>
                    </td>
                    <td className="px-5 py-4 text-slate-300">
                      {env.functions}
                      <span className="text-slate-500 ml-2">{env.running} running</span>
                      {env.failed_functions > 0 && <span className="text-rose-300 ml-2">{env.failed_functions} error</span>}
                    </td>
                    <td className="px-5 py-4">
                      {env.availability == null ? (
                        <div>
                          <span className="text-xs text-slate-500">No medido</span>
                          <div className="text-[11px] text-slate-600 mt-1">{env.target_configured ? "Sin despliegue externo" : "Configura un target"}</div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3 min-w-[160px]">
                          <div className="h-2 flex-1 rounded-full bg-slate-800 overflow-hidden">
                            <div className={`h-full ${env.availability >= 90 ? "bg-emerald-400" : env.availability >= 70 ? "bg-amber-400" : "bg-rose-400"}`} style={{ width: `${env.availability}%` }} />
                          </div>
                          <span className="font-mono text-xs text-slate-300">{env.availability}%</span>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-4 text-slate-400">{targetLabel(env)}</td>
                    <td className="px-5 py-4 text-slate-300">
                      {env.deployments}
                      {env.failed_deployments > 0 && <span className="text-rose-300 ml-2">{env.failed_deployments} fallidos</span>}
                    </td>
                    <td className="px-5 py-4"><StatusBadge status={env.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}


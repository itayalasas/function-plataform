"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import {
  Search, Bell, BookOpen, Plus, Box, Play, CheckCircle2, Zap,
  Mail, FileText, DollarSign, Webhook, FileType, MoreHorizontal,
  ChevronDown, Copy, Circle, Server,
} from "lucide-react";
import {
  AreaChart, Area, ResponsiveContainer, LineChart, Line,
} from "recharts";

type Fn = { id: string; slug: string; name: string; status: string; updated_at: string };

const spark = (seed: number) =>
  Array.from({ length: 12 }).map((_, i) => ({
    v: 50 + Math.sin((i + seed) / 1.6) * 30 + Math.random() * 25,
  }));

function StatCard({
  icon: Icon, label, value, hint, color, data,
}: { icon: any; label: string; value: string; hint: string; color: string; data: any[] }) {
  return (
    <div className="card relative overflow-hidden">
      <div className="flex items-start justify-between">
        <div className="w-11 h-11 rounded-xl grid place-items-center"
             style={{ background: `${color}1f`, color }}>
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
      <div className="mt-3 text-[11px]" style={{ color: "#22c55e" }}>{hint}</div>
    </div>
  );
}

const fnIcons: Record<string, { icon: any; color: string }> = {
  "send-email":     { icon: Mail,       color: "#8b5cf6" },
  "create-invoice": { icon: FileText,   color: "#22d3ee" },
  "process-payment":{ icon: DollarSign, color: "#22c55e" },
  "webhook-handler":{ icon: Webhook,    color: "#f59e0b" },
  "generate-pdf":   { icon: FileType,   color: "#f43f5e" },
};

const sampleFns = [
  { name: "send-email",      version: "v1.2.3", deploy: "Hace 2 horas", exec: "1.234" },
  { name: "create-invoice",  version: "v1.0.0", deploy: "Hace 5 horas", exec: "842" },
  { name: "process-payment", version: "v2.1.0", deploy: "Ayer",         exec: "2.453" },
  { name: "webhook-handler", version: "v1.3.2", deploy: "Hace 2 días",  exec: "567" },
  { name: "generate-pdf",    version: "v1.0.1", deploy: "Hace 3 días",  exec: "321" },
];

const activity = [
  { t: "Función ", em: "send-email", suf: " desplegada", d: "Hace 2 horas", c: "#22c55e", icon: Box },
  { t: "Nueva función ", em: "create-invoice", suf: " creada", d: "Hace 5 horas", c: "#8b5cf6", icon: Plus },
  { t: "Se actualizó el secret ", em: "RESEND_API_KEY", suf: "", d: "Hace 1 día", c: "#22d3ee", icon: CheckCircle2 },
  { t: "Función ", em: "process-payment", suf: " desplegada", d: "Hace 2 días", c: "#22c55e", icon: Box },
  { t: "Nuevo proyecto ", em: "My Project", suf: " creado", d: "Hace 3 días", c: "#f59e0b", icon: Server },
];

const codeLines = [
  { n: 1,  t: 'import { Resend } from "npm:resend@2.0.0";' },
  { n: 2,  t: '' },
  { n: 3,  t: 'const resend = new Resend(Deno.env.get("RESEND_API_KEY"));' },
  { n: 4,  t: '' },
  { n: 5,  t: 'Deno.serve(async (req: Request) => {' },
  { n: 6,  t: '  try {' },
  { n: 7,  t: '    const { to, subject, html } = await req.json();' },
  { n: 8,  t: '' },
  { n: 9,  t: '    const data = await resend.emails.send({' },
  { n: 10, t: '      from: Deno.env.get("EMAIL_FROM"),' },
  { n: 11, t: '      to,' },
  { n: 12, t: '      subject,' },
  { n: 13, t: '      html,' },
  { n: 14, t: '    });' },
];

export default function Page() {
  const [items, setItems] = useState<Fn[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try { setItems(await api<Fn[]>("/api/functions")); setErr(null); }
    catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-7">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight flex items-center gap-2">
            ¡Bienvenido de vuelta, Admin! <span>👋</span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">Aquí tienes un resumen de tu plataforma</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost h-10 w-10 !p-0"><Search className="w-[18px] h-[18px]" /></button>
          <button className="btn-ghost h-10 w-10 !p-0 relative">
            <Bell className="w-[18px] h-[18px]" />
            <span className="absolute -top-1 -right-1 text-[10px] bg-rose-500 text-white rounded-full w-4 h-4 grid place-items-center">3</span>
          </button>
          <button className="btn-ghost h-10 w-10 !p-0"><BookOpen className="w-[18px] h-[18px]" /></button>
          <Link href="/new" className="btn-primary h-10"><Plus className="w-4 h-4" /> Nueva Función</Link>
        </div>
      </div>

      {err && <div className="card mb-5 text-rose-300 text-sm">No se pudo conectar con el API: {err}</div>}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <StatCard icon={Box}          label="Funciones"      value={items.length ? String(items.length) : "12"} hint="↑ 2 desde la semana pasada"     color="#8b5cf6" data={spark(0)} />
        <StatCard icon={Play}         label="Ejecuciones"    value="23.453" hint="↑ 12% desde la semana pasada"   color="#22d3ee" data={spark(2)} />
        <StatCard icon={CheckCircle2} label="Tasa de Éxito"  value="99.9%"  hint="↑ 0.2% desde la semana pasada"  color="#22c55e" data={spark(4)} />
        <StatCard icon={Zap}          label="Tiempo Promedio" value="120ms" hint="↓ 15ms desde la semana pasada"  color="#f59e0b" data={spark(6)} />
      </div>

      {/* Recent functions + Activity */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 mb-5">
        <div className="card xl:col-span-2 p-0 overflow-hidden">
          <div className="flex items-center justify-between p-5 pb-3">
            <h3 className="font-semibold">Funciones Recientes</h3>
            <Link href="/functions" className="text-xs text-violet-300 hover:underline">Ver todas</Link>
          </div>
          <div>
            <div className="grid grid-cols-[1.6fr_1fr_1fr_.8fr_40px] px-5 py-2 text-[11px] uppercase tracking-wider text-slate-500 border-b" style={{ borderColor: "var(--border)" }}>
              <div>Nombre</div><div>Estado</div><div>Último Deploy</div><div className="text-right">Ejecuciones</div><div />
            </div>
            {sampleFns.map((f) => {
              const meta = fnIcons[f.name] ?? { icon: Box, color: "#8b5cf6" };
              const Icon = meta.icon;
              return (
                <div key={f.name} className="grid grid-cols-[1.6fr_1fr_1fr_.8fr_40px] items-center px-5 py-3.5 border-b last:border-b-0 hover:bg-white/[.02] transition" style={{ borderColor: "var(--border)" }}>
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg grid place-items-center" style={{ background: `${meta.color}1f`, color: meta.color }}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">{f.name}</div>
                      <div className="text-[11px] text-slate-500">{f.version}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-emerald-300">
                    <Circle className="w-2 h-2 fill-current" /> Activo
                  </div>
                  <div className="text-sm text-slate-300">{f.deploy}</div>
                  <div className="text-sm text-slate-200 text-right tabular-nums">{f.exec}</div>
                  <button className="text-slate-500 hover:text-white grid place-items-center"><MoreHorizontal className="w-4 h-4" /></button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Actividad Reciente</h3>
            <Link href="/logs" className="text-xs text-violet-300 hover:underline">Ver todo</Link>
          </div>
          <div className="space-y-4">
            {activity.map((a, i) => {
              const Icon = a.icon;
              return (
                <div key={i} className="flex gap-3">
                  <div className="w-9 h-9 rounded-lg grid place-items-center shrink-0" style={{ background: `${a.c}1f`, color: a.c }}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="text-[13px] leading-tight pt-1">
                    <div className="text-slate-200">
                      {a.t}<span style={{ color: a.c }} className="font-medium">{a.em}</span>{a.suf}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">{a.d}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Code preview + Function info */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="card xl:col-span-2 p-0 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg grid place-items-center" style={{ background: "rgba(139,92,246,.15)", color: "#a78bfa" }}>
                <Server className="w-4 h-4" />
              </div>
              <div className="font-medium text-sm">send-email</div>
              <span className="chip" style={{ borderColor: "rgba(34,197,94,.35)", color: "#86efac", background: "rgba(34,197,94,.10)" }}>
                <Circle className="w-2 h-2 fill-current" /> Activo
              </span>
              <span className="text-xs text-slate-500">v1.2.3</span>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn-ghost h-8 text-xs">Producción <ChevronDown className="w-3 h-3" /></button>
              <button className="btn-ghost h-8 text-xs">Ver en vivo</button>
              <button className="btn-primary h-8 text-xs">Deploy</button>
            </div>
          </div>
          <div className="flex items-center gap-5 px-5 pt-3 text-[13px] border-b" style={{ borderColor: "var(--border)" }}>
            {["Código","Secrets","Configuración","Logs","Deployments","Métricas"].map((t,i)=>(
              <button key={t} className={`pb-2.5 ${i===0?"text-white border-b-2 border-violet-500":"text-slate-400 hover:text-slate-200"}`}>{t}</button>
            ))}
          </div>
          <div className="grid grid-cols-[180px_1fr]">
            <div className="border-r p-2 text-[12px] space-y-0.5" style={{ borderColor: "var(--border)" }}>
              {[
                { n: "index.ts", active: true },
                { n: "deps.ts" }, { n: "types.ts" }, { n: "README.md" }, { n: ".env.example" },
              ].map((f) => (
                <div key={f.n} className={`px-2.5 py-1.5 rounded-md cursor-pointer ${f.active?"bg-white/5 text-white":"text-slate-400 hover:bg-white/5"}`}>
                  <span className="text-slate-500 mr-2 text-[10px]">TS</span>{f.n}
                </div>
              ))}
            </div>
            <div className="font-mono text-[12.5px] leading-6 py-2 overflow-x-auto">
              {codeLines.map((l) => (
                <div key={l.n} className="flex hover:bg-white/[.02]">
                  <div className="w-10 text-right pr-3 text-slate-600 select-none">{l.n}</div>
                  <pre className="text-slate-300 whitespace-pre">{l.t}</pre>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between px-4 py-2 text-[11px] text-slate-500 border-t" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-3">
              <span>TypeScript</span>
              <span className="flex items-center gap-1"><Circle className="w-1.5 h-1.5 fill-emerald-400 text-emerald-400" /> Sin errores</span>
            </div>
            <div className="flex items-center gap-3">
              <span>Línea 1, Columna 1</span><span>Espacios: 2</span>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="font-semibold mb-4">Información de la Función</h3>
          <dl className="space-y-3.5 text-sm">
            {[
              ["URL", <span key="u" className="flex items-center gap-2 text-violet-300"><span className="truncate max-w-[180px]">https://api.local/functions/send-email</span><Copy className="w-3.5 h-3.5 cursor-pointer text-slate-400" /></span>],
              ["Método", <span key="m" className="chip" style={{ borderColor: "rgba(139,92,246,.35)", color: "#c4b5fd", background: "rgba(139,92,246,.10)" }}>POST</span>],
              ["Runtime", <span key="r" className="text-slate-200">Deno 1.41.0</span>],
              ["Región", <span key="rg" className="text-slate-200">us-east-1</span>],
              ["Timeout", <span key="t" className="text-slate-200">30 segundos</span>],
              ["Memoria", <span key="me" className="text-slate-200">256 MB</span>],
              ["Creada", <span key="c" className="text-slate-200">12 May 2024, 10:30 AM</span>],
              ["Último Deploy", <span key="d" className="text-slate-200">12 May 2024, 03:45 PM</span>],
            ].map(([k, v], i) => (
              <div key={i} className="flex items-center justify-between gap-3 pb-3 border-b last:border-b-0 last:pb-0" style={{ borderColor: "var(--border)" }}>
                <dt className="text-slate-400 text-[13px]">{k as string}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

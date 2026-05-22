"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Boxes,
  KeyRound,
  Rocket,
  LayoutTemplate,
  Settings,
  Sparkles,
  Plus,
  FolderKanban,
  Server,
  Cloud,
  BookOpen,
  LogOut,
} from "lucide-react";
import clsx from "clsx";
import { useAuth } from "@/components/AuthProvider";

const items = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/functions", label: "Funciones", icon: Boxes },
  { href: "/new", label: "Crear Función", icon: Plus },
  { href: "/projects", label: "Proyectos", icon: FolderKanban },
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/deployments", label: "Deployments", icon: Rocket },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/environments", label: "Entornos", icon: Server },
  { href: "/container-apps", label: "Container Apps", icon: Cloud },
  { href: "/docs", label: "Documentacion", icon: BookOpen },
  { href: "/settings", label: "Configuracion", icon: Settings },
];

export function Sidebar() {
  const path = usePathname();
  const router = useRouter();
  const { session, signOut } = useAuth();
  const displayName = session?.user?.name || "Invitado";
  const displayEmail = session?.user?.email || "Sin sesion";
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || displayEmail.slice(0, 2).toUpperCase();

  function handleLogout() {
    signOut();
    router.replace("/");
  }

  return (
    <aside
      className="hidden md:flex w-[260px] shrink-0 sticky top-0 h-screen flex-col p-4 border-r"
      style={{ borderColor: "var(--border)", background: "rgba(15,16,32,.6)", backdropFilter: "blur(12px)" }}
    >
      <Link href="/dashboard" className="flex items-center gap-3 px-2 py-2 mb-5">
        <div
          className="w-10 h-10 rounded-xl grid place-items-center shadow-lg"
          style={{ background: "linear-gradient(135deg,#8b5cf6,#22d3ee)" }}
        >
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="font-semibold leading-none flex items-center gap-2">
            Function Platform
            <span className="chip" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>
              MVP
            </span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1.5">v0.2 · local</div>
        </div>
      </Link>

      <nav className="flex-1 space-y-1 overflow-y-auto pr-1">
        {items.map((it) => {
          const active = path === it.href || path?.startsWith(`${it.href}/`);
          const Icon = it.icon;
          return (
            <Link key={it.href} href={it.href} className={clsx("nav-item", active && "active")}>
              <Icon className="w-[18px] h-[18px]" />
              <span>{it.label}</span>
            </Link>
          );
        })}
      </nav>

      <div
        className="mt-4 p-4 rounded-2xl border"
        style={{ borderColor: "var(--border)", background: "linear-gradient(180deg, rgba(139,92,246,.10), rgba(34,211,238,.04))" }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium">Plan</div>
          <span className="chip" style={{ borderColor: "rgba(139,92,246,.35)", color: "#c4b5fd", background: "rgba(139,92,246,.10)" }}>
            Pro
          </span>
        </div>
        <div className="space-y-2.5 text-xs text-slate-400">
          <div>
            <div className="flex justify-between mb-1">
              <span>Funciones</span>
              <span className="text-slate-200">12 / 50</span>
            </div>
            <div className="h-1.5 rounded-full bg-black/40 overflow-hidden">
              <div className="h-full w-1/4 rounded-full" style={{ background: "linear-gradient(90deg,#8b5cf6,#22d3ee)" }} />
            </div>
          </div>
          <div>
            <div className="flex justify-between mb-1">
              <span>Ejecuciones</span>
              <span className="text-slate-200">23.4K / 100K</span>
            </div>
            <div className="h-1.5 rounded-full bg-black/40 overflow-hidden">
              <div className="h-full w-1/4 rounded-full" style={{ background: "linear-gradient(90deg,#8b5cf6,#22d3ee)" }} />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-start gap-3 p-2.5 rounded-xl border" style={{ borderColor: "var(--border)" }}>
        <div
          className="w-9 h-9 rounded-full grid place-items-center text-xs font-semibold"
          style={{ background: "linear-gradient(135deg,#8b5cf6,#22d3ee)" }}
        >
          {initials}
        </div>
        <div className="text-xs flex-1 min-w-0">
          <div className="font-medium truncate">{displayName}</div>
          <div className="text-slate-500 truncate">{displayEmail}</div>
          {session?.tenant?.name && <div className="mt-1 text-[11px] text-cyan-300 truncate">{session.tenant.name}</div>}
        </div>
        <button type="button" onClick={handleLogout} className="btn-ghost h-8 w-8 !p-0" title="Cerrar sesión">
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}

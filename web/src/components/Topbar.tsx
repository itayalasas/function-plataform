"use client";
import { Bell, Search, User } from "lucide-react";

export function Topbar({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-8 gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-slate-400 mt-1">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--panel-2)] border border-[var(--border)] w-72">
          <Search className="w-4 h-4 text-slate-500" />
          <input placeholder="Buscar..." className="bg-transparent outline-none text-sm flex-1" />
          <span className="kbd">⌘K</span>
        </div>
        <button className="relative p-2 rounded-lg bg-[var(--panel-2)] border border-[var(--border)]">
          <Bell className="w-4 h-4 text-slate-300" />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-rose-500" />
        </button>
        <div className="flex items-center gap-2 pl-3 border-l border-[var(--border)]">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-cyan-400 grid place-items-center">
            <User className="w-4 h-4 text-white" />
          </div>
          <div className="hidden md:block text-xs">
            <div className="font-medium">Admin</div>
            <div className="text-slate-500">admin@fpm.local</div>
          </div>
        </div>
        {actions}
      </div>
    </div>
  );
}

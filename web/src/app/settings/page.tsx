"use client";
import { Topbar } from "@/components/Topbar";

export default function SettingsPage() {
  return (
    <div>
      <Topbar title="Configuración" subtitle="Ajustes generales de la plataforma" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="card lg:col-span-2 space-y-4">
          <h3 className="font-semibold">General</h3>
          <div>
            <label className="text-xs text-slate-400">Nombre de la plataforma</label>
            <input className="input mt-1" defaultValue="Function Platform" />
          </div>
          <div>
            <label className="text-xs text-slate-400">URL de la API</label>
            <input className="input mt-1" defaultValue="http://localhost:4000" />
          </div>
          <div>
            <label className="text-xs text-slate-400">Zona horaria</label>
            <select className="input mt-1">
              <option>America/Bogota</option>
              <option>America/New_York</option>
              <option>Europe/Madrid</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400">Idioma</label>
            <select className="input mt-1"><option>Español</option><option>English</option></select>
          </div>
          <button className="btn-primary">Guardar cambios</button>
        </div>

        <div className="card">
          <h3 className="font-semibold mb-2">Conexión a Base de Datos</h3>
          <p className="text-xs text-slate-400 mb-3">Configurada vía variable <code className="text-violet-300">DATABASE_URL</code> en el archivo .env</p>
          <div className="rounded-lg bg-[var(--panel-2)] border border-[var(--border)] p-3 text-xs font-mono text-slate-400 break-all">
            postgresql://****@***neon.tech/neondb
          </div>
          <h3 className="font-semibold mt-5 mb-2">Docker</h3>
          <div className="text-xs text-slate-400">Runtime activo · v24+</div>
        </div>
      </div>
    </div>
  );
}

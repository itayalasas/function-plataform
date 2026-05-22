"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Topbar } from "@/components/Topbar";
import { api } from "@/lib/api";
import { Code2, Database, FileJson, KeyRound, Webhook } from "lucide-react";

type Template = {
  id: string;
  name: string;
  slug: string;
  category?: string;
  runtime: string;
  description?: string;
  code: string;
  files?: { path: string; content: string }[];
  entrypoint?: string;
};

const iconBySlug: Record<string, any> = {
  "http-json": FileJson,
  "webhook-handler": Webhook,
  "secret-check": KeyRound,
};

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Template[]>("/api/templates")
      .then(setTemplates)
      .catch((error) => setErr(error.message));
  }, []);

  return (
    <div>
      <Topbar title="Templates" subtitle="Plantillas versionadas desde el backend de la plataforma" />

      {err && <div className="card mb-5 text-rose-300 text-sm">No se pudieron cargar templates: {err}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((template) => {
          const Icon = iconBySlug[template.slug] || (template.category === "data" ? Database : Code2);
          return (
            <Link
              key={template.id}
              href={{ pathname: "/new", query: { template_id: template.id } }}
              className="card hover:border-violet-500/40 transition group"
            >
              <div className="w-12 h-12 rounded-xl grid place-items-center mb-4 bg-violet-500/15 text-violet-300">
                <Icon className="w-6 h-6" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold">{template.name}</div>
                <span className="chip" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{template.runtime}</span>
              </div>
              <div className="text-xs text-slate-400 mt-2 mb-3">{template.description}</div>
              <div className="text-xs text-violet-300 group-hover:underline">Usar plantilla</div>
            </Link>
          );
        })}
      </div>

      {!err && templates.length === 0 && <div className="card text-center text-slate-500 py-12">Cargando templates...</div>}
    </div>
  );
}

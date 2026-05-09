"use client";
import { Topbar } from "@/components/Topbar";
import Link from "next/link";
import { Mail, FileText, CreditCard, Webhook, Database, Image as ImageIcon } from "lucide-react";

const TPL = [
  { name: "Send Email", desc: "Envía emails con Resend o SMTP", icon: Mail, color: "#7c5cff", code: `export default async function handler(req){ return new Response("send-email"); }` },
  { name: "Create Invoice", desc: "Genera facturas en PDF", icon: FileText, color: "#22d3ee", code: `export default async function handler(req){ return new Response("invoice"); }` },
  { name: "Process Payment", desc: "Procesa pagos con Stripe", icon: CreditCard, color: "#22c55e", code: `export default async function handler(req){ return new Response("pay"); }` },
  { name: "Webhook Handler", desc: "Recibe webhooks de terceros", icon: Webhook, color: "#f59e0b", code: `export default async function handler(req){ return new Response("ok"); }` },
  { name: "Data Processor", desc: "ETL ligero JSON/CSV", icon: Database, color: "#ec4899", code: `export default async function handler(req){ return new Response("data"); }` },
  { name: "Image Resizer", desc: "Redimensiona imágenes", icon: ImageIcon, color: "#06b6d4", code: `export default async function handler(req){ return new Response("img"); }` },
];

export default function TemplatesPage() {
  return (
    <div>
      <Topbar title="Templates" subtitle="Comienza rápido con plantillas listas para usar" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {TPL.map(t => {
          const Icon = t.icon;
          return (
            <Link key={t.name} href={{ pathname: "/new", query: { template: t.name, code: t.code } }}
              className="card hover:border-violet-500/40 transition group">
              <div className="w-12 h-12 rounded-xl grid place-items-center mb-4" style={{ background: `${t.color}22`, color: t.color }}>
                <Icon className="w-6 h-6" />
              </div>
              <div className="font-semibold mb-1">{t.name}</div>
              <div className="text-xs text-slate-400 mb-3">{t.desc}</div>
              <div className="text-xs text-violet-300 group-hover:underline">Usar plantilla →</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

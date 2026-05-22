"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";

type LoginPanelProps = {
  loginUrl: string;
  registerUrl: string;
};

function Bullet({ icon: Icon, title, text }: { icon: any; title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-500/10 text-cyan-300">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-0.5 text-xs leading-5 text-slate-400">{text}</div>
        </div>
      </div>
    </div>
  );
}

export function LoginPanel({ loginUrl, registerUrl }: LoginPanelProps) {
  const router = useRouter();
  const { ready, isAuthenticated, session } = useAuth();

  const accessLabel = session?.tenant?.name || session?.user?.name || "Tu cuenta";

  return (
    <div className="grid gap-8 lg:grid-cols-[1.15fr_.85fr]">
      <div className="flex flex-col justify-center gap-6">
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-cyan-200">
          <Sparkles className="h-3.5 w-3.5" />
          Plataforma multi-tenant
        </div>

        <div className="space-y-4">
          <h1 className="max-w-xl text-4xl font-semibold tracking-tight text-white md:text-6xl">
            Bienvenido a <span className="bg-gradient-to-r from-cyan-300 to-violet-400 bg-clip-text text-transparent">Function Platform</span>
          </h1>
          <p className="max-w-xl text-base leading-7 text-slate-300 md:text-lg">
            Gestiona funciones, secretos, logs y despliegues entre ambientes desde un mismo lugar.
            El acceso se valida en tu sistema de autenticacion empresarial y cada cuenta opera su propio tenant.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Bullet icon={ShieldCheck} title="Acceso seguro" text="Login externo con validacion de code y tenant." />
          <Bullet icon={KeyRound} title="Multi-tenant" text="Una cuenta puede gestionar varios usuarios." />
          <Bullet icon={CheckCircle2} title="Panel unificado" text="Funciones, secretos y despliegues en un solo flujo." />
        </div>

        <div className="flex flex-wrap gap-3 pt-2">
          <Link href="/" className="btn-ghost h-11">
            Volver al inicio
          </Link>
          {isAuthenticated && (
            <button type="button" onClick={() => router.replace("/dashboard")} className="btn-ghost h-11">
              Ir al panel
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center">
        <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-[rgba(6,12,24,.72)] p-6 shadow-[0_30px_120px_rgba(0,0,0,.45)] backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-cyan-500/15 text-cyan-300">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <span className="chip text-cyan-200 border-cyan-500/30">secure access</span>
          </div>

          <div className="mt-6">
            <div className="text-3xl font-semibold tracking-tight">Iniciar sesión</div>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Usa tu sistema de autenticación empresarial para entrar o crear un tenant nuevo.
            </p>
          </div>

          <div className="mt-6 space-y-3">
            <a href={loginUrl} className="btn-primary h-12 w-full">
              Iniciar sesión
              <ArrowRight className="h-4 w-4" />
            </a>
            <a href={registerUrl} className="btn-ghost h-12 w-full">
              Crear cuenta
            </a>
          </div>

          <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-sm font-medium text-white">Por qué usar autenticación empresarial</div>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
              <li>• Cada cuenta crea o accede a un tenant propio.</li>
              <li>• El panel sincroniza usuarios, permisos y despliegues.</li>
              <li>• Tus funciones y secretos quedan organizados por ambiente.</li>
            </ul>
          </div>

          {ready && isAuthenticated && (
            <div className="mt-4 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-100">
              Ya tienes una sesión activa en {accessLabel}. Puedes entrar al panel sin volver a autenticarte.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

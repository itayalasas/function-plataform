"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleCheck as CheckCircle2, ShieldCheck, Zap, Building2, Users } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { buildExternalAuthUrl, resolveExternalAuthConfig } from "@/lib/auth";

function Benefit({ icon: Icon, title, text }: { icon: any; title: string; text: string }) {
  return (
    <div className="flex gap-3.5">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <div className="text-sm font-medium text-white">{title}</div>
        <div className="mt-0.5 text-sm leading-5 text-slate-500">{text}</div>
      </div>
    </div>
  );
}

export function LoginPanel() {
  const router = useRouter();
  const { ready, isAuthenticated, session } = useAuth();

  const accessLabel = session?.tenant?.name || session?.user?.name || "Tu cuenta";

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const config = resolveExternalAuthConfig(origin);
  const loginUrl = buildExternalAuthUrl("login", config);
  const registerUrl = buildExternalAuthUrl("register-tenant", config);

  return (
    <div className="flex min-h-[calc(100vh-120px)] items-center">
      <div className="grid w-full gap-12 lg:grid-cols-[1fr_420px] lg:gap-16 xl:grid-cols-[1fr_460px]">
        {/* Left: Copy */}
        <div className="flex flex-col justify-center">
          <div className="mb-8 inline-flex w-fit items-center gap-2 rounded-full border border-sky-500/20 bg-sky-500/8 px-3.5 py-1.5 text-xs font-medium text-sky-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
            Autenticación empresarial
          </div>

          <h1 className="mb-5 text-4xl font-bold leading-[1.1] tracking-tight text-white md:text-5xl">
            Bienvenido a{" "}
            <span className="bg-gradient-to-r from-sky-300 to-cyan-200 bg-clip-text text-transparent">
              Function Platform
            </span>
          </h1>

          <p className="mb-10 max-w-lg text-base leading-7 text-slate-400">
            Gestiona funciones, secretos, logs y despliegues entre ambientes desde un mismo lugar.
            El acceso se valida con tu sistema de autenticación corporativo.
          </p>

          <div className="space-y-5">
            <Benefit
              icon={ShieldCheck}
              title="Acceso seguro y centralizado"
              text="Login externo con validación de code y tenant. Sin credenciales adicionales."
            />
            <Benefit
              icon={Building2}
              title="Gestión multi-tenant"
              text="Una cuenta puede gestionar múltiples usuarios, ambientes y permisos granulares."
            />
            <Benefit
              icon={Users}
              title="Panel unificado"
              text="Funciones, secretos y despliegues organizados en un solo flujo coherente."
            />
          </div>

          <div className="mt-10 flex flex-wrap gap-3 text-sm text-slate-500">
            {["Sin tarjeta de crédito", "Azure ready", "Listo para producción"].map((item) => (
              <span key={item} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                {item}
              </span>
            ))}
          </div>
        </div>

        {/* Right: Auth card */}
        <div className="flex items-center justify-center">
          <div className="w-full">
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0d1117] p-8 shadow-2xl">
              {/* Subtle glow top */}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-500/40 to-transparent" />

              <div className="mb-8 flex items-center gap-3.5">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500 shadow-lg shadow-sky-500/30">
                  <Zap className="h-5 w-5 text-white" fill="currentColor" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">Function Platform</div>
                  <div className="text-xs text-slate-500">Acceso empresarial</div>
                </div>
              </div>

              <div className="mb-2 text-2xl font-bold tracking-tight text-white">
                Iniciar sesión
              </div>
              <p className="mb-8 text-sm leading-6 text-slate-400">
                Usa tu sistema de autenticación empresarial para entrar o registrar una cuenta nueva.
              </p>

              <div className="space-y-3">
                <a
                  href={loginUrl}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-sky-500 text-sm font-medium text-white shadow-lg shadow-sky-500/20 transition-all hover:bg-sky-400 hover:shadow-sky-400/30"
                >
                  Iniciar sesión
                  <ArrowRight className="h-4 w-4" />
                </a>
                <a
                  href={registerUrl}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] text-sm font-medium text-slate-300 transition-all hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
                >
                  Crear cuenta nueva
                </a>
              </div>

              <div className="my-7 h-px bg-white/[0.06]" />

              <div className="space-y-2.5">
                <div className="text-xs font-medium uppercase tracking-wider text-slate-600">
                  Por qué usar autenticación empresarial
                </div>
                <ul className="space-y-2 text-sm leading-relaxed text-slate-400">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    Cada cuenta crea o accede a un tenant propio.
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    El panel sincroniza usuarios, permisos y despliegues.
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    Funciones y secrets organizados por ambiente.
                  </li>
                </ul>
              </div>

              {ready && isAuthenticated && (
                <div className="mt-6 rounded-xl border border-emerald-500/20 bg-emerald-500/8 p-4">
                  <div className="text-sm font-medium text-emerald-300">Sesión activa</div>
                  <p className="mt-1 text-xs text-emerald-400/70">
                    Ya tienes una sesión activa en {accessLabel}.
                  </p>
                  <button
                    type="button"
                    onClick={() => router.replace("/dashboard")}
                    className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-xs font-medium text-emerald-300 transition-all hover:bg-emerald-500/20"
                  >
                    Ir al panel
                    <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            <div className="mt-4 text-center text-xs text-slate-600">
              <Link href="/" className="transition-colors hover:text-slate-400">
                ← Volver al inicio
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

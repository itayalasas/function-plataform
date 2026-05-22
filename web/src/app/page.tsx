import Link from "next/link";
import { ArrowRight, CheckCircle2, Cloud, KeyRound, Sparkles, ShieldCheck, Terminal } from "lucide-react";

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-cyan-200">
      {children}
    </span>
  );
}

function Feature({ icon: Icon, title, text }: { icon: any; title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-500/10 text-cyan-300">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-medium text-white">{title}</div>
          <div className="mt-1 text-xs leading-5 text-slate-400">{text}</div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden px-6 py-6 md:px-8 md:py-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(34,211,238,.20),transparent_22%),radial-gradient(circle_at_20%_70%,rgba(139,92,246,.14),transparent_26%),linear-gradient(180deg,rgba(255,255,255,.02),transparent_20%)]" />
      <div className="absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(52,211,153,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(52,211,153,.08)_1px,transparent_1px)] [background-size:42px_42px]" />

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="flex items-center justify-between gap-4 rounded-3xl border border-white/10 bg-[rgba(4,10,20,.72)] px-5 py-4 backdrop-blur-xl">
          <a href="/" className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-cyan-400 shadow-lg">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="text-lg font-semibold leading-none text-white">Function Platform</div>
              <div className="mt-1 text-xs text-slate-500">Multi-tenant functions for teams</div>
            </div>
          </a>
          <nav className="hidden items-center gap-8 text-sm text-slate-400 md:flex">
            <a href="#como-funciona" className="hover:text-white">Como funciona</a>
            <a href="#funcionalidades" className="hover:text-white">Funcionalidades</a>
            <a href="#login" className="hover:text-white">Login</a>
          </nav>
          <Link href="/login" className="btn-primary h-11">
            Inicia prueba gratis
            <ArrowRight className="h-4 w-4" />
          </Link>
        </header>

        <section className="grid gap-10 pt-8 lg:grid-cols-[1.1fr_.9fr] lg:items-center lg:pt-14">
          <div className="space-y-7">
            <Pill>Plataforma de desarrollo y despliegue</Pill>
            <div className="space-y-4">
              <h1 className="max-w-2xl text-5xl font-semibold tracking-tight text-white md:text-7xl">
                Gestiona funciones y despliegues con una experiencia limpia y profesional.
              </h1>
              <p className="max-w-2xl text-base leading-8 text-slate-300 md:text-lg">
                Function Platform centraliza código, secrets, logs y promociones entre ambientes para equipos que trabajan por tenant.
                El acceso se resuelve con tu proveedor empresarial de autenticación.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link href="/login" className="btn-primary h-12 px-5 text-base">
                Inicia prueba gratis
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a href="#funcionalidades" className="btn-ghost h-12 px-5 text-base">
                Ver funcionalidades
              </a>
            </div>

            <div className="flex flex-wrap gap-3 text-sm text-slate-400">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                Sin tarjeta
              </span>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                Login empresarial
              </span>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                Azure ready
              </span>
            </div>
          </div>

          <div className="relative">
            <div className="absolute -inset-10 rounded-[32px] bg-cyan-500/10 blur-3xl" />
            <div className="relative overflow-hidden rounded-[32px] border border-white/10 bg-[rgba(6,12,24,.82)] p-5 shadow-[0_30px_120px_rgba(0,0,0,.45)] backdrop-blur-xl">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-500/10 text-cyan-300">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white">Panel seguro</div>
                    <div className="text-xs text-slate-400">Tenant, funciones y promociones</div>
                  </div>
                </div>
                <span className="chip text-emerald-300 border-emerald-500/30">active</span>
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Funciones</div>
                  <div className="mt-2 text-4xl font-semibold text-white">23</div>
                  <div className="mt-2 text-xs text-emerald-300">running y homologadas</div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Ambientes</div>
                  <div className="mt-2 text-4xl font-semibold text-white">DEV / TEST / PROD</div>
                  <div className="mt-2 text-xs text-cyan-300">promoción controlada</div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-500">
                  <Terminal className="h-3.5 w-3.5 text-cyan-300" />
                  request / response logs
                </div>
                <div className="mt-3 space-y-2 font-mono text-[11px] leading-5 text-slate-300">
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-cyan-200">API_REQUEST {"{"} "request_id": "..." {"}"}</div>
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-emerald-200">API_RESPONSE {"{"} "status_code": 200 {"}"}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          id="como-funciona"
          className="grid gap-4 rounded-[28px] border border-white/10 bg-[rgba(6,12,24,.62)] p-5 backdrop-blur-xl md:grid-cols-3"
        >
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">01</div>
            <div className="mt-2 text-sm font-medium text-white">Creas tu tenant</div>
            <p className="mt-1 text-xs leading-6 text-slate-400">Tu cuenta queda asociada a una organización y a sus usuarios.</p>
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">02</div>
            <div className="mt-2 text-sm font-medium text-white">Inicias sesión</div>
            <p className="mt-1 text-xs leading-6 text-slate-400">El acceso se valida en tu sistema empresarial con un callback seguro.</p>
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-cyan-300">03</div>
            <div className="mt-2 text-sm font-medium text-white">Promueves tus funciones</div>
            <p className="mt-1 text-xs leading-6 text-slate-400">Código, secrets y despliegues viajan entre ambientes de forma homogénea.</p>
          </div>
        </section>

        <section id="funcionalidades" className="grid gap-4 pt-6 md:grid-cols-3">
          <Feature
            icon={KeyRound}
            title="Acceso por tenant"
            text="Cada cuenta crea o reutiliza un tenant y puede gestionar múltiples usuarios."
          />
          <Feature
            icon={Cloud}
            title="Deploys por ambiente"
            text="Las funciones viajan entre desarrollo, testing y producción de forma homogénea."
          />
          <Feature
            icon={ShieldCheck}
            title="Control empresarial"
            text="Login externo, validación de sesión y una base preparada para equipos."
          />
        </section>

        <section id="login" className="pt-2 pb-8">
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
            <span>¿Listo para entrar?</span>
            <Link href="/login" className="text-cyan-300 hover:text-cyan-200">
              Ir al login
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

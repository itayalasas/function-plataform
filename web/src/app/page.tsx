import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  KeyRound,
  ShieldCheck,
  Terminal,
  Zap,
  BarChart3,
  Lock,
  GitBranch,
} from "lucide-react";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="text-sm text-slate-400 transition-colors hover:text-white"
    >
      {children}
    </a>
  );
}

function StatCard({ value, label, sub }: { value: string; label: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1 border-l border-white/10 pl-6 first:border-0 first:pl-0">
      <div className="text-3xl font-bold tracking-tight text-white">{value}</div>
      <div className="text-sm font-medium text-slate-300">{label}</div>
      <div className="text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  description,
  accent,
}: {
  icon: any;
  title: string;
  description: string;
  accent: string;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/8 bg-white/[0.03] p-6 transition-all duration-300 hover:border-white/15 hover:bg-white/[0.05]">
      <div
        className="absolute right-0 top-0 h-32 w-32 rounded-full opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100"
        style={{ background: accent }}
      />
      <div
        className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl"
        style={{ background: `${accent}20` }}
      >
        <Icon className="h-5 w-5" style={{ color: accent }} />
      </div>
      <h3 className="mb-2 text-base font-semibold text-white">{title}</h3>
      <p className="text-sm leading-relaxed text-slate-400">{description}</p>
    </div>
  );
}

function StepCard({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <div className="relative flex gap-5">
      <div className="flex flex-col items-center">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-sky-500/30 bg-sky-500/10 text-sm font-bold text-sky-300">
          {number}
        </div>
        <div className="mt-2 h-full w-px bg-gradient-to-b from-sky-500/20 to-transparent" />
      </div>
      <div className="pb-8">
        <div className="text-sm font-semibold text-white">{title}</div>
        <p className="mt-1 text-sm leading-6 text-slate-400">{body}</p>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* Background */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 bg-[#080c14]" />
        <div className="absolute left-1/2 top-0 h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-sky-500/5 blur-[120px]" />
        <div className="absolute -right-40 top-1/3 h-[500px] w-[500px] rounded-full bg-emerald-500/4 blur-[100px]" />
        <div className="absolute inset-0 opacity-[0.03] [background-image:linear-gradient(rgba(255,255,255,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.5)_1px,transparent_1px)] [background-size:64px_64px]" />
      </div>

      <div className="relative z-10">
        {/* Nav */}
        <nav className="sticky top-0 z-50 border-b border-white/5 bg-[#080c14]/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <a href="/" className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500 shadow-lg shadow-sky-500/30">
                <Zap className="h-4 w-4 text-white" fill="currentColor" />
              </div>
              <span className="text-base font-semibold tracking-tight text-white">
                Function Platform
              </span>
            </a>

            <div className="hidden items-center gap-8 md:flex">
              <NavLink href="#features">Features</NavLink>
              <NavLink href="#how-it-works">Cómo funciona</NavLink>
              <NavLink href="#login">Acceso</NavLink>
            </div>

            <Link
              href="/login"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-500 px-4 text-sm font-medium text-white shadow-lg shadow-sky-500/25 transition-all hover:bg-sky-400 hover:shadow-sky-400/30"
            >
              Comenzar
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </nav>

        {/* Hero */}
        <section className="mx-auto max-w-7xl px-6 pb-24 pt-24 md:pt-32">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-sky-500/20 bg-sky-500/8 px-4 py-1.5 text-xs font-medium text-sky-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
              Plataforma multi-tenant · Azure ready
            </div>

            <h1 className="mb-6 text-5xl font-bold leading-[1.1] tracking-tight text-white md:text-7xl">
              Gestiona funciones y{" "}
              <span className="bg-gradient-to-r from-sky-300 to-cyan-200 bg-clip-text text-transparent">
                despliegues
              </span>{" "}
              sin fricciones
            </h1>

            <p className="mb-10 text-lg leading-relaxed text-slate-400">
              Centraliza código, secrets, logs y promociones entre ambientes para equipos que
              trabajan por tenant. Acceso validado con tu proveedor empresarial de autenticación.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/login"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-sky-500 px-6 text-base font-medium text-white shadow-xl shadow-sky-500/25 transition-all hover:bg-sky-400"
              >
                Iniciar prueba gratis
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="#features"
                className="inline-flex h-12 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-6 text-base font-medium text-slate-300 transition-all hover:border-white/20 hover:bg-white/8 hover:text-white"
              >
                Ver funcionalidades
              </a>
            </div>

            <div className="mt-8 flex flex-wrap justify-center gap-4 text-sm text-slate-500">
              {["Sin tarjeta de crédito", "Login empresarial incluido", "Listo para producción"].map(
                (item) => (
                  <span key={item} className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    {item}
                  </span>
                )
              )}
            </div>
          </div>

          {/* Hero visual */}
          <div className="relative mx-auto mt-20 max-w-5xl">
            <div className="absolute -inset-1 rounded-3xl bg-gradient-to-b from-sky-500/10 to-transparent blur-2xl" />
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl">
              {/* Window chrome */}
              <div className="flex items-center gap-2 border-b border-white/8 bg-white/[0.02] px-5 py-3.5">
                <div className="h-3 w-3 rounded-full bg-white/10" />
                <div className="h-3 w-3 rounded-full bg-white/10" />
                <div className="h-3 w-3 rounded-full bg-white/10" />
                <div className="ml-4 flex-1 rounded-md bg-white/5 px-3 py-1 text-center text-xs text-slate-500">
                  platform.example.com / dashboard
                </div>
              </div>

              <div className="grid gap-4 p-6 md:grid-cols-3">
                <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs font-medium uppercase tracking-wider text-slate-500">Funciones</span>
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">active</span>
                  </div>
                  <div className="text-3xl font-bold text-white">23</div>
                  <div className="mt-1 text-xs text-slate-500">running · homologadas</div>
                </div>

                <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">Ambientes</div>
                  <div className="space-y-1.5">
                    {["DEV", "TEST", "PROD"].map((env) => (
                      <div key={env} className="flex items-center justify-between">
                        <span className="text-xs font-mono text-slate-300">{env}</span>
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/5">
                          <div
                            className="h-full rounded-full bg-sky-400"
                            style={{ width: env === "PROD" ? "70%" : env === "TEST" ? "85%" : "100%" }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                    <Terminal className="h-3.5 w-3.5 text-sky-400" />
                    Logs
                  </div>
                  <div className="space-y-1.5 font-mono text-[10px]">
                    <div className="rounded-lg bg-black/30 px-2.5 py-1.5 text-sky-200">
                      ↗ REQUEST 200 /api/fn/exec
                    </div>
                    <div className="rounded-lg bg-black/30 px-2.5 py-1.5 text-emerald-200">
                      ✓ RESPONSE 15ms OK
                    </div>
                    <div className="rounded-lg bg-black/30 px-2.5 py-1.5 text-slate-400">
                      … 3 more entries
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="border-y border-white/5 bg-white/[0.015]">
          <div className="mx-auto max-w-7xl px-6 py-12">
            <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
              <StatCard value="99.9%" label="Uptime garantizado" sub="SLA empresarial" />
              <StatCard value="<50ms" label="Latencia promedio" sub="En funciones optimizadas" />
              <StatCard value="3 envs" label="DEV / TEST / PROD" sub="Promoción controlada" />
              <StatCard value="Multi" label="Tenant nativo" sub="Usuarios y permisos" />
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="mx-auto max-w-7xl px-6 py-24">
          <div className="mb-12 text-center">
            <div className="mb-3 text-sm font-medium uppercase tracking-widest text-sky-400">
              Funcionalidades
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-white md:text-4xl">
              Todo lo que necesita tu equipo
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-slate-400">
              Desde el primer commit hasta producción, Function Platform cubre cada paso del ciclo de vida de tus funciones.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              icon={KeyRound}
              title="Acceso por tenant"
              description="Cada cuenta crea o reutiliza un tenant y puede gestionar múltiples usuarios con roles y permisos granulares."
              accent="#38bdf8"
            />
            <FeatureCard
              icon={GitBranch}
              title="Deploys por ambiente"
              description="Las funciones viajan entre desarrollo, testing y producción con un flujo de promoción homogéneo y rastreable."
              accent="#34d399"
            />
            <FeatureCard
              icon={ShieldCheck}
              title="Control empresarial"
              description="Login externo, validación de sesión y una base preparada para equipos con autenticación corporativa."
              accent="#60a5fa"
            />
            <FeatureCard
              icon={Lock}
              title="Secrets por ambiente"
              description="Gestiona variables de entorno y secrets de forma segura, diferenciada por tenant y por ambiente de despliegue."
              accent="#fb923c"
            />
            <FeatureCard
              icon={BarChart3}
              title="Logs en tiempo real"
              description="Visualiza request, response y errores de cada función con filtros por tenant, función y rango temporal."
              accent="#a78bfa"
            />
            <FeatureCard
              icon={Cloud}
              title="Azure container apps"
              description="Infraestructura lista para Azure Container Apps con despliegue automatizado y escalado configurable."
              accent="#22d3ee"
            />
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="mx-auto max-w-7xl px-6 py-24">
          <div className="grid items-start gap-16 lg:grid-cols-2">
            <div>
              <div className="mb-3 text-sm font-medium uppercase tracking-widest text-sky-400">
                Proceso
              </div>
              <h2 className="mb-4 text-3xl font-bold tracking-tight text-white md:text-4xl">
                Tres pasos para empezar
              </h2>
              <p className="text-slate-400">
                Desde el registro hasta el primer despliegue en producción, el proceso es claro, rápido y sin fricción.
              </p>
            </div>

            <div className="mt-2">
              <StepCard
                number="01"
                title="Creas tu tenant"
                body="Tu cuenta queda asociada a una organización y sus usuarios. Configuras ambientes, permisos y secrets desde el panel."
              />
              <StepCard
                number="02"
                title="Inicias sesión"
                body="El acceso se valida en tu sistema empresarial mediante un callback seguro. Sin credenciales adicionales, sin fricciones."
              />
              <StepCard
                number="03"
                title="Promueves tus funciones"
                body="Código, secrets y despliegues viajan entre ambientes de forma homogénea. Un clic para promover de TEST a PROD."
              />
            </div>
          </div>
        </section>

        {/* CTA */}
        <section id="login" className="mx-auto max-w-7xl px-6 pb-24">
          <div className="relative overflow-hidden rounded-3xl border border-sky-500/15 bg-gradient-to-br from-sky-500/8 via-transparent to-transparent p-12 text-center">
            <div className="absolute inset-0 [background-image:linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:40px_40px]" />
            <div className="relative">
              <h2 className="mb-4 text-3xl font-bold tracking-tight text-white md:text-4xl">
                ¿Listo para empezar?
              </h2>
              <p className="mx-auto mb-8 max-w-md text-slate-400">
                Accede con tu sistema empresarial de autenticación. Sin tarjeta, sin configuración compleja.
              </p>
              <Link
                href="/login"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-sky-500 px-8 text-base font-medium text-white shadow-xl shadow-sky-500/25 transition-all hover:bg-sky-400"
              >
                Ir al login
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-white/5 py-8">
          <div className="mx-auto max-w-7xl px-6">
            <div className="flex flex-col items-center justify-between gap-4 text-sm text-slate-600 sm:flex-row">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded bg-sky-500/80">
                  <Zap className="h-3 w-3 text-white" fill="currentColor" />
                </div>
                <span>Function Platform</span>
              </div>
              <span>Multi-tenant functions for enterprise teams</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

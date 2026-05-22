import { headers } from "next/headers";
import { Sparkles } from "lucide-react";
import { LoginPanel } from "@/components/LoginPanel";
import { buildExternalAuthUrl, resolveExternalAuthConfig } from "@/lib/auth";

function getOrigin() {
  const headerList = headers();
  const host = headerList.get("x-forwarded-host") || headerList.get("host") || "localhost:3000";
  const proto = headerList.get("x-forwarded-proto") || (host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export default function LoginPage() {
  const config = resolveExternalAuthConfig(getOrigin());
  const loginUrl = buildExternalAuthUrl("login", config);
  const registerUrl = buildExternalAuthUrl("register-tenant", config);

  return (
    <div className="relative min-h-screen overflow-hidden px-6 py-6 md:px-8 md:py-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(34,211,238,.16),transparent_28%),radial-gradient(circle_at_80%_0%,rgba(139,92,246,.12),transparent_24%),linear-gradient(180deg,rgba(255,255,255,.025),transparent_18%)]" />
      <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(34,211,238,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,.08)_1px,transparent_1px)] [background-size:38px_38px]" />

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="flex items-center justify-between gap-4">
          <a href="/" className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-cyan-400 shadow-lg">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="text-lg font-semibold leading-none">Function Platform</div>
              <div className="mt-1 text-xs text-slate-500">Acceso empresarial y multi-tenant</div>
            </div>
          </a>
          <a href="/" className="btn-ghost h-10">
            Volver al inicio
          </a>
        </header>

        <main className="pt-6 md:pt-10">
          <LoginPanel loginUrl={loginUrl} registerUrl={registerUrl} />
        </main>
      </div>
    </div>
  );
}

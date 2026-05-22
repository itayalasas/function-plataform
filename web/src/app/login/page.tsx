import { headers } from "next/headers";
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
    <div className="relative min-h-screen overflow-hidden">
      {/* Background */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 bg-[#080c14]" />
        <div className="absolute left-1/4 top-0 h-[500px] w-[700px] -translate-x-1/2 rounded-full bg-sky-500/5 blur-[120px]" />
        <div className="absolute right-0 top-1/2 h-[400px] w-[500px] -translate-y-1/2 rounded-full bg-emerald-500/3 blur-[100px]" />
        <div className="absolute inset-0 opacity-[0.025] [background-image:linear-gradient(rgba(255,255,255,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.5)_1px,transparent_1px)] [background-size:56px_56px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-6 py-8">
        <main>
          <LoginPanel loginUrl={loginUrl} registerUrl={registerUrl} />
        </main>
      </div>
    </div>
  );
}

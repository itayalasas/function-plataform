"use client";

import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { useAuth } from "@/components/AuthProvider";

const PUBLIC_ROUTES = new Set(["/", "/callback", "/login"]);

function isPublicRoute(pathname: string) {
  return PUBLIC_ROUTES.has(pathname);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { ready, isAuthenticated } = useAuth();

  const publicRoute = isPublicRoute(pathname);

  useEffect(() => {
    if (publicRoute || !ready) return;
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, pathname, publicRoute, ready, router]);

  if (publicRoute) {
    return <>{children}</>;
  }

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          Cargando acceso...
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          Redirigiendo al login...
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen w-full">
      <Sidebar />
      <main className="flex-1 min-w-0 px-8 py-7">
        <div className="max-w-[1500px] mx-auto">{children}</div>
      </main>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { normalizeAuthSession, storeAuthSession, type AuthExchangeResponse } from "@/lib/auth";

type Props = {
  appId: string;
};

type CallbackState = {
  loading: boolean;
  error: string | null;
  success: string | null;
};

export function AuthCallbackClient({ appId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = useMemo(() => searchParams.get("code") || "", [searchParams]);
  const state = useMemo(() => searchParams.get("state") || "", [searchParams]);
  const [view, setView] = useState<CallbackState>({ loading: true, error: null, success: null });

  useEffect(() => {
    let cancelled = false;

    async function exchange() {
      if (!code) {
        if (!cancelled) {
          setView({ loading: false, error: "La respuesta no incluye code.", success: null });
        }
        return;
      }

      if (state !== "authenticated") {
        if (!cancelled) {
          setView({
            loading: false,
            error: state
              ? `Estado invalido recibido desde el proveedor: ${state}.`
              : "La respuesta de autenticacion no incluye state.",
            success: null,
          });
        }
        window.setTimeout(() => {
          router.replace("/login");
        }, 1200);
        return;
      }

      try {
        const response = await fetch("/api/auth/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, application_id: appId }),
          cache: "no-store",
        });
        const payload = (await response.json()) as AuthExchangeResponse & { error?: string; message?: string };

        if (!response.ok) {
          throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
        }

        const session = normalizeAuthSession(payload);
        if (!session) {
          throw new Error("La respuesta del login no incluyo una sesion valida.");
        }

        storeAuthSession(session);
        console.info("[auth callback]", {
          tenantId: session.tenant?.id || null,
          tenantName: session.tenant?.name || null,
          userId: session.user?.id || null,
          userEmail: session.user?.email || null,
          applicationId: session.application?.id || null,
        });

        if (!cancelled) {
          setView({
            loading: false,
            error: null,
            success: `${session.user?.name || "Sesion"} autenticada correctamente en ${session.tenant?.name || "el tenant"}.`,
          });
          window.setTimeout(() => {
            router.replace("/dashboard");
          }, 700);
        }
      } catch (error: any) {
        if (!cancelled) {
          setView({
            loading: false,
            error: error?.message || "No se pudo completar el login.",
            success: null,
          });
        }
      }
    }

    exchange();
    return () => {
      cancelled = true;
    };
  }, [appId, code, router, state]);

  return (
    <div className="min-h-screen px-6 py-10">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 rounded-3xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-cyan-500/15 text-cyan-300">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Autenticacion externa</div>
            <h1 className="text-2xl font-semibold tracking-tight">Validando acceso</h1>
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--border)] bg-black/20 p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="chip text-cyan-200 border-cyan-500/30">callback</span>
            {state && <span className="chip text-violet-200 border-violet-500/30">state: {state}</span>}
            {code && <span className="chip text-slate-200 border-slate-500/30">code recibido</span>}
          </div>

          <div className="mt-4 flex items-start gap-3">
            {view.loading ? <Loader2 className="mt-1 h-5 w-5 animate-spin text-cyan-300" /> : view.error ? <AlertTriangle className="mt-1 h-5 w-5 text-rose-300" /> : <CheckCircle2 className="mt-1 h-5 w-5 text-emerald-300" />}
            <div className="min-w-0 flex-1">
              <div className="text-lg font-medium">
                {view.loading ? "Conectando con el sistema de login..." : view.error ? "No pudimos completar el acceso" : "Acceso completado"}
              </div>
              <p className="mt-1 text-sm text-slate-400">
                {view.loading
                  ? "Estamos intercambiando el code por una sesion de tenant y preparando el panel."
                  : view.error
                    ? view.error
                    : view.success}
              </p>
            </div>
          </div>

          {view.error && (
            <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100">
              {view.error}
            </div>
          )}

          {!view.loading && !view.error && (
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" onClick={() => router.replace("/dashboard")} className="btn-primary">
                <ShieldCheck className="h-4 w-4" />
                Ir al panel
              </button>
              <Link href="/" className="btn-ghost">
                Volver al inicio
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

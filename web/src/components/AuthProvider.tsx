"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AUTH_SESSION_EVENT, normalizeAuthSession, readStoredAuthSession, storeAuthSession, type AuthSession } from "@/lib/auth";

type AuthContextValue = {
  ready: boolean;
  session: AuthSession | null;
  user: AuthSession["user"] | null;
  tenant: AuthSession["tenant"] | null;
  isAuthenticated: boolean;
  setSession: (session: AuthSession | null) => void;
  signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setSessionState(readStoredAuthSession());
    sync();
    setReady(true);

    window.addEventListener("storage", sync);
    window.addEventListener(AUTH_SESSION_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(AUTH_SESSION_EVENT, sync);
    };
  }, []);

  const setSession = useCallback((next: AuthSession | null) => {
    const normalized = next ? normalizeAuthSession(next) : null;
    setSessionState(normalized);
    storeAuthSession(normalized);
  }, []);

  const signOut = useCallback(() => {
    setSession(null);
  }, [setSession]);

  const value = useMemo<AuthContextValue>(() => ({
    ready,
    session,
    user: session?.user || null,
    tenant: session?.tenant || null,
    isAuthenticated: Boolean(session?.access_token),
    setSession,
    signOut,
  }), [ready, session, setSession, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth debe usarse dentro de AuthProvider");
  }
  return ctx;
}


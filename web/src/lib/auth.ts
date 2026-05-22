export type AuthPermissionMap = Record<string, string[]>;

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role?: string;
  permissions?: AuthPermissionMap;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

export type AuthTenant = {
  id: string;
  name: string;
  owner_user_id?: string;
  owner_email?: string;
  organization_name?: string;
  status?: string;
};

export type AuthApplication = {
  id: string;
};

export type AuthSession = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  user?: AuthUser;
  tenant?: AuthTenant;
  application?: AuthApplication;
  has_access?: boolean;
  available_plans?: string[];
  received_at?: string;
};

export type AuthExchangeResponse =
  | { success?: boolean; data?: AuthSession; error?: string; message?: string }
  | AuthSession;

export type ExternalAuthConfig = {
  authUrl: string;
  appId: string;
  publicApiKey: string;
  redirectUri: string;
};

export const AUTH_STORAGE_KEY = "function-platform.auth.session";
export const AUTH_SESSION_EVENT = "function-platform.auth.session-change";

function readEnv(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key];
    if (value && String(value).trim()) return String(value).trim();
  }
  return "";
}

function decodeBase64Url(input: string) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  if (typeof atob === "function") {
    return atob(padded);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf8");
  }
  throw new Error("No hay decodificador base64 disponible");
}

type JwtPayload = Record<string, any>;

function decodeJwtPayload(token?: string | null): JwtPayload | null {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function normalizeTenantFromPayload(tenantLike: any): AuthTenant | null {
  if (!tenantLike || typeof tenantLike !== "object") return null;
  const id = String(
    tenantLike.id ||
    tenantLike.tenant_id ||
    tenantLike.tenantId ||
    tenantLike.tid ||
    ""
  ).trim();
  if (!id) return null;
  return {
    id,
    name: String(tenantLike.name || tenantLike.organization_name || tenantLike.organizationName || id).trim() || id,
    owner_user_id: tenantLike.owner_user_id || tenantLike.ownerUserId || undefined,
    owner_email: tenantLike.owner_email || tenantLike.ownerEmail || undefined,
    organization_name: tenantLike.organization_name || tenantLike.organizationName || undefined,
    status: tenantLike.status || undefined,
  };
}

function tenantFromJwt(token?: string | null): AuthTenant | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const embedded = normalizeTenantFromPayload(payload.tenant);
  if (embedded) return embedded;

  const id = String(payload.tenant_id || payload.tenantId || payload.tid || "").trim();
  if (!id) return null;

  return {
    id,
    name: String(payload.tenant_name || payload.tenantName || payload.organization_name || payload.organizationName || id).trim() || id,
    owner_user_id: payload.owner_user_id || payload.ownerUserId || undefined,
    owner_email: payload.owner_email || payload.ownerEmail || undefined,
    organization_name: payload.organization_name || payload.organizationName || undefined,
    status: payload.tenant_status || payload.status || undefined,
  };
}

function isLocalHostUrl(value: string) {
  return /(^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$))|(^https?:\/\/[^/]+\.local(\/|$))/i.test(String(value || "").trim());
}

export function resolveExternalAuthConfig(origin: string, environmentSlug?: string | null): ExternalAuthConfig {
  void environmentSlug;
  const authUrl = readEnv("AUTH_URL", "NEXT_PUBLIC_AUTH_URL", "VITE_AUTH_URL");
  const appId = readEnv("AUTH_APP_ID", "NEXT_PUBLIC_AUTH_APP_ID", "VITE_AUTH_APP_ID");
  const publicApiKey = readEnv("AUTH_PUBLIC_API_KEY", "NEXT_PUBLIC_AUTH_PUBLIC_API_KEY", "VITE_AUTH_PUBLIC_API_KEY");
  const fallbackRedirectUri = new URL("/callback", origin).toString();
  const configuredRedirectUri = readEnv("AUTH_REDIRECT_URI", "NEXT_PUBLIC_AUTH_REDIRECT_URI", "VITE_REDIRECT_URI");
  const isLocalOrigin = isLocalHostUrl(origin);

  let redirectUri = fallbackRedirectUri;

  if (!isLocalOrigin) {
    redirectUri = configuredRedirectUri || fallbackRedirectUri;
    if (isLocalHostUrl(redirectUri)) {
      redirectUri = fallbackRedirectUri;
    }
  } else if (configuredRedirectUri && isLocalHostUrl(configuredRedirectUri)) {
    redirectUri = configuredRedirectUri;
  }

  return {
    authUrl: authUrl.replace(/\/+$/, ""),
    appId,
    publicApiKey,
    redirectUri,
  };
}

export function buildExternalAuthUrl(kind: "login" | "register-tenant", config: ExternalAuthConfig) {
  const params = new URLSearchParams();
  params.set("app_id", config.appId);
  params.set("redirect_uri", config.redirectUri);
  params.set("api_key", config.publicApiKey);
  return `${config.authUrl}/${kind}?${params.toString()}`;
}

export function normalizeAuthSession(input: AuthExchangeResponse | null | undefined): AuthSession | null {
  if (!input) return null;
  const session = ("data" in input ? input.data : input) as AuthSession | undefined;
  if (!session?.access_token) return null;
  const payload = decodeJwtPayload(session.access_token);
  const payloadTenant = tenantFromJwt(session.access_token);
  const payloadApplication = payload?.app_id || payload?.application_id;
  return {
    ...session,
    tenant: session.tenant || payloadTenant || undefined,
    application: session.application || (payloadApplication ? { id: String(payloadApplication) } : undefined),
    received_at: session.received_at || new Date().toISOString(),
  };
}

export function readStoredAuthSession(): AuthSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    return normalizeAuthSession(parsed);
  } catch {
    return null;
  }
}

export function storeAuthSession(session: AuthSession | null) {
  if (typeof window === "undefined") return;
  if (!session) {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  } else {
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(normalizeAuthSession(session)));
  }
  window.dispatchEvent(new Event(AUTH_SESSION_EVENT));
}

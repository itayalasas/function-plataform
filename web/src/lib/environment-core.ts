import { API } from "./api";

export type EnvironmentSlug = "dev" | "test" | "prod";

const ENVIRONMENT_FLOW: EnvironmentSlug[] = ["dev", "test", "prod"];

function normalizeEnvironmentSlug(value?: string | null): EnvironmentSlug | null {
  const text = String(value || "").trim().toLowerCase();
  if (text === "development") return "dev";
  if (text === "testing") return "test";
  if (text === "production") return "prod";
  return ENVIRONMENT_FLOW.includes(text as EnvironmentSlug) ? (text as EnvironmentSlug) : null;
}

function tokenMatch(text: string, token: string) {
  return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(text);
}

export function inferCurrentEnvironmentSlug(): EnvironmentSlug {
  const configured = normalizeEnvironmentSlug(
    process.env.NEXT_PUBLIC_ENVIRONMENT ||
    process.env.NEXT_PUBLIC_APP_ENV ||
    process.env.NEXT_PUBLIC_PLATFORM_ENVIRONMENT
  );
  const samples = [API];
  if (typeof window !== "undefined") {
    samples.push(window.location.hostname, window.location.href);
  }
  const text = samples.filter(Boolean).join(" ").toLowerCase();

  if (/(^|[^a-z0-9])(localhost|127\.0\.0\.1|0\.0\.0\.0)([^a-z0-9]|$)/i.test(text)) {
    return configured || "dev";
  }
  if (tokenMatch(text, "prod") || tokenMatch(text, "production")) return "prod";
  if (tokenMatch(text, "test") || tokenMatch(text, "testing")) return "test";
  if (tokenMatch(text, "dev") || tokenMatch(text, "development")) return "dev";
  return configured || "dev";
}

export function nextEnvironmentSlug(slug: EnvironmentSlug | string | null | undefined): EnvironmentSlug | null {
  const current = normalizeEnvironmentSlug(slug);
  if (!current) return null;
  const index = ENVIRONMENT_FLOW.indexOf(current);
  return index >= 0 ? ENVIRONMENT_FLOW[index + 1] || null : null;
}

export function environmentLabel(slug: EnvironmentSlug | string | null | undefined) {
  const normalized = normalizeEnvironmentSlug(slug);
  if (normalized === "dev") return "Development";
  if (normalized === "test") return "Testing";
  if (normalized === "prod") return "Production";
  return "Ambiente";
}

export function environmentQuery(slug: EnvironmentSlug | string, params: Record<string, string | undefined | null> = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) qs.set(key, value);
  }
  qs.set("environment_slug", String(slug));
  const text = qs.toString();
  return text ? `?${text}` : "";
}


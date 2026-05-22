import { readStoredAuthSession } from "./auth";

export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const session = readStoredAuthSession();
  const headers: HeadersInit = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...(session?.access_token
      ? {
          Authorization: `Bearer ${session.access_token}`,
          "X-Tenant-ID": session.tenant?.id || "",
          "X-Application-ID": session.application?.id || "",
          "X-User-ID": session.user?.id || "",
        }
      : {}),
    ...(init?.headers || {}),
  };

  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch (error: any) {
    throw new Error(error?.message || "No se pudo conectar con el API");
  }

  if (!res.ok) {
    const text = await res.text();
    let message = text || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error || parsed.message || message;
    } catch {
      message = text || message;
    }
    throw new Error(message);
  }

  return res.json();
}


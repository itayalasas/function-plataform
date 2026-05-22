import { NextRequest, NextResponse } from "next/server";

function readEnv(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key];
    if (value && String(value).trim()) return String(value).trim();
  }
  return "";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const code = String(body?.code || "").trim();
    const applicationId = String(body?.application_id || body?.app_id || readEnv("AUTH_APP_ID", "NEXT_PUBLIC_AUTH_APP_ID", "VITE_AUTH_APP_ID")).trim();
    const exchangeUrl = readEnv(
      "AUTH_VALIDATE_TOKEN",
      "NEXT_PUBLIC_AUTH_VALIDATE_TOKEN",
      "VITE_AUTH_VALIDATE_TOKEN",
      "AUTH_EXCHANGE_CODE_URL",
      "NEXT_PUBLIC_AUTH_EXCHANGE_CODE_URL",
      "VITE_AUTH_EXCHANGE_CODE_URL",
    );

    if (!code) {
      return NextResponse.json({ error: "Falta el code de autenticacion" }, { status: 400 });
    }
    if (!applicationId) {
      return NextResponse.json({ error: "Falta el application_id" }, { status: 400 });
    }
    if (!exchangeUrl) {
      return NextResponse.json({ error: "AUTH_VALIDATE_TOKEN no esta configurado" }, { status: 500 });
    }

    const response = await fetch(exchangeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Integration-Key": readEnv("AUTH_API_KEY", "NEXT_PUBLIC_AUTH_API_KEY", "VITE_AUTH_API_KEY"),
      },
      body: JSON.stringify({ code, application_id: applicationId }),
      cache: "no-store",
    });

    const text = await response.text();
    let payload: any = text;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const message = typeof payload === "object" && payload
        ? payload.error || payload.message || `HTTP ${response.status}`
        : String(payload || `HTTP ${response.status}`);
      return NextResponse.json({ error: message }, { status: response.status });
    }

    return NextResponse.json(payload);
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "No se pudo validar el token" },
      { status: 500 }
    );
  }
}

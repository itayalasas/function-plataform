import { headers } from "next/headers";
import { AuthCallbackClient } from "@/components/AuthCallbackClient";
import { resolveExternalAuthConfig } from "@/lib/auth";

function getOrigin() {
  const headerList = headers();
  const host = headerList.get("x-forwarded-host") || headerList.get("host") || "localhost:3000";
  const proto = headerList.get("x-forwarded-proto") || (host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

export default function CallbackPage() {
  const config = resolveExternalAuthConfig(getOrigin());

  return <AuthCallbackClient appId={config.appId} />;
}

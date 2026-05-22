import { AsyncLocalStorage } from "node:async_hooks";

const requestContext = new AsyncLocalStorage();

function decodeJwtPayload(token = "") {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function tenantIdFromAuthorization(authorization = "") {
  const value = String(authorization || "").trim();
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : value;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return null;
  return String(
    payload?.tenant?.id ||
    payload?.tenant_id ||
    payload?.tid ||
    ""
  ).trim() || null;
}

export function setRequestContext(context = {}) {
  const tenantFromAuth = context.tenantId || tenantIdFromAuthorization(context.authorization);
  requestContext.enterWith({
    tenantId: String(tenantFromAuth || "").trim() || null,
    userId: String(context.userId || "").trim() || null,
    applicationId: String(context.applicationId || "").trim() || null,
  });
}

export function getRequestContext() {
  return requestContext.getStore() || {};
}

export function getRequestTenantId() {
  const ctx = getRequestContext();
  return String(ctx.tenantId || process.env.DEFAULT_TENANT_ID || process.env.FPM_DEFAULT_TENANT_ID || "").trim() || null;
}

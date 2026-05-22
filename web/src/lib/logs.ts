export type StructuredApiLog = {
  timestamp?: string;
  log_level?: string;
  type?: string;
  request_id?: string;
  method?: string;
  path?: string;
  client_ip?: string | null;
  headers?: Record<string, unknown>;
  body?: unknown;
  status_code?: number;
  latency_ms?: number;
  response_body?: unknown;
  error?: string | null;
};

export type ParsedLogEntry = {
  level: "INFO" | "WARNING" | "ERROR";
  tx: string;
  method: string;
  path: string;
  status: string;
  duration: string;
  raw: string;
  structured: StructuredApiLog | null;
  pretty?: string;
};

export type LogEntry = { message: string; ts?: string };

function isStructuredJson(message: string) {
  const trimmed = String(message || "").trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function tryParseStructuredLog(message: string): StructuredApiLog | null {
  if (!isStructuredJson(message)) return null;
  try {
    const parsed = JSON.parse(message);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function levelFromStructuredLog(log: StructuredApiLog): ParsedLogEntry["level"] {
  const explicit = String(log.log_level || "").toUpperCase();
  if (explicit === "ERROR" || explicit === "WARNING" || explicit === "INFO") return explicit;
  const status = Number(log.status_code || 0);
  if (status >= 500) return "ERROR";
  if (status >= 400) return "WARNING";
  if (log.error) return "ERROR";
  return "INFO";
}

function levelFromMessage(message: string): ParsedLogEntry["level"] {
  const lower = message.toLowerCase();
  const status = /(?:\[request\].*->\s+|\bstatus=)(\d{3})/.exec(message)?.[1];
  if (/\[console:error\]|\[deploy:error\]|\[validation:error\]|\[validation:failed\]|error/.test(lower)) return "ERROR";
  if (status && Number(status) >= 500) return "ERROR";
  if (/\[console:warn\]|\[validation:warning\]|\[validation:ai:warning\]|\[auth\]|warn|warning/.test(lower)) return "WARNING";
  if (status && Number(status) >= 400) return "WARNING";
  if (/\[request|\[deploy:|\[validation:|\[console:log\]|\[fn\]/.test(lower)) return "INFO";
  return "INFO";
}

function txFromMessage(message: string) {
  return /\btx=([A-Za-z0-9_-]+)/.exec(message)?.[1] || /\[tx:([^\]]+)\]/.exec(message)?.[1] || "";
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function logEntryKey(entry: LogEntry) {
  return `${entry.ts || ""}::${entry.message || ""}`;
}

export function mergeLogEntries(current: LogEntry[], incoming: LogEntry[], limit = 1000) {
  const seen = new Set<string>();
  const merged: LogEntry[] = [];
  for (const entry of [...current, ...incoming]) {
    const key = logEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.slice(-limit);
}

export function parseLogEntry(entry: LogEntry | string): ParsedLogEntry {
  const message = typeof entry === "string" ? entry : entry?.message || "";
  const structured = tryParseStructuredLog(message);

  if (structured) {
    const tx = String(structured.request_id || "");
    const method = String(structured.method || "");
    const path = String(structured.path || "");
    const status = structured.status_code != null ? String(structured.status_code) : "";
    const duration = structured.latency_ms != null ? String(structured.latency_ms) : "";
    return {
      level: levelFromStructuredLog(structured),
      tx,
      method,
      path,
      status,
      duration,
      raw: message,
      structured,
      pretty: prettyJson(structured),
    };
  }

  const structuredRequest = /\[request[^\]]*\]\s+.*?\bmethod=([A-Z]+)\s+\bpath=([^\s]+)\s+\bstatus=(\d{3})\s+\bduration_ms=(\d+)/.exec(message);
  const legacyRequest = /\[request\]\s+([A-Z]+)\s+(.+?)\s+->\s+(\d{3})\s+(\d+)ms/.exec(message);
  const method = structuredRequest?.[1] || legacyRequest?.[1] || "";
  const path = structuredRequest?.[2] || legacyRequest?.[2] || "";
  const status = structuredRequest?.[3] || legacyRequest?.[3] || "";
  const duration = structuredRequest?.[4] || legacyRequest?.[4] || "";

  return {
    level: levelFromMessage(message),
    tx: txFromMessage(message),
    method,
    path,
    status,
    duration,
    raw: message,
    structured: null,
  };
}

export function isStructuredApiLog(message: string) {
  return Boolean(tryParseStructuredLog(message));
}

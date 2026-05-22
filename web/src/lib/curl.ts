type ApiToken = { value?: string | null };
type SourceFile = { path?: string | null; content?: string | null };

type CurlFunction = {
  url?: string | null;
  code?: string | null;
  files?: SourceFile[] | null;
  entrypoint?: string | null;
  runtime?: string | null;
  auth_required?: boolean;
  auth_header_name?: string | null;
  api_tokens?: ApiToken[];
};

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const COMMON_HEADERS = new Set(["accept", "content-type", "authorization", "host", "user-agent"]);

function escapeDoubleQuoted(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function shellSingleQuoted(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sourceText(fn: CurlFunction) {
  const files = fn.files?.length ? fn.files : [{ path: fn.entrypoint || "index.mjs", content: fn.code || "" }];
  return files.map((file) => `--- ${file.path || "index"} ---\n${file.content || ""}`).join("\n\n");
}

function addMatch(set: Set<string>, text: string, regex: RegExp, group = 1) {
  for (const match of text.matchAll(regex)) {
    const value = String(match[group] || "").trim();
    if (value) set.add(value);
  }
}

function inferMethod(text: string) {
  const methods = ["POST", "PUT", "PATCH", "DELETE", "GET"];
  for (const method of methods) {
    const pattern = new RegExp(`\\b(?:req|request)\\.method\\s*(?:={2,3}|!==?)\\s*["'\`]${method}["'\`]`, "i");
    if (pattern.test(text)) return method;
  }
  const python = /\["method"\]\s*(?:={2,3}|!==?)\s*["'](POST|PUT|PATCH|DELETE|GET)["']/i.exec(text);
  if (python?.[1]) return python[1].toUpperCase();
  if (/\bawait\s+(?:req|request)\.json\s*\(/i.test(text)) return "POST";
  return "GET";
}

function inferQueryParams(text: string) {
  const params = new Set<string>();
  addMatch(params, text, /\.searchParams\.get\(\s*["'`]([^"'`]+)["'`]\s*\)/g);
  addMatch(params, text, /\bquery(?:\(|\.get\(\s*)["'`]([^"'`]+)["'`]/g);
  addMatch(params, text, /\["query"\]\.get\(\s*["']([^"']+)["']\s*\)/g);
  addMatch(params, text, /\["query"\]\s*,\s*\{\}\)\.get\(\s*["']([^"']+)["']\s*,/g);
  return [...params].filter((param) => /^[A-Za-z0-9_.-]+$/.test(param)).slice(0, 8);
}

function inferHeaders(text: string) {
  const headers = new Set<string>();
  addMatch(headers, text, /\.headers\.get\(\s*["'`]([^"'`]+)["'`]\s*\)/g);
  addMatch(headers, text, /\.headers\s*\[\s*["'`]([^"'`]+)["'`]\s*\]/g);
  addMatch(headers, text, /\["headers"\]\.get\(\s*["']([^"']+)["']\s*\)/g);
  return [...headers]
    .map((header) => header.toLowerCase())
    .filter((header) => !COMMON_HEADERS.has(header) && !header.startsWith("x-forwarded-"))
    .slice(0, 8);
}

function bodyObjectFromDestructure(text: string) {
  const match = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\s+(?:req|request)\.json\s*\(/m.exec(text);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim().split(/[:=]/)[0].trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

function inferBodyFields(text: string) {
  const fields = new Set<string>(bodyObjectFromDestructure(text));
  const bodyVars = new Set<string>();

  for (const match of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:req|request)\.json\s*\(/g)) {
    bodyVars.add(match[1]);
  }
  for (const match of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:req|request)\.json\s*\(/g)) {
    bodyVars.add(match[1]);
  }
  if (bodyVars.size === 0 && /\bawait\s+(?:req|request)\.json\s*\(/.test(text)) bodyVars.add("body");

  for (const bodyVar of bodyVars) {
    addMatch(fields, text, new RegExp(`\\b${bodyVar}\\.([A-Za-z_$][\\w$]*)`, "g"));
    addMatch(fields, text, new RegExp(`\\b${bodyVar}\\s*\\[\\s*["'\`]([^"'\`]+)["'\`]\\s*\\]`, "g"));
  }

  addMatch(fields, text, /\["body"\]\.get\(\s*["']([^"']+)["']\s*\)/g);
  return [...fields].filter((field) => !["json", "then", "catch"].includes(field)).slice(0, 10);
}

function sampleValue(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("email")) return "user@example.com";
  if (lower.includes("url")) return "https://example.com";
  if (lower.includes("id")) return "123";
  if (lower.includes("count") || lower.includes("limit") || lower.includes("amount")) return 1;
  if (lower.startsWith("is") || lower.includes("enabled")) return true;
  return `<${name}>`;
}

function appendQuery(url: string, params: string[]) {
  if (!params.length) return url;
  const [base, hash = ""] = url.split("#");
  const glue = base.includes("?") ? "&" : "?";
  const qs = params.map((param) => `${encodeURIComponent(param)}=${encodeURIComponent(String(sampleValue(param)))}`).join("&");
  return `${base}${glue}${qs}${hash ? `#${hash}` : ""}`;
}

function inferContract(fn: CurlFunction) {
  const text = sourceText(fn);
  const method = inferMethod(text);
  const queryParams = inferQueryParams(text);
  const headers = inferHeaders(text);
  const bodyFields = BODY_METHODS.has(method) ? inferBodyFields(text) : [];
  const needsBody = BODY_METHODS.has(method) && (bodyFields.length > 0 || /\bawait\s+(?:req|request)\.json\s*\(/.test(text));
  return { method, queryParams, headers, bodyFields, needsBody };
}

export function buildCurlCommand(fn: CurlFunction, urlOverride?: string | null) {
  const contract = inferContract(fn);
  const rawUrl = urlOverride || fn.url || "";
  const url = appendQuery(rawUrl, contract.method === "GET" || contract.method === "DELETE" ? contract.queryParams : []);
  const args = [
    `curl -X ${contract.method} "${escapeDoubleQuoted(url)}"`,
    `-H "Accept: application/json"`,
  ];

  if (fn.auth_required) {
    const header = fn.auth_header_name || "x-api-key";
    const token = fn.api_tokens?.[0]?.value || "<API_KEY>";
    args.push(`-H "${escapeDoubleQuoted(header)}: ${escapeDoubleQuoted(token)}"`);
  }

  for (const header of contract.headers) {
    if (fn.auth_required && header.toLowerCase() === (fn.auth_header_name || "x-api-key").toLowerCase()) continue;
    args.push(`-H "${escapeDoubleQuoted(header)}: <${escapeDoubleQuoted(header)}>"`);
  }

  if (contract.needsBody) {
    const body = Object.fromEntries((contract.bodyFields.length ? contract.bodyFields : ["value"]).map((field) => [field, sampleValue(field)]));
    args.push(`-H "Content-Type: application/json"`);
    args.push(`-d ${shellSingleQuoted(JSON.stringify(body))}`);
  }

  if ((contract.method === "POST" || contract.method === "PUT" || contract.method === "PATCH") && contract.queryParams.length) {
    const withQuery = appendQuery(rawUrl, contract.queryParams);
    args[0] = `curl -X ${contract.method} "${escapeDoubleQuoted(withQuery)}"`;
  }

  return args.join(" ");
}

export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

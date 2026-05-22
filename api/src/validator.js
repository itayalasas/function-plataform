import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { RUNTIMES, denoSelfServes, looksLikeDockerfile, normalizeFunctionSource } from "./functionSource.js";

async function writeFiles(dir, files) {
  for (const file of files) {
    const target = join(dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => resolve({ ok: false, output: error?.message || String(error) }));
    child.on("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

async function checkNodeSyntax(source) {
  const dir = await mkdtemp(join(tmpdir(), "fpm-validate-"));
  try {
    await writeFiles(dir, source.files);
    return await run(process.execPath, ["--check", join(dir, source.entrypoint)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function normalizeFinding(finding) {
  if (typeof finding === "string") {
    return { severity: "warning", message: finding };
  }
  return {
    severity: finding?.severity || "warning",
    message: finding?.message || "Revision pendiente",
    line: finding?.line || null,
  };
}

function normalizeChange(change) {
  if (typeof change === "string") {
    return { path: null, message: change };
  }
  return {
    path: change?.path || null,
    message: change?.message || change?.summary || "Ajuste aplicado por IA.",
  };
}

function normalizeRuntimeId(value, fallback = "node20") {
  const raw = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["node", "nodejs", "node20", "javascript"].includes(raw)) return "node20";
  if (["deno", "typescript", "ts"].includes(raw)) return "deno";
  if (["python", "python3", "python311", "py"].includes(raw)) return "python311";
  if (["java", "javaspring", "spring", "springboot", "java17", "java21"].includes(raw)) return "java-spring";
  if (["csharp", "cs", "dotnet", "dotnet8", "aspnet", "aspnetcore"].includes(raw)) return "dotnet8";
  if (["custom", "docker", "dockerfile"].includes(raw)) return "custom";
  return RUNTIMES[fallback]?.id || "node20";
}

function parseJsonObject(content) {
  const raw = String(content || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return JSON.parse(raw.slice(first, last + 1));
  }
  return {};
}

function serializeFiles(files) {
  return files
    .slice(0, 20)
    .map((file) => `--- ${file.path} ---\n${file.content}`)
    .join("\n\n")
    .slice(0, 24000);
}

const SYSTEM_ENV_PREFIXES = ["FPM_", "NODE_", "npm_", "DENO_"];
const SYSTEM_ENV_NAMES = new Set(["PORT", "HOST", "HOME", "PWD", "PATH", "TMPDIR", "TEMP", "LANG", "TZ"]);

function addMatches(set, text, regex, group = 1) {
  for (const match of text.matchAll(regex)) {
    const key = match[group];
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) set.add(key);
  }
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasManualApiKeyValidation(text, headerName = "x-api-key") {
  const source = String(text || "");
  const header = escapeRegex(headerName || "x-api-key");
  const readsConfiguredHeader = new RegExp(`headers\\.(?:get|has)\\(\\s*["'\`]${header}["'\`]`, "i").test(source) ||
    new RegExp(`headers\\s*\\[\\s*["'\`]${header}["'\`]\\s*\\]`, "i").test(source) ||
    /\bFPM_AUTH_HEADER\b/.test(source);
  const readsGeneratedToken =
    /\b(?:API_KEY|API_KEYS|API_KEYS_CSV|FPM_API_KEY|FPM_API_KEYS|FPM_API_KEYS_CSV|FPM_AUTH_TOKENS|FPM_AUTH_TOKENS_CSV)\b/.test(source);
  const rejectsUnauthorized = /\b401\b|Unauthorized|UNAUTHORIZED|missing_or_invalid|auth=failed/i.test(source);
  const comparesToken = /\.includes\s*\(|\.contains\s*\(|==={0,1}|!=={0,1}|\bcontains\s*\(|\bincludes\s*\(/.test(source);
  return readsConfiguredHeader && readsGeneratedToken && rejectsUnauthorized && comparesToken;
}

export function extractEnvVars(files = []) {
  const vars = new Set();
  for (const file of files) {
    const text = String(file.content || "");
    addMatches(vars, text, /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g);
    addMatches(vars, text, /\bprocess\.env\[['"`]([A-Z_][A-Z0-9_]*)['"`]\]/g);
    addMatches(vars, text, /\bDeno\.env\.get\(\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\)/g);
    addMatches(vars, text, /\bos\.environ\[['"`]([A-Z_][A-Z0-9_]*)['"`]\]/g);
    addMatches(vars, text, /\bos\.environ\.get\(\s*['"`]([A-Z_][A-Z0-9_]*)['"`]/g);
    addMatches(vars, text, /\bos\.getenv\(\s*['"`]([A-Z_][A-Z0-9_]*)['"`]/g);
    addMatches(vars, text, /\bSystem\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g);
    addMatches(vars, text, /\bEnvironment\.GetEnvironmentVariable\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g);
    addMatches(vars, text, /\bENV\[['"`]([A-Z_][A-Z0-9_]*)['"`]\]/g);
    addMatches(vars, text, /\bgetenv\(\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\)/g);
  }
  return [...vars].filter((key) => !SYSTEM_ENV_NAMES.has(key) && !SYSTEM_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))).sort();
}

function normalizeLocalImport(fromPath, specifier) {
  const raw = String(specifier || "").split(/[?#]/)[0];
  if (!raw.startsWith(".")) return null;
  const base = String(fromPath || "").includes("/") ? String(fromPath).slice(0, String(fromPath).lastIndexOf("/")) : "";
  const parts = `${base}/${raw}`.split("/");
  const resolved = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join("/");
}

function localImportCandidates(path) {
  if (/\.[a-z0-9]+$/i.test(path)) return [path];
  return [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.mjs`,
    `${path}.js`,
    `${path}.py`,
    `${path}/index.ts`,
    `${path}/index.mjs`,
    `${path}/index.js`,
  ];
}

function findMissingLocalImports(files = []) {
  const paths = new Set(files.map((file) => String(file.path || "")));
  const missing = [];
  const importRegex = /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]|import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  for (const file of files) {
    const text = String(file.content || "");
    for (const match of text.matchAll(importRegex)) {
      const specifier = match[1] || match[2];
      const resolved = normalizeLocalImport(file.path, specifier);
      if (!resolved) continue;
      if (!localImportCandidates(resolved).some((candidate) => paths.has(candidate))) {
        missing.push({ from: file.path, specifier, resolved });
      }
    }
  }
  return missing;
}

async function runAiReview(fn, source) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) {
    return {
      enabled: false,
      status: "skipped",
      summary: "Validacion IA no configurada. Define OPENAI_API_KEY para activar revision inteligente.",
      findings: [],
    };
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL || process.env.AI_MODEL || "gpt-4o-mini";
  const runtimeHint = {
    deno: "El runtime Deno permite Deno.serve(...) o export default async function handler(req). Prefiere export default para que la plataforma aplique auth, timeout y logs.",
    node20: "El runtime Node.js 20 llama export default async function handler(req) y espera un Response u objeto JSON. req es Web Request; para headers usa req.headers.get(\"x-api-key\").",
    python311: "El runtime Python 3.11 llama def handler(request). request es un dict y puede devolver dict, string, bytes o tupla (body, status, headers).",
    "java-spring": "El runtime Java Spring Boot compila con Maven. Requiere pom.xml, una clase @SpringBootApplication y controllers @RestController.",
    dotnet8: "El runtime .NET 8 compila con dotnet publish. Requiere un .csproj y una API ASP.NET Core que escuche el puerto configurado por la plataforma.",
    custom: "El runtime Custom usa el Dockerfile provisto. La API dentro del contenedor debe escuchar en el puerto 8080.",
  };
  const prompt = [
    `Eres un revisor experto de APIs serverless. Runtime: ${source.runtime}.`,
    runtimeHint[source.runtime] || runtimeHint.node20,
    "Revisa todos los archivos y devuelve solo JSON con: {\"status\":\"passed|failed|warning\",\"summary\":\"...\",\"findings\":[{\"severity\":\"error|warning|info\",\"message\":\"...\",\"line\":number|null}]}",
    "Marca failed solo si hay errores que romperian build/runtime, imports incompatibles, secretos requeridos no mencionados o problemas de sintaxis/logica obvios.",
    "",
    `Nombre: ${fn.name}`,
    `Runtime detectado: ${source.runtime}`,
    `Entrypoint: ${source.entrypoint}`,
    `Secrets declarados: ${(fn.secrets || []).map((secret) => secret.key).join(", ") || "ninguno"}`,
    `Variables de plataforma disponibles: ${(fn.api_tokens || []).some((token) => token.value) ? "API_KEY, API_KEYS, API_KEYS_CSV, FPM_API_KEY, FPM_API_KEYS, FPM_API_KEYS_CSV, FPM_AUTH_TOKENS" : "FPM_*"}`,
    `Auth endpoint: ${fn.auth_required ? `requerida por header ${fn.auth_header_name || "x-api-key"}` : "desactivada"}`,
    "Archivos:",
    serializeFiles(source.files),
  ].join("\n");

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Responde solo JSON valido." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      return {
        enabled: true,
        status: "warning",
        summary: `La revision IA no respondio correctamente (${res.status}). Se aplico validacion estatica.`,
        findings: [],
      };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    return {
      enabled: true,
      status: parsed.status || "warning",
      summary: parsed.summary || "Revision IA completada.",
      findings: Array.isArray(parsed.findings) ? parsed.findings.map(normalizeFinding) : [],
    };
  } catch (error) {
    return {
      enabled: true,
      status: "warning",
      summary: `La revision IA fallo: ${error?.message || error}. Se aplico validacion estatica.`,
      findings: [],
    };
  }
}

async function runAiRepair(fn, source, validation) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
  if (!apiKey) {
    return {
      attempted: false,
      applied: false,
      summary: "Autocorreccion IA omitida: OPENAI_API_KEY no esta configurada.",
      changes: [],
    };
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_REPAIR_MODEL || process.env.OPENAI_MODEL || process.env.AI_MODEL || "gpt-4o-mini";
  const secretKeys = (fn.secrets || []).map((secret) => secret.key).join(", ") || "ninguno";
  const tokenKeys = (fn.api_tokens || []).some((token) => token.value)
    ? "API_KEY, API_KEYS, API_KEYS_CSV, FPM_API_KEY, FPM_API_KEYS, FPM_API_KEYS_CSV, FPM_AUTH_TOKENS"
    : "FPM_API_KEY, FPM_API_KEYS y FPM_AUTH_TOKENS solo si hay tokens generados";
  const prompt = [
    "Eres un ingeniero senior corrigiendo una funcion/API para una plataforma serverless.",
    "Debes devolver SOLO JSON valido con esta forma exacta:",
    "{\"can_repair\":true,\"runtime\":\"node20|deno|python311|java-spring|dotnet8|custom\",\"entrypoint\":\"index.mjs\",\"files\":[{\"path\":\"index.mjs\",\"content\":\"...\"}],\"summary\":\"...\",\"changes\":[{\"path\":\"index.mjs\",\"message\":\"...\"}]}",
    "",
    "Contratos de runtime:",
    "- node20: el archivo principal debe exportar export default async function handler(req). req es Web Request. Devuelve Response u objeto JSON.",
    "- deno: prefiere export default async function handler(req) para que la plataforma pueda envolver auth y timeout. Usa Deno.env.get(\"SECRET\").",
    "- python311: el archivo principal debe tener def handler(request). request es un dict y puede devolver dict, string, bytes o tupla.",
    "- java-spring: debe incluir pom.xml, clase @SpringBootApplication y controllers @RestController. Usa System.getenv(\"SECRET\") para secrets.",
    "- dotnet8: debe incluir .csproj y Program.cs con ASP.NET Core Minimal API o controllers. Usa Environment.GetEnvironmentVariable(\"SECRET\") para secrets.",
    "- custom: debe existir Dockerfile y la API debe escuchar en puerto 8080.",
    "",
    "Reglas de correccion:",
    "- Conserva la logica de negocio tanto como sea posible.",
    "- Ajusta imports, entrypoint, sintaxis y formato del handler para que compile en el runtime elegido.",
    "- No inventes valores de secrets. Si el codigo necesita un secret, manten la lectura usando el patron del runtime y la validacion lo exigira.",
    "- Para Node usa process.env.SECRET_NAME, no Deno.env.get ni process.env.get.",
    "- Para Node lee headers con req.headers.get(\"x-api-key\"); no uses req.headers['x-api-key'] en codigo nuevo.",
    "- Para Deno usa Deno.env.get(\"SECRET_NAME\"), no process.env.",
    "- Para Python usa os.environ.get(\"SECRET_NAME\") u os.getenv(\"SECRET_NAME\").",
    "- Para Java usa System.getenv(\"SECRET_NAME\").",
    "- Para C# usa Environment.GetEnvironmentVariable(\"SECRET_NAME\").",
    "- Si auth de plataforma esta activa en Node, Deno export default, Python, Java Spring o .NET, no agregues validacion manual obligatoria del header salvo que sea parte del negocio; el wrapper/gateway valida antes del handler.",
    "- Si usas Deno.serve(...) directo o Custom Dockerfile con auth activa, valida manualmente el header configurado contra FPM_API_KEY o FPM_AUTH_TOKENS.",
    "- Si el codigo necesita leer el token generado dentro de la funcion, usa API_KEY o FPM_API_KEY. Para multiples tokens, FPM_API_KEYS es JSON y FPM_API_KEYS_CSV es CSV.",
    "- Mantén rutas relativas internas como _shared/helper.ts o _shared/helper.mjs cuando existan.",
    "- No expliques fuera del JSON.",
    "",
    `Nombre: ${fn.name}`,
    `Runtime actual: ${source.runtime}`,
    `Entrypoint actual: ${source.entrypoint}`,
    `Secrets declarados: ${secretKeys}`,
    `Variables de token disponibles: ${tokenKeys}`,
    `Auth endpoint: ${fn.auth_required ? `requerida por header ${fn.auth_header_name || "x-api-key"}` : "desactivada"}`,
    "Errores/hallazgos a corregir:",
    JSON.stringify((validation.findings || []).map((finding) => ({
      severity: finding.severity,
      message: finding.message,
      line: finding.line || null,
    })), null, 2),
    "Archivos actuales:",
    serializeFiles(source.files),
  ].join("\n");

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Responde solo JSON valido. No incluyas markdown." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      return {
        attempted: true,
        applied: false,
        summary: `Autocorreccion IA no disponible (${res.status}).`,
        changes: [],
      };
    }

    const data = await res.json();
    const parsed = parseJsonObject(data?.choices?.[0]?.message?.content || "{}");
    const files = Array.isArray(parsed.files)
      ? parsed.files
          .filter((file) => file?.path && typeof file.content === "string")
          .map((file) => ({ path: String(file.path), content: String(file.content) }))
      : [];
    const runtime = normalizeRuntimeId(parsed.runtime, source.runtime);
    const entrypoint = parsed.entrypoint || source.entrypoint;

    if (!parsed.can_repair || !files.length) {
      return {
        attempted: true,
        applied: false,
        summary: parsed.summary || "La IA no encontro una reparacion segura para aplicar.",
        changes: Array.isArray(parsed.changes) ? parsed.changes.map(normalizeChange) : [],
      };
    }

    const repaired = normalizeFunctionSource({
      ...fn,
      files,
      entrypoint,
      runtime,
    });

    return {
      attempted: true,
      applied: true,
      summary: parsed.summary || "La IA aplico ajustes automaticos al codigo.",
      changes: Array.isArray(parsed.changes) ? parsed.changes.map(normalizeChange) : [],
      source: {
        code: repaired.code,
        files: repaired.files,
        entrypoint: repaired.entrypoint,
        runtime: repaired.runtime,
      },
    };
  } catch (error) {
    return {
      attempted: true,
      applied: false,
      summary: `Autocorreccion IA fallo: ${error?.message || error}.`,
      changes: [],
    };
  }
}

function validateStatic(fn, source) {
  const findings = [];
  const entry = source.files.find((file) => file.path === source.entrypoint);
  const code = String(entry?.content || "");
  const allCode = source.files.map((file) => file.content).join("\n\n");

  if (!code.trim()) {
    findings.push({ severity: "error", message: `El archivo principal ${source.entrypoint} esta vacio.` });
  }

  for (const missing of findMissingLocalImports(source.files)) {
    findings.push({
      severity: "error",
      message: `El archivo ${missing.from} importa ${missing.specifier}, pero ese archivo no existe en la funcion.`,
    });
  }

  const declaredSecrets = new Set((fn.secrets || []).map((secret) => String(secret.key || "").toUpperCase()));
  if ((fn.api_tokens || []).some((token) => token.value)) {
    declaredSecrets.add("API_KEY");
    declaredSecrets.add("API_KEYS");
    declaredSecrets.add("API_KEYS_CSV");
  }
  const requiredEnvVars = extractEnvVars(source.files);
  const missingSecrets = requiredEnvVars.filter((key) => !declaredSecrets.has(key));
  if (missingSecrets.length) {
    findings.push({
      severity: "error",
      message: `Faltan secrets para variables de entorno usadas en el codigo: ${missingSecrets.join(", ")}. Declaralas en Secrets antes de validar/deployar.`,
    });
  }

  if (fn.auth_required && !(fn.api_tokens || []).some((token) => token.value)) {
    findings.push({
      severity: "error",
      message: `Auth esta activa pero no hay tokens generados. Crea al menos un token para el header ${fn.auth_header_name || "x-api-key"}.`,
    });
  }

  if (source.runtime === "deno") {
    const hasDenoServe = /\bDeno\.serve\s*\(/m.test(code);
    const hasDefaultHandler = /export\s+default\s+(async\s+)?function|export\s+default\s+async\s*\(|export\s+default\s*\(/m.test(code);
    if (!hasDenoServe && !hasDefaultHandler) {
      findings.push({
        severity: "error",
        message: "Deno requiere Deno.serve(...) o export default async function handler(req) en el archivo principal.",
      });
    }
    if (/\b(require|module\.exports)\b/.test(allCode)) {
      findings.push({ severity: "error", message: "El runtime Deno no soporta require/module.exports; usa import/export ESM." });
    }
    if (fn.auth_required && denoSelfServes(source)) {
      if (hasManualApiKeyValidation(allCode, fn.auth_header_name || "x-api-key")) {
        findings.push({
          severity: "info",
          message: `Auth manual detectada: Deno.serve(...) valida el header ${fn.auth_header_name || "x-api-key"} contra los tokens generados por la plataforma.`,
        });
      } else {
        findings.push({
          severity: "error",
          message: `Deno.serve(...) directo evita el wrapper que valida auth. Cambia a export default async function handler(req) o valida manualmente ${fn.auth_header_name || "x-api-key"} contra FPM_API_KEY/FPM_AUTH_TOKENS.`,
        });
      }
    }
    return findings;
  }

  if (source.runtime === "python311") {
    if (!/def\s+handler\s*\(/m.test(code)) {
      findings.push({ severity: "error", message: "Python 3.11 requiere def handler(request) en el archivo principal." });
    }
    return findings;
  }

  if (source.runtime === "java-spring") {
    if (!source.files.some((file) => /(^|\/)pom\.xml$/i.test(file.path))) {
      findings.push({ severity: "error", message: "Java Spring Boot requiere pom.xml para compilar con Maven." });
    }
    if (!/@SpringBootApplication\b/.test(allCode)) {
      findings.push({ severity: "error", message: "Java Spring Boot requiere una clase principal con @SpringBootApplication." });
    }
    if (!/@(RestController|Controller|GetMapping|PostMapping|RequestMapping)\b/.test(allCode)) {
      findings.push({ severity: "warning", message: "No se detectaron controllers o mappings HTTP en el proyecto Spring Boot." });
    }
    return findings;
  }

  if (source.runtime === "dotnet8") {
    if (!source.files.some((file) => /\.csproj$/i.test(file.path))) {
      findings.push({ severity: "error", message: ".NET 8 requiere un archivo .csproj para compilar con dotnet publish." });
    }
    if (!/\b(WebApplication\.CreateBuilder|MapGet\s*\(|MapPost\s*\(|ControllerBase|ApiController)\b/.test(allCode)) {
      findings.push({ severity: "warning", message: "No se detecto una API ASP.NET Core clara en Program.cs o controllers." });
    }
    return findings;
  }

  if (source.runtime === "custom") {
    const dockerfiles = source.files.filter((file) => /^dockerfile$/i.test(file.path.split("/").pop() || ""));
    if (!dockerfiles.length) {
      findings.push({ severity: "error", message: "Custom runtime requiere un Dockerfile dentro de la funcion." });
    } else if (!dockerfiles.some((file) => looksLikeDockerfile(file.content))) {
      findings.push({
        severity: "error",
        message: "El archivo Dockerfile no contiene instrucciones Dockerfile validas. Si es codigo de una API, cambia el runtime o renombra el archivo principal.",
      });
    }
    if (fn.auth_required) {
      if (hasManualApiKeyValidation(allCode, fn.auth_header_name || "x-api-key")) {
        findings.push({
          severity: "info",
          message: `Auth manual detectada: el Custom Dockerfile valida el header ${fn.auth_header_name || "x-api-key"} contra los tokens generados por la plataforma.`,
        });
      } else {
        findings.push({
          severity: "error",
          message: `Custom Dockerfile no puede aplicar auth automaticamente. Valida manualmente el header ${fn.auth_header_name || "x-api-key"} contra FPM_API_KEY/FPM_AUTH_TOKENS dentro del contenedor.`,
        });
      }
    }
    return findings;
  }

  if (!/export\s+default\s+(async\s+)?function|export\s+default\s+async\s*\(|export\s+default\s*\(/m.test(code)) {
    findings.push({
      severity: "error",
      message: "Node 20 requiere export default async function handler(req) en el archivo principal.",
    });
  }
  if (/\bDeno\.|from\s+["']npm:|import\s*\(\s*["']npm:/m.test(allCode)) {
    findings.push({
      severity: "error",
      message: "El codigo parece Deno. La plataforma seleccionara Deno automaticamente al guardar/validar.",
    });
  }
  if (/:\s*(Request|Response|unknown|string|number|boolean)\b|interface\s+\w+|type\s+\w+\s*=/m.test(code)) {
    findings.push({
      severity: "error",
      message: "Node 20 no compila TypeScript directamente. Usa Deno o quita las anotaciones de tipos.",
    });
  }
  if (source.files.some((file) => /\.ts$/i.test(file.path))) {
    findings.push({
      severity: "error",
      message: "Node 20 no carga archivos .ts directamente. Usa Deno o cambia esos archivos a .mjs/.js.",
    });
  }
  if (/process\.exit\s*\(/.test(allCode)) {
    findings.push({
      severity: "warning",
      message: "process.exit() puede cortar el contenedor y provocar reinicios durante el trafico.",
    });
  }
  if (/\breq\.headers\s*\[[^\]]+\]/m.test(allCode)) {
    findings.push({
      severity: "warning",
      message: "Node recibe un Web Request. Usa req.headers.get(\"x-api-key\") para leer headers; la plataforma mantiene compatibilidad con req.headers['x-api-key'], pero no es el formato recomendado.",
    });
  }
  if (/node:(fs|child_process|cluster)|from\s+["'](fs|child_process|cluster)["']/.test(allCode)) {
    findings.push({
      severity: "warning",
      message: "El handler usa APIs de sistema. Revisa permisos y efectos secundarios antes de produccion.",
    });
  }
  return findings;
}

function normalizeAiFindings(fn, source, ai) {
  let removedReason = "";
  let findings = (ai.findings || []).filter((finding) => {
    const message = String(finding.message || "");
    if (source.runtime === "deno") {
      const isSupportedDenoServe = /Deno\.serve/i.test(message) && /export\s+default|handler|manejo de la funci[oó]n/i.test(message);
      const isShimmedEdgeRuntime = /\bEdgeRuntime\.waitUntil\b|EdgeRuntime/i.test(message) && /no est[aá] definida|not defined/i.test(message);
      if (isSupportedDenoServe || isShimmedEdgeRuntime) {
        removedReason = "Revision IA ajustada: Deno.serve(...) y EdgeRuntime.waitUntil estan soportados por el runner Deno de la plataforma.";
        return false;
      }
    }
    return true;
  });

  if ((fn.api_tokens || []).some((token) => token.value)) {
    const before = findings.length;
    findings = findings.filter((finding) => {
      const message = String(finding.message || "");
      const isGeneratedApiKey = /\bAPI_KEYS?\b|clave API|api key/i.test(message);
      return !isGeneratedApiKey;
    });
    if (findings.length !== before) {
      removedReason = "Revision IA ajustada: API_KEY/API_KEYS son provistas por tokens generados por la plataforma.";
    }
  }

  const hadRemovedFindings = findings.length !== (ai.findings || []).length;
  const nextStatus = hadRemovedFindings && ai.status === "failed" && !findings.some((finding) => finding.severity === "error")
    ? findings.some((finding) => finding.severity === "warning") ? "warning" : "passed"
    : ai.status;
  return {
    ...ai,
    status: nextStatus,
    summary: hadRemovedFindings && ai.status === "failed"
      ? removedReason || "Revision IA ajustada segun capacidades del runtime configurado."
      : ai.summary,
    findings,
  };
}

async function validateSource(fn, source) {
  const findings = validateStatic(fn, source);

  if (source.runtime === "node20") {
    const syntax = await checkNodeSyntax(source);
    if (!syntax.ok) {
      findings.push({
        severity: "error",
        message: `Error de sintaxis en ${source.entrypoint}: ${syntax.output || "node --check fallo"}`,
      });
    }
  } else if (source.runtime === "deno") {
    findings.push({
      severity: "info",
      message: "Runtime Deno detectado. La validacion evita checks Node y el deploy usara imagen Deno.",
    });
  } else if (source.runtime === "python311") {
    findings.push({
      severity: "info",
      message: "Runtime Python detectado. El deploy usara imagen Python 3.11 y buscara def handler(request).",
    });
  } else if (source.runtime === "java-spring") {
    findings.push({
      severity: "info",
      message: "Runtime Java Spring Boot detectado. El deploy compilara con Maven y agregara un gateway para auth, logs y ruteo base.",
    });
  } else if (source.runtime === "dotnet8") {
    findings.push({
      severity: "info",
      message: "Runtime .NET 8 detectado. El deploy compilara con dotnet publish y agregara un gateway para auth, logs y ruteo base.",
    });
  } else if (source.runtime === "custom") {
    findings.push({
      severity: "info",
      message: "Runtime Custom detectado. La validacion estatica revisa secrets y Dockerfile; el build Docker valida el resto.",
    });
  }

  const ai = normalizeAiFindings(fn, source, await runAiReview(fn, source));
  findings.push(...ai.findings);

  const hasBlockingFinding = findings.some((finding) => finding.severity === "error");
  const aiFailed = ai.enabled && ai.status === "failed";
  const status = hasBlockingFinding || aiFailed ? "failed" : findings.some((finding) => finding.severity === "warning") ? "warning" : "passed";
  const blocking = status === "failed";
  const summary = blocking
    ? "La funcion no esta lista para deploy. Corrige los errores de validacion."
    : source.detected_runtime !== fn.runtime
      ? `Runtime ajustado automaticamente a ${source.runtime}.`
      : ai.enabled
        ? ai.summary
        : "Validacion estatica completada. La revision IA se activara cuando configures OPENAI_API_KEY.";

  return {
    status,
    blocking,
    summary,
    findings,
    ai,
    runtime: source.runtime,
    detected_runtime: source.detected_runtime,
    entrypoint: source.entrypoint,
    required_secrets: extractEnvVars(source.files),
    checked_at: new Date().toISOString(),
  };
}

function shouldAttemptRepair(validation) {
  return Boolean(validation?.blocking);
}

export async function validateFunctionCode(fn, { repair = false } = {}) {
  const source = normalizeFunctionSource(fn);
  let validation = await validateSource(fn, source);

  if (!repair || !shouldAttemptRepair(validation)) {
    return validation;
  }

  const repairResult = await runAiRepair(fn, source, validation);
  if (!repairResult.applied || !repairResult.source) {
    return {
      ...validation,
      repair: repairResult,
      findings: [
        ...validation.findings,
        {
          severity: repairResult.attempted ? "warning" : "info",
          message: repairResult.summary,
        },
      ],
    };
  }

  const repairedFn = { ...fn, ...repairResult.source };
  const repairedSource = normalizeFunctionSource(repairedFn);
  const repairedValidation = await validateSource(repairedFn, repairedSource);
  const stillBlocking = repairedValidation.blocking;

  return {
    ...repairedValidation,
    summary: stillBlocking
      ? `La IA aplico ajustes, pero aun quedan errores: ${repairedValidation.summary}`
      : repairResult.summary || "La IA corrigio la funcion y quedo lista para deploy.",
    repair: repairResult,
    repaired_source: repairResult.source,
    findings: [
      {
        severity: stillBlocking ? "warning" : "info",
        message: `Autocorreccion IA aplicada: ${repairResult.summary}`,
      },
      ...repairedValidation.findings,
    ],
  };
}

"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, API } from "@/lib/api";
import { buildCurlCommand, copyText } from "@/lib/curl";
import { useCurrentEnvironment } from "@/lib/environment";
import { mergeLogEntries, parseLogEntry } from "@/lib/logs";
import { Topbar } from "@/components/Topbar";
import { StatusBadge } from "@/components/StatusBadge";
import { CodeEditor, type CodeSearchStats } from "@/components/CodeEditor";
import {
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  History,
  KeyRound,
  Loader2,
  Rocket,
  Save,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";

type Secret = { id: string; key: string; value: string };
type ApiToken = { id: string; name: string; value: string; last4?: string; created_at?: string };
type SourceFile = { path: string; content: string };
const MEMORY_OPTIONS = [128, 256, 512, 1024, 2048, 4096];
type Fn = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  code: string;
  files?: SourceFile[];
  entrypoint?: string;
  runtime?: string;
  memory_mb?: number;
  timeout_seconds?: number;
  auth_required?: boolean;
  auth_header_name?: string;
  api_tokens?: ApiToken[];
  status: string;
  url?: string;
  container_id?: string;
  active_deploy_version?: string;
  project_name?: string;
  project_slug?: string;
  environment_name?: string;
  environment_slug?: string;
  source_function_id?: string | null;
  validation_status?: string;
  validation_summary?: string;
  secrets: Secret[];
};
type Deployment = {
  id: string;
  version: string;
  status: string;
  active?: boolean;
  url?: string;
  validation_status?: string;
  validation_summary?: string;
  error?: string;
  deprecated_at?: string | null;
  deprecated_reason?: string | null;
  change_summary?: string | null;
  change_details?: { label?: string; message?: string; before?: string | null; after?: string | null }[];
  source_deployment_id?: string | null;
  snapshot?: { function?: Record<string, any>; meta?: Record<string, any> } | null;
  created_at: string;
  updated_at?: string;
  finished_at?: string;
};
type Validation = {
  status: string;
  blocking: boolean;
  summary: string;
  findings: { severity: string; message: string; line?: number | null }[];
  ai?: { enabled: boolean; status: string; summary: string };
  repair?: {
    attempted?: boolean;
    applied?: boolean;
    summary?: string;
    changes?: { path?: string | null; message: string }[];
  };
};
type LogEntry = { message: string; ts?: string };
type FileTreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  children: FileTreeNode[];
  file?: SourceFile;
};

const FOLDER_MARKER = ".gitkeep";

function runtimeLabel(runtime?: string) {
  if (runtime === "deno") return "Deno";
  if (runtime === "python311") return "Python 3.11";
  if (runtime === "java-spring") return "Java Spring Boot";
  if (runtime === "dotnet8") return ".NET 8 C#";
  if (runtime === "custom") return "Custom Dockerfile";
  return "Node 20";
}

function formatLog(entry: LogEntry) {
  const ts = entry.ts ? new Date(entry.ts) : new Date();
  return `${ts.toLocaleString()}  ${entry.message}`;
}

function logLevel(message: string) {
  return parseLogEntry(message).level;
}

function logLevelClass(level: string) {
  if (level === "ERROR") return "text-rose-300 border-rose-500/30 bg-rose-500/10";
  if (level === "WARNING") return "text-amber-300 border-amber-500/30 bg-amber-500/10";
  return "text-cyan-300 border-cyan-500/30 bg-cyan-500/10";
}

function logTextClass(level: string) {
  if (level === "ERROR") return "text-rose-200";
  if (level === "WARNING") return "text-amber-200";
  return "text-slate-300";
}

function parseLog(entry: LogEntry) {
  return parseLogEntry(entry);
}

function normalizeDeployVersion(value = "v1") {
  const raw = String(value || "v1").trim().toLowerCase();
  const normalized = raw
    .replace(/^version[\s_-]*/, "v")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) return "v1";
  if (/^\d+$/.test(normalized)) return `v${normalized}`;
  return normalized;
}

function compareVersions(a: string, b: string) {
  const ma = /^v(\d+)$/.exec(a);
  const mb = /^v(\d+)$/.exec(b);
  if (ma && mb) return Number(ma[1]) - Number(mb[1]);
  return a.localeCompare(b);
}

function normalizePath(path: string) {
  const cleaned = path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  const parts = cleaned.split("/").filter(Boolean);
  if (!parts.length) throw new Error("La ruta del archivo es obligatoria");
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("La ruta no puede usar . ni ..");
  }
  return parts.join("/");
}

function sourceFiles(fn: Fn) {
  return fn.files?.length ? fn.files : [{ path: fn.entrypoint || "index.mjs", content: fn.code || "" }];
}

function isFolderMarker(path = "") {
  return path.split("/").pop() === FOLDER_MARKER;
}

function basename(path = "") {
  return path.split("/").filter(Boolean).pop() || path;
}

function folderOf(path = "") {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function buildFileTree(files: SourceFile[]) {
  const root: FileTreeNode[] = [];
  const folders = new Map<string, FileTreeNode>();

  const ensureFolder = (parts: string[]) => {
    let current = root;
    let path = "";
    let node: FileTreeNode | null = null;
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      node = folders.get(path) || null;
      if (!node) {
        node = { name: part, path, type: "folder", children: [] };
        folders.set(path, node);
        current.push(node);
      }
      current = node.children;
    }
    return node;
  };

  for (const file of files) {
    const parts = normalizePath(file.path).split("/");
    const name = parts.pop() || file.path;
    const folder = ensureFolder(parts);
    if (name === FOLDER_MARKER) continue;
    const target = folder?.children || root;
    target.push({ name, path: file.path, type: "file", children: [], file });
  }

  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((node) => sortNodes(node.children));
    return nodes;
  };

  return sortNodes(root);
}

function dirname(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

function resolveLocalImport(fromPath: string, specifier: string) {
  const stack = dirname(fromPath).filter(Boolean);
  let escapedRoot = false;
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length) stack.pop();
      else escapedRoot = true;
      continue;
    }
    stack.push(part);
  }
  return { path: stack.join("/"), escapedRoot };
}

function relativeImport(fromPath: string, targetPath: string) {
  const from = dirname(fromPath).filter(Boolean);
  const target = targetPath.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < target.length && from[i] === target[i]) i += 1;
  const up = from.slice(i).map(() => "..");
  const down = target.slice(i);
  const relative = [...up, ...down].join("/");
  return relative.startsWith(".") ? relative : (up.length ? relative : `./${relative}`);
}

function parseNamedImports(importClause = "") {
  const named = /\{([^}]+)\}/m.exec(importClause)?.[1] || "";
  return named
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+as\s+/i)[0].trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

function hasDefaultImport(importClause = "") {
  const cleaned = importClause.replace(/\{[^}]*\}/g, "").trim();
  return /^[A-Za-z_$][\w$]*/.test(cleaned) && !cleaned.startsWith("*");
}

function stubFor(path: string, importClauses: string[], runtime?: string) {
  const named = [...new Set(importClauses.flatMap(parseNamedImports))];
  const defaultName = importClauses.some(hasDefaultImport);
  const isTs = /\.tsx?$/i.test(path) || runtime === "deno";
  const isJs = /\.(mjs|js|jsx)$/i.test(path) || runtime === "node20";
  const lines = [`// Archivo auxiliar creado automaticamente. Reemplaza estos stubs con la implementacion real.`];

  if (defaultName) {
    lines.push(isTs
      ? `export default function helper(..._args: unknown[]): never { throw new Error("Implementa ${path}"); }`
      : `export default function helper(..._args) { throw new Error("Implementa ${path}"); }`);
  }

  for (const name of named) {
    lines.push(isTs
      ? `export function ${name}(..._args: unknown[]): never { throw new Error("Implementa ${name} en ${path}"); }`
      : `export function ${name}(..._args) { throw new Error("Implementa ${name} en ${path}"); }`);
  }

  if (!defaultName && named.length === 0) {
    lines.push(isJs || isTs ? `export {};` : "");
  }

  return `${lines.filter(Boolean).join("\n")}\n`;
}

function prepareFilesForSave(fn: Fn) {
  const files = sourceFiles(fn).map((file) => ({ ...file, path: normalizePath(file.path) }));
  const existing = new Set(files.map((file) => file.path));
  const imports = new Map<string, string[]>();
  let changed = false;
  const importRegex = /\bimport\s+([\s\S]*?)\s+from\s+["'](\.{1,2}\/[^"']+)["']|\bexport\s+[\s\S]*?\s+from\s+["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gm;

  for (const file of files) {
    file.content = file.content.replace(importRegex, (match, importClause = "", fromPath, exportPath, dynamicPath) => {
      const specifier = fromPath || exportPath || dynamicPath;
      const resolved = resolveLocalImport(file.path, specifier);
      if (!resolved.path) return match;
      const targetPath = normalizePath(resolved.path);
      if (!imports.has(targetPath)) imports.set(targetPath, []);
      imports.get(targetPath)?.push(importClause || "");

      if (resolved.escapedRoot) {
        changed = true;
        const nextSpecifier = relativeImport(file.path, targetPath);
        return match.replace(specifier, nextSpecifier);
      }
      return match;
    });
  }

  for (const [path, clauses] of imports.entries()) {
    if (existing.has(path)) continue;
    existing.add(path);
    files.push({ path, content: stubFor(path, clauses, fn.runtime) });
    changed = true;
  }

  const sorted = files.sort((a, b) => a.path.localeCompare(b.path));
  const entrypoint = sorted.some((file) => file.path === fn.entrypoint) ? fn.entrypoint : sorted[0]?.path || fn.entrypoint || "index.mjs";
  const entryFile = sorted.find((file) => file.path === entrypoint) || sorted[0];
  return {
    ...fn,
    files: sorted,
    entrypoint,
    code: entryFile?.content || fn.code || "",
    changed,
  };
}

function snapshotFunction(fn: Fn) {
  const files = sourceFiles(fn)
    .map((file) => ({ path: normalizePath(file.path), content: file.content || "" }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const entrypoint = files.some((file) => file.path === fn.entrypoint) ? fn.entrypoint : files[0]?.path || fn.entrypoint || "index.mjs";
  const entryFile = files.find((file) => file.path === entrypoint) || files[0];

  return JSON.stringify({
    name: fn.name || "",
    description: fn.description || "",
    code: entryFile?.content || fn.code || "",
    files,
    entrypoint,
    runtime: fn.runtime || "node20",
    memory_mb: Number(fn.memory_mb || 256),
    timeout_seconds: Number(fn.timeout_seconds || 30),
    auth_required: Boolean(fn.auth_required),
    auth_header_name: fn.auth_header_name || "x-api-key",
  });
}

function defaultHelperPath(runtime?: string) {
  if (runtime === "python311") return "_shared/helper.py";
  if (runtime === "java-spring") return "src/main/java/com/example/demo/service/HelperService.java";
  if (runtime === "dotnet8") return "Services/HelperService.cs";
  if (runtime === "custom") return "src/helper.txt";
  return runtime === "deno" ? "_shared/helper.ts" : "_shared/helper.mjs";
}

export default function Detail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentEnv = useCurrentEnvironment();
  const [fn, setFn] = useState<Fn | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const initialTab = searchParams.get("tab");
  const [tab, setTab] = useState<"code" | "secrets" | "validation" | "logs" | "deployments" | "settings">(
    initialTab === "logs" || initialTab === "deployments" || initialTab === "secrets" || initialTab === "settings" || initialTab === "validation" ? initialTab : "code"
  );
  const [savingMsg, setSavingMsg] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [secretVal, setSecretVal] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [tokenValue, setTokenValue] = useState("");
  const [newToken, setNewToken] = useState<ApiToken | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [activePath, setActivePath] = useState("");
  const [deployVersion, setDeployVersion] = useState("");
  const [fileModalOpen, setFileModalOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [fileError, setFileError] = useState("");
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [folderError, setFolderError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [rollbackDeploymentId, setRollbackDeploymentId] = useState("");
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [codeSearch, setCodeSearch] = useState("");
  const [codeSearchIndex, setCodeSearchIndex] = useState(0);
  const [codeSearchAction, setCodeSearchAction] = useState(0);
  const [codeSearchStats, setCodeSearchStats] = useState<CodeSearchStats>({ count: 0, current: 0, query: "" });
  const esRef = useRef<EventSource | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const scrollLogsToBottom = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const availableVersions = useMemo(() => {
    const versions = new Set<string>();
    versions.add("v1");
    if (fn?.active_deploy_version) versions.add(normalizeDeployVersion(fn.active_deploy_version));
    for (const deployment of deployments) versions.add(normalizeDeployVersion(deployment.version));
    return [...versions].sort(compareVersions);
  }, [deployments, fn?.active_deploy_version]);

  const selectedVersion = normalizeDeployVersion(deployVersion || fn?.active_deploy_version || "v1");
  const routePreview = fn ? `/${selectedVersion}/${fn.slug}` : "";
  const selectedDeploymentUrl = useMemo(() => {
    const deployment = deployments.find((item) => normalizeDeployVersion(item.version) === selectedVersion && item.url && item.active);
    if (deployment?.url) return deployment.url;
    if (fn?.active_deploy_version && normalizeDeployVersion(fn.active_deploy_version) === selectedVersion) return fn.url || null;
    return null;
  }, [deployments, fn?.active_deploy_version, fn?.url, selectedVersion]);

  const unsavedState = useMemo(() => {
    if (!fn || !savedSnapshot) return { dirty: false, generatedFiles: false, error: "" };
    try {
      const prepared = prepareFilesForSave(fn);
      return {
        dirty: snapshotFunction(prepared) !== savedSnapshot,
        generatedFiles: Boolean(prepared.changed),
        error: "",
      };
    } catch (error: any) {
      return {
        dirty: true,
        generatedFiles: false,
        error: error?.message || "Hay cambios pendientes con una ruta invalida.",
      };
    }
  }, [fn, savedSnapshot]);

  const hasUnsavedChanges = unsavedState.dirty;
  const unsavedBlockMessage = unsavedState.error
    ? `Corrige la ruta antes de validar o desplegar: ${unsavedState.error}`
    : unsavedState.generatedFiles
      ? "Guarda primero: se detectaron imports o archivos auxiliares pendientes de persistir."
      : "Guarda los cambios antes de validar o desplegar.";

  async function load() {
    const [nextFn, nextDeployments] = await Promise.all([
      api<Fn>(`/api/functions/${id}`),
      api<Deployment[]>(`/api/deployments?function_id=${id}`).catch(() => []),
    ]);
    setFn(nextFn);
    setSavedSnapshot(snapshotFunction(nextFn));
    setDeployments(nextDeployments);
    setDeployVersion((current) => current || normalizeDeployVersion(nextFn.active_deploy_version || nextDeployments[0]?.version || "v1"));
    setActivePath((current) => {
      const files = sourceFiles(nextFn);
      return files.some((file) => file.path === current) ? current : nextFn.entrypoint || files[0].path;
    });
  }

  const loadLogHistory = useCallback(async (version = selectedVersion) => {
    const history = await api<LogEntry[]>(`/api/functions/${id}/logs/history?version=${encodeURIComponent(version)}`);
    setLogs((current) => mergeLogEntries(current, history || [], 500));
  }, [id, selectedVersion]);

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (tab !== "logs" || !id) return;
    setLogs([]);
    const refresh = () => loadLogHistory().then(scrollLogsToBottom).catch(() => {});
    refresh();
    const es = new EventSource(`${API}/api/functions/${id}/logs?version=${encodeURIComponent(selectedVersion)}`);
    esRef.current = es;
    es.onopen = () => scrollLogsToBottom();
    es.onmessage = (e) => {
      try {
        setLogs((items) => mergeLogEntries(items, [{ message: JSON.parse(e.data), ts: new Date().toISOString() }], 500));
      } catch {}
    };
    es.onerror = () => {};
    const timer = window.setInterval(refresh, 4000);
    return () => {
      window.clearInterval(timer);
      es.close();
    };
  }, [tab, id, selectedVersion, loadLogHistory, scrollLogsToBottom]);

  useEffect(() => {
    if (tab !== "logs" || !logs.length) return;
    const frame = window.requestAnimationFrame(scrollLogsToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [tab, logs, selectedVersion, scrollLogsToBottom]);

  useEffect(() => {
    setCodeSearchIndex(0);
  }, [activePath, codeSearch]);

  useEffect(() => {
    const nextTab = searchParams.get("tab");
    if (nextTab === "logs" || nextTab === "deployments" || nextTab === "secrets" || nextTab === "settings" || nextTab === "validation" || nextTab === "code") {
      setTab(nextTab);
    }
  }, [searchParams]);

  const handleCodeSearchStats = useCallback((stats: CodeSearchStats) => {
    setCodeSearchStats((current) =>
      current.count === stats.count && current.current === stats.current && current.query === stats.query
        ? current
        : stats
    );
  }, []);

  function moveCodeSearch(delta: number) {
    if (!codeSearchStats.count) return;
    setCodeSearchIndex((current) => (current + delta + codeSearchStats.count) % codeSearchStats.count);
    setCodeSearchAction((current) => current + 1);
  }

  if (!fn) return <div className="text-slate-400">Cargando...</div>;
  if (fn.environment_slug && fn.environment_slug !== currentEnv.slug) {
    return (
      <div>
        <Topbar title={fn.name} subtitle={`Esta funcion pertenece a ${fn.environment_slug.toUpperCase()}`} />
        <div className="card max-w-2xl">
          <h3 className="font-semibold">Fuera del ambiente actual</h3>
          <p className="mt-2 text-sm text-slate-400">
            Estas parado en {currentEnv.label}. Para evitar cambios cruzados, solo se pueden abrir, editar y desplegar funciones del ambiente actual.
          </p>
          <button type="button" onClick={() => router.push("/functions")} className="btn-primary mt-4">
            Ver funciones de {currentEnv.slug.toUpperCase()}
          </button>
        </div>
      </div>
    );
  }

  const promotedCopy = Boolean(fn.source_function_id);
  const promotedStatus = String(fn.status || "");
  const promotedHasDeployment = Boolean(
    selectedDeploymentUrl ||
    fn.url ||
    fn.container_id ||
    ["running", "deploying", "queued"].includes(promotedStatus)
  );
  const canDeployPromotedCopy = promotedCopy && !["running", "deploying", "queued"].includes(promotedStatus);
  const baseReadOnly = promotedCopy;

  async function save() {
    if (pendingAction) return;
    if (baseReadOnly) {
      setSavingMsg("La configuracion base se cambia en el ambiente origen y luego se promueve.");
      return;
    }
    setPendingAction("save");
    setSavingMsg("Guardando...");
    try {
      const prepared = prepareFilesForSave(fn);
      if (prepared.changed) {
        setFn(prepared);
        setSavingMsg("Guardando archivos auxiliares...");
      }
      const updated = await api<Fn>(`/api/functions/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: prepared.name,
          description: prepared.description,
          code: prepared.code,
          files: prepared.files,
          entrypoint: prepared.entrypoint,
          runtime: prepared.runtime,
          memory_mb: prepared.memory_mb,
          timeout_seconds: prepared.timeout_seconds,
          auth_required: prepared.auth_required,
          auth_header_name: prepared.auth_header_name,
        }),
      });
      setFn(updated);
      setSavedSnapshot(snapshotFunction(updated));
      setActivePath((current) => sourceFiles(updated).some((file) => file.path === current) ? current : updated.entrypoint || sourceFiles(updated)[0]?.path || "");
      setSavingMsg("Guardado");
      setTimeout(() => setSavingMsg(""), 1500);
    } catch (e: any) {
      setSavingMsg("Error: " + e.message);
    } finally {
      setPendingAction(null);
    }
  }

  async function runValidation() {
    if (pendingAction) return;
    if (baseReadOnly) {
      setSavingMsg("La validacion con autocorreccion se ejecuta desde el ambiente origen.");
      return;
    }
    if (hasUnsavedChanges) {
      setTab("code");
      setSavingMsg(unsavedBlockMessage);
      return;
    }
    setPendingAction("validate");
    setSavingMsg("Validando...");
    try {
      const result = await api<Validation>(`/api/functions/${id}/validate`, { method: "POST" });
      setValidation(result);
      setSavingMsg(result.blocking ? "Validacion con errores" : "Validacion lista");
      await loadLogHistory().catch(() => {});
      await load();
    } catch (e: any) {
      setSavingMsg("Error: " + e.message);
      await loadLogHistory().catch(() => {});
    } finally {
      setPendingAction(null);
    }
  }

  async function deploy() {
    if (pendingAction) return;
    if (promotedCopy && !canDeployPromotedCopy) {
      setSavingMsg("Esta copia ya tiene despliegue. Corrige en origen y vuelve a promover para redeployar.");
      return;
    }
    if (hasUnsavedChanges) {
      setTab("code");
      setSavingMsg(unsavedBlockMessage);
      return;
    }
    const version = normalizeDeployVersion(deployVersion || fn.active_deploy_version || "v1");
    setPendingAction("deploy");
    setDeployVersion(version);
    setSavingMsg(`Validando y desplegando ${version}...`);
    try {
      const result = await api<any>(`/api/functions/${id}/deploy`, {
        method: "POST",
        body: JSON.stringify({ version }),
      });
      if (result.validation) setValidation(result.validation);
      setSavingMsg(result.skipped ? `Ya estaba desplegada ${version}` : `Desplegado ${version}`);
      await loadLogHistory(version).catch(() => {});
    } catch (e: any) {
      setSavingMsg("Error: " + e.message);
      await loadLogHistory().catch(() => {});
    } finally {
      await load();
      setPendingAction(null);
    }
  }

  async function rollbackDeployment(deployment: Deployment) {
    if (pendingAction) return;
    if (!deployment.snapshot?.function) {
      setSavingMsg("Ese deployment no tiene snapshot para rollback.");
      return;
    }
    if (!confirm(`Volver a la version ${deployment.version}? Esto crea un nuevo deploy en ${fn?.environment_slug?.toUpperCase() || currentEnv.slug.toUpperCase()}.`)) {
      return;
    }
    setRollbackDeploymentId(deployment.id);
    setPendingAction(`rollback:${deployment.id}`);
    setSavingMsg(`Restaurando ${deployment.version}...`);
    try {
      const result = await api<any>(`/api/functions/${id}/deployments/${deployment.id}/rollback`, {
        method: "POST",
      });
      setValidation(result.validation || null);
      const restoredVersion = normalizeDeployVersion(result.rollback_from_version || deployment.version);
      setDeployVersion(restoredVersion);
      setSavingMsg(`Rollback a ${result.rollback_from_version || deployment.version} completado`);
      await loadLogHistory(restoredVersion).catch(() => {});
    } catch (e: any) {
      setSavingMsg("Error: " + e.message);
    } finally {
      await load();
      setRollbackDeploymentId("");
      setPendingAction(null);
    }
  }

  async function copyCurl(url: string) {
    try {
      await copyText(buildCurlCommand(fn, url));
      setCopiedCurl(true);
      setSavingMsg("cURL copiado");
      setTimeout(() => setCopiedCurl(false), 1800);
      setTimeout(() => setSavingMsg(""), 1800);
    } catch (error: any) {
      setSavingMsg("Error copiando cURL: " + (error?.message || "portapapeles no disponible"));
    }
  }

  async function del() {
    if (!confirm("Eliminar esta funcion?")) return;
    setPendingAction("delete");
    try {
      await api(`/api/functions/${id}`, { method: "DELETE" });
      router.push("/functions");
    } finally {
      setPendingAction(null);
    }
  }

  async function addSecret() {
    if (!secretKey) return;
    if (pendingAction) return;
    setPendingAction("secret");
    try {
      await api(`/api/functions/${id}/secrets`, { method: "POST", body: JSON.stringify({ key: secretKey, value: secretVal }) });
      setSecretKey("");
      setSecretVal("");
      await load();
      setSavingMsg("Secret de ambiente creado");
    } catch (e: any) {
      setSavingMsg("Error: " + e.message);
    } finally {
      setPendingAction(null);
    }
  }

  async function delSecret(sid: string) {
    if (pendingAction) return;
    setPendingAction(`secret:${sid}`);
    try {
      await api(`/api/secrets/${sid}`, { method: "DELETE" });
      await load();
    } finally {
      setPendingAction(null);
    }
  }

  async function generateToken() {
    if (pendingAction) return;
    setPendingAction("token");
    try {
      const token = await api<ApiToken>(`/api/functions/${id}/tokens`, {
        method: "POST",
        body: JSON.stringify({ name: tokenName || "default" }),
      });
      setNewToken(token);
      setTokenName("");
      setTokenValue("");
      await load();
    } finally {
      setPendingAction(null);
    }
  }

  async function uploadToken() {
    if (pendingAction || !tokenValue.trim()) return;
    setPendingAction("token-upload");
    try {
      const token = await api<ApiToken>(`/api/functions/${id}/tokens`, {
        method: "POST",
        body: JSON.stringify({
          name: tokenName || "manual",
          value: tokenValue,
        }),
      });
      setNewToken(token);
      setTokenName("");
      setTokenValue("");
      await load();
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteToken(tokenId: string) {
    if (pendingAction) return;
    setPendingAction(`token:${tokenId}`);
    try {
      await api(`/api/functions/${id}/tokens/${tokenId}`, { method: "DELETE" });
      if (newToken?.id === tokenId) setNewToken(null);
      await load();
    } finally {
      setPendingAction(null);
    }
  }

  function setFiles(files: SourceFile[], entrypoint = fn.entrypoint || files[0]?.path || "index.mjs") {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const entryFile = sorted.find((file) => file.path === entrypoint && !isFolderMarker(file.path)) || sorted.find((file) => !isFolderMarker(file.path)) || sorted[0];
    setFn({
      ...fn,
      files: sorted,
      entrypoint: entryFile?.path || entrypoint,
      code: entryFile?.content || "",
    });
  }

  function updateActiveFile(content: string) {
    const files = sourceFiles(fn);
    const currentPath = activePath || fn.entrypoint || files[0].path;
    const next = files.map((file) => file.path === currentPath ? { ...file, content } : file);
    setFiles(next, fn.entrypoint || currentPath);
  }

  function openAddFileModal() {
    const activeFolder = folderOf(activeFile?.path || activePath);
    const helper = basename(defaultHelperPath(fn.runtime));
    setNewFilePath(activeFolder ? `${activeFolder}/${helper}` : defaultHelperPath(fn.runtime));
    setFileError("");
    setFileModalOpen(true);
  }

  function openAddFolderModal() {
    const activeFolder = folderOf(activeFile?.path || activePath);
    setNewFolderPath(activeFolder ? `${activeFolder}/nueva-carpeta` : "nueva-carpeta");
    setFolderError("");
    setFolderModalOpen(true);
  }

  function createFile() {
    let path = "";
    try {
      path = normalizePath(newFilePath);
    } catch (error: any) {
      setFileError(error.message);
      return;
    }

    const files = sourceFiles(fn);
    if (files.some((file) => file.path === path)) {
      setFileError("Ese archivo ya existe en esta funcion.");
      return;
    }
    if (isFolderMarker(path)) {
      setFileError("Usa Nueva carpeta para crear directorios.");
      return;
    }

    const next = [...files, { path, content: "" }];
    setFiles(next, fn.entrypoint || files[0]?.path || path);
    setActivePath(path);
    setDeleteError("");
    setFileModalOpen(false);
    setNewFilePath("");
  }

  function createFolder() {
    let path = "";
    try {
      path = normalizePath(newFolderPath);
    } catch (error: any) {
      setFolderError(error.message);
      return;
    }

    const files = sourceFiles(fn);
    const exists = files.some((file) => file.path === `${path}/${FOLDER_MARKER}` || file.path.startsWith(`${path}/`));
    if (exists) {
      setFolderError("Esa carpeta ya existe en esta funcion.");
      return;
    }

    setFiles([...files, { path: `${path}/${FOLDER_MARKER}`, content: "" }], fn.entrypoint || files.find((file) => !isFolderMarker(file.path))?.path || "");
    setFolderModalOpen(false);
    setNewFolderPath("");
    setFolderError("");
    setDeleteError("");
  }

  function deleteFile(path: string) {
    const files = sourceFiles(fn);
    const realFiles = files.filter((file) => !isFolderMarker(file.path));
    if (realFiles.length <= 1) {
      setDeleteError("La funcion necesita al menos un archivo.");
      return;
    }
    if (!confirm(`Eliminar ${path}?`)) return;
    const next = files.filter((file) => file.path !== path);
    const nextEntry = fn.entrypoint === path ? next.find((file) => !isFolderMarker(file.path))?.path || next[0].path : fn.entrypoint || next.find((file) => !isFolderMarker(file.path))?.path || next[0].path;
    setFiles(next, nextEntry);
    setActivePath(nextEntry);
    setDeleteError("");
  }

  function deleteFolder(path: string) {
    const files = sourceFiles(fn);
    const prefix = `${path}/`;
    const next = files.filter((file) => !file.path.startsWith(prefix));
    const realFiles = next.filter((file) => !isFolderMarker(file.path));
    if (realFiles.length === files.filter((file) => !isFolderMarker(file.path)).length) {
      setDeleteError("No se encontro esa carpeta.");
      return;
    }
    if (realFiles.length === 0) {
      setDeleteError("La funcion necesita al menos un archivo.");
      return;
    }
    if (!confirm(`Eliminar la carpeta ${path} y todos sus archivos?`)) return;
    const nextEntry = fn.entrypoint?.startsWith(prefix) ? realFiles[0].path : fn.entrypoint || realFiles[0].path;
    setFiles(next, nextEntry);
    setActivePath((current) => current.startsWith(prefix) ? nextEntry : current);
    setDeleteError("");
  }

  const tabs = [
    { id: "code", label: "Codigo", icon: Code2 },
    { id: "secrets", label: "Secrets", icon: KeyRound },
    { id: "validation", label: "Validacion IA", icon: BrainCircuit },
    { id: "logs", label: "Logs", icon: FileText },
    { id: "deployments", label: "Deployments", icon: History },
    { id: "settings", label: "Configuracion", icon: Rocket },
  ] as const;

  const files = sourceFiles(fn);
  const visibleFiles = files.filter((file) => !isFolderMarker(file.path));
  const fileTree = buildFileTree(files);
  const activeFile = visibleFiles.find((file) => file.path === activePath) || visibleFiles.find((file) => file.path === fn.entrypoint) || visibleFiles[0] || files[0];
  const currentValidation: Validation | null = validation || (fn.validation_status ? {
    status: fn.validation_status,
    blocking: fn.validation_status === "failed",
    summary: fn.validation_summary || "",
    findings: [],
  } : null);
  const busy = Boolean(pendingAction);
  const saveDisabled = busy || baseReadOnly;
  const validationDisabled = busy || hasUnsavedChanges || baseReadOnly;
  const deployDisabled = busy || hasUnsavedChanges || (promotedCopy && !canDeployPromotedCopy);
  const deleteDisabled = busy || baseReadOnly;
  const deployTitle = promotedCopy
    ? canDeployPromotedCopy
      ? "Deploy inicial de la copia homologada"
      : "Ya tiene despliegue en este ambiente; corrige en origen y vuelve a promover"
    : hasUnsavedChanges
      ? unsavedBlockMessage
      : `Deploy ${selectedVersion}`;
  const renderFileTree = (nodes: FileTreeNode[], depth = 0): ReactNode => nodes.map((node) => {
    if (node.type === "folder") {
      return (
        <div key={`folder:${node.path}`}>
          <div
            className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5 hover:text-white"
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            <FolderOpen className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
            <span className="font-mono truncate flex-1">{node.name}</span>
            {!baseReadOnly && (
              <button
                type="button"
                onClick={() => deleteFolder(node.path)}
                className="opacity-0 group-hover:opacity-100 text-rose-300"
                title="Eliminar carpeta"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {renderFileTree(node.children, depth + 1)}
        </div>
      );
    }

    const active = node.path === activePath;
    const isEntry = node.path === fn.entrypoint;
    return (
      <div
        key={`file:${node.path}`}
        className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${active ? "bg-violet-500/15 text-white" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        <button onClick={() => setActivePath(node.path)} className="flex-1 min-w-0 text-left">
          <span className="font-mono truncate block">{node.name}</span>
        </button>
        {isEntry && <Star className="w-3.5 h-3.5 text-amber-300 fill-amber-300" />}
        {!baseReadOnly && (
          <button
            type="button"
            onClick={() => deleteFile(node.path)}
            className="opacity-0 group-hover:opacity-100 text-rose-300"
            title="Eliminar archivo"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  });

  return (
    <div>
      <Topbar
        title={fn.name}
        subtitle={`${routePreview} - ${runtimeLabel(fn.runtime)}`}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--panel-2)] border border-[var(--border)]">
              <History className="w-4 h-4 text-slate-400" />
              <input
                list="deploy-version-options"
                value={deployVersion}
                onChange={(e) => setDeployVersion(e.target.value)}
                onBlur={(e) => setDeployVersion(normalizeDeployVersion(e.target.value || selectedVersion))}
                className="bg-transparent outline-none text-sm font-mono w-20"
                aria-label="Version de deploy"
              />
              <datalist id="deploy-version-options">
                {availableVersions.map((version) => <option key={version} value={version} />)}
              </datalist>
            </div>
            <button onClick={save} disabled={saveDisabled} className="btn-ghost" title={baseReadOnly ? "La configuracion base se cambia desde el ambiente origen" : "Guardar cambios"}>
              {pendingAction === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Guardar
            </button>
            <button onClick={runValidation} disabled={validationDisabled} className="btn-ghost" title={baseReadOnly ? "Valida y corrige desde el ambiente origen" : hasUnsavedChanges ? unsavedBlockMessage : "Validar funcion"}>
              {pendingAction === "validate" ? <Loader2 className="w-4 h-4 animate-spin" /> : <BrainCircuit className="w-4 h-4" />}
              Validar
            </button>
            <button onClick={deploy} disabled={deployDisabled} className="btn-primary" title={deployTitle}>
              {pendingAction === "deploy" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
              Deploy {selectedVersion}
            </button>
            <button onClick={del} disabled={deleteDisabled} className="btn-danger" title={baseReadOnly ? "No se elimina una copia homologada desde destino" : "Eliminar funcion"}>
              {pendingAction === "delete" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </button>
          </div>
        }
      />

      <div className="card mb-5 flex flex-wrap items-center gap-4">
        <StatusBadge status={fn.status} />
        {fn.project_name && <span className="chip" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{fn.project_name}</span>}
        {fn.environment_slug && <span className="chip uppercase" style={{ borderColor: "rgba(34,211,238,.35)", color: "#67e8f9", background: "rgba(34,211,238,.08)" }}>{fn.environment_slug}</span>}
        <span className="chip font-mono" style={{ borderColor: "rgba(139,92,246,.45)", color: "#c4b5fd", background: "rgba(139,92,246,.08)" }}>{selectedVersion}</span>
        {promotedCopy && (
          <span className="chip" style={{ borderColor: "rgba(245,158,11,.35)", color: "#fcd34d", background: "rgba(245,158,11,.10)" }}>
            Homologada
          </span>
        )}
        <span className="text-sm text-slate-400 font-mono">{routePreview}</span>
        {fn.validation_status && <StatusBadge status={fn.validation_status} />}
        {hasUnsavedChanges && (
          <span className="chip" style={{ borderColor: "rgba(245,158,11,.35)", color: "#fcd34d", background: "rgba(245,158,11,.10)" }}>
            Cambios sin guardar
          </span>
        )}
        {selectedDeploymentUrl ? (
          <div className="flex flex-wrap items-center gap-2">
            <a href={selectedDeploymentUrl} target="_blank" className="text-violet-300 text-sm flex items-center gap-1 hover:underline">
              <ExternalLink className="w-3.5 h-3.5" /> {selectedDeploymentUrl}
            </a>
            <button type="button" onClick={() => copyCurl(selectedDeploymentUrl)} className="text-cyan-300 text-xs inline-flex items-center gap-1 hover:underline" title="Copiar cURL">
              {copiedCurl ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedCurl ? "Copiado" : "cURL"}
            </button>
          </div>
        ) : (
          <span className="text-xs text-slate-500">Sin URL para esta version</span>
        )}
        {savingMsg && <span className="text-xs text-slate-400 ml-auto">{savingMsg}</span>}
      </div>

      {promotedCopy && (
        <div className="card mb-5 border-amber-500/25 bg-amber-500/5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-amber-100">Funcion homologada desde un ambiente anterior</h3>
              <p className="mt-1 text-sm text-slate-400">
                Codigo, runtime, memoria y auth base se corrigen en el ambiente origen. En este ambiente puedes revisar logs, deployments, secrets y administrar API keys propias.
              </p>
            </div>
            <StatusBadge
              status={canDeployPromotedCopy ? "idle" : promotedHasDeployment ? "active" : fn.status}
              label={canDeployPromotedCopy ? "pendiente deploy" : promotedHasDeployment ? "desplegada" : fn.status}
            />
          </div>
          {canDeployPromotedCopy && (
            <p className="mt-3 text-xs text-amber-200">
              Esta copia todavia no tiene deploy asociado en {fn.environment_slug?.toUpperCase() || currentEnv.slug.toUpperCase()}; puedes ejecutar el deploy inicial desde este ambiente.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <div className="flex flex-wrap gap-1 border-b border-[var(--border)] mb-4 -mx-5 px-5">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm transition ${active ? "border-b-2 border-violet-400 text-white" : "text-slate-400 hover:text-white"}`}>
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>

        {tab === "code" && (
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
            <div className="rounded-lg border border-[var(--border)] bg-black/30 overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--border)]">
                <div className="min-w-0">
                  <div className="text-xs text-slate-500">Directorio</div>
                  <div className="text-sm font-semibold truncate">{selectedVersion}/{fn.slug}/</div>
                </div>
                {!baseReadOnly && (
                  <div className="flex items-center gap-1">
                    <button onClick={openAddFolderModal} className="btn-ghost h-8 w-8 p-0" title="Nueva carpeta">
                      <FolderPlus className="w-4 h-4" />
                    </button>
                    <button onClick={openAddFileModal} className="btn-ghost h-8 w-8 p-0" title="Nuevo archivo">
                      <FilePlus2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
              <div className="p-2 max-h-[520px] overflow-auto">
                {fileTree.length === 0 ? (
                  <div className="px-2 py-8 text-center text-xs text-slate-500">Sin archivos.</div>
                ) : renderFileTree(fileTree)}
              </div>
              <div className="px-3 py-2 border-t border-[var(--border)] text-[11px] text-slate-500">
                {deleteError || "El archivo con estrella es el entrypoint; las carpetas se guardan junto con la funcion."}
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2 text-xs text-slate-500">
                <span className="px-2 py-0.5 rounded bg-[var(--panel-2)] border border-[var(--border)]">{activeFile?.path || fn.entrypoint || "index.mjs"}</span>
                <span>{runtimeLabel(fn.runtime)}</span>
                <div className="ml-auto flex items-center gap-2 min-w-[300px]">
                  <Search className="w-3.5 h-3.5 text-slate-500" />
                  <input
                    value={codeSearch}
                    onChange={(e) => setCodeSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        moveCodeSearch(e.shiftKey ? -1 : 1);
                      }
                    }}
                    placeholder="Buscar en codigo..."
                    className="bg-[var(--panel-2)] border border-[var(--border)] rounded-md px-2 py-1 text-xs outline-none focus:border-violet-500 flex-1"
                  />
                  {codeSearchStats.query && (
                    <>
                      <span className="font-mono text-slate-400 w-14 text-right">{codeSearchStats.current}/{codeSearchStats.count}</span>
                      <button type="button" onClick={() => moveCodeSearch(-1)} disabled={!codeSearchStats.count} className="btn-ghost h-7 w-7 p-0 disabled:opacity-40" title="Coincidencia anterior">
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => moveCodeSearch(1)} disabled={!codeSearchStats.count} className="btn-ghost h-7 w-7 p-0 disabled:opacity-40" title="Siguiente coincidencia">
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
                {hasUnsavedChanges && <span className="text-amber-300">{unsavedBlockMessage}</span>}
                {!baseReadOnly && activeFile?.path !== fn.entrypoint && activeFile?.path && (
                  <button onClick={() => setFn({ ...fn, entrypoint: activeFile.path, code: activeFile.content })} className="text-violet-300 hover:underline">
                    Marcar principal
                  </button>
                )}
              </div>
              <CodeEditor
                value={activeFile?.content ?? fn.code}
                fileName={activeFile?.path || fn.entrypoint || "index"}
                onChange={updateActiveFile}
                runtime={fn.runtime}
                search={codeSearch}
                searchIndex={codeSearchIndex}
                searchAction={codeSearchAction}
                onSearchStats={handleCodeSearchStats}
                readOnly={baseReadOnly}
              />
            </div>
          </div>
        )}

        {tab === "secrets" && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input placeholder="KEY" value={secretKey} onChange={(e) => setSecretKey(e.target.value.toUpperCase())} className="input w-48" />
              <input placeholder="value" value={secretVal} onChange={(e) => setSecretVal(e.target.value)} className="input flex-1" />
              <button onClick={addSecret} disabled={busy} className="btn-primary">
                {pendingAction === "secret" && <Loader2 className="w-4 h-4 animate-spin" />}
                Anadir
              </button>
            </div>
            <div className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
              {fn.secrets.length === 0 && <div className="p-6 text-sm text-slate-500 text-center">Sin secrets configurados.</div>}
              {fn.secrets.map((s) => (
                <div key={s.id} className="p-3 flex items-center justify-between text-sm">
                  <div><span className="font-mono text-violet-300">{s.key}</span> <span className="text-slate-500 ml-2">= ********</span></div>
                  <button onClick={() => delSecret(s.id)} disabled={busy} className="text-rose-400 hover:text-rose-300 text-xs inline-flex items-center gap-1 disabled:opacity-60">
                    {pendingAction === `secret:${s.id}` && <Loader2 className="w-3 h-3 animate-spin" />}
                    eliminar
                  </button>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500">Estos son secrets del ambiente de la funcion. No se permite repetir la misma KEY dentro del mismo proyecto y ambiente.</p>
          </div>
        )}

        {tab === "validation" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold">Validacion previa al deploy</h3>
                <p className="text-sm text-slate-400 mt-1">Bloquea errores de sintaxis, runtime incompatible y hallazgos criticos de IA.</p>
              </div>
              <button onClick={runValidation} disabled={validationDisabled} className="btn-primary" title={baseReadOnly ? "Valida y corrige desde el ambiente origen" : hasUnsavedChanges ? unsavedBlockMessage : "Validar ahora"}>
                {pendingAction === "validate" ? <Loader2 className="w-4 h-4 animate-spin" /> : <BrainCircuit className="w-4 h-4" />}
                Validar ahora
              </button>
            </div>

            {!currentValidation && <div className="rounded-lg border border-dashed border-[var(--border-2)] text-center text-slate-500 py-10">Sin validaciones todavia.</div>}
            {currentValidation && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-4">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <StatusBadge status={currentValidation.status} />
                  <span className="text-xs text-slate-500">{currentValidation.blocking ? "Bloquea deploy" : "Deploy permitido"}</span>
                </div>
                <p className="text-sm text-slate-300">{currentValidation.summary}</p>
                {currentValidation.findings?.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {currentValidation.findings.map((finding, idx) => (
                      <div key={idx} className="rounded-md bg-black/30 border border-[var(--border)] p-3 text-sm">
                        <span className="font-mono text-xs text-slate-500 mr-2">{finding.severity}</span>
                        <span>{finding.message}</span>
                        {finding.line && <span className="text-slate-500 ml-2">Linea {finding.line}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {currentValidation.repair?.attempted && (
                  <div className="mt-4 rounded-lg border border-cyan-500/25 bg-cyan-500/10 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold text-cyan-100">Autocorreccion IA</span>
                      <span className={`chip ${currentValidation.repair.applied ? "text-emerald-300 border-emerald-500/30" : "text-amber-300 border-amber-500/30"}`}>
                        {currentValidation.repair.applied ? "Aplicada" : "Omitida"}
                      </span>
                    </div>
                    {currentValidation.repair.summary && <p className="text-slate-300 mt-2">{currentValidation.repair.summary}</p>}
                    {(currentValidation.repair.changes || []).length > 0 && (
                      <div className="mt-3 space-y-1">
                        {currentValidation.repair.changes?.map((change, idx) => (
                          <div key={idx} className="text-xs text-slate-300">
                            {change.path && <span className="font-mono text-cyan-200 mr-2">{change.path}</span>}
                            {change.message}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "logs" && (
          <div className="rounded-lg border border-[var(--border)] bg-black/50 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border)]">
              <div>
                <h3 className="font-semibold text-sm">Transacciones</h3>
                <p className="text-xs text-slate-500">Request, response, errores y eventos del runtime para {selectedVersion}.</p>
              </div>
              <span className="chip" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{logs.length} eventos</span>
            </div>
            <div ref={logContainerRef} className="h-[480px] overflow-auto font-mono text-xs divide-y divide-[var(--border)]">
              {logs.length === 0 && <div className="text-slate-500 p-4">Esperando logs...</div>}
              {logs.map((entry, i) => {
                const parsed = parseLog(entry);
                return (
                  <div key={i} className={`grid grid-cols-1 xl:grid-cols-[86px_150px_130px_1fr] gap-2 px-4 py-3 ${logTextClass(parsed.level)}`}>
                    <div className="flex items-start">
                      <span className={`chip font-sans text-[10px] leading-none ${logLevelClass(parsed.level)}`}>{parsed.level}</span>
                    </div>
                    <div className="text-slate-500">{entry.ts ? new Date(entry.ts).toLocaleString() : new Date().toLocaleString()}</div>
                    <div className="text-slate-400">
                      {parsed.tx ? <span className="text-cyan-200">tx {parsed.tx}</span> : <span>-</span>}
                    </div>
                    <div className="min-w-0">
                      {parsed.structured ? (
                        <div className="rounded-md border border-[var(--border)] bg-black/30 p-3">
                          <div className="flex flex-wrap items-center gap-2 mb-3">
                            <span className="chip font-sans text-[10px] leading-none" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>
                              {parsed.structured.type || "JSON"}
                            </span>
                            {parsed.method ? <span className="text-violet-200">{parsed.method}</span> : null}
                            {parsed.path ? <span className="text-slate-300 break-all">{parsed.path}</span> : null}
                            {parsed.status ? <span className="chip font-sans text-[10px]" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{parsed.status}</span> : null}
                            {parsed.duration ? <span className="text-slate-500">{parsed.duration}ms</span> : null}
                          </div>
                          <pre className="whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-300">{parsed.pretty || parsed.raw}</pre>
                        </div>
                      ) : (
                        <>
                          {parsed.method ? (
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <span className="text-violet-200">{parsed.method}</span>
                              <span className="text-slate-300 break-all">{parsed.path}</span>
                              <span className="chip font-sans text-[10px]" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{parsed.status}</span>
                              <span className="text-slate-500">{parsed.duration}ms</span>
                            </div>
                          ) : null}
                          <div className="whitespace-pre-wrap break-words text-slate-400">{parsed.raw}</div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "deployments" && (
          <div className="rounded-lg border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel-2)] text-xs uppercase text-slate-500">
                <tr>
                  <th className="text-left px-4 py-3">Version</th>
                  <th className="text-left px-4 py-3">Uso</th>
                  <th className="text-left px-4 py-3">Cambios</th>
                  <th className="text-left px-4 py-3">URL</th>
                  <th className="text-left px-4 py-3">Validacion</th>
                  <th className="text-left px-4 py-3">Estado</th>
                  <th className="text-left px-4 py-3">Fecha</th>
                  <th className="text-left px-4 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {deployments.length === 0 && <tr><td colSpan={8} className="text-center text-slate-500 py-10">Sin deployments.</td></tr>}
                {deployments.map((deployment) => (
                  <tr key={deployment.id} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3 font-mono text-xs">{deployment.version}</td>
                    <td className="px-4 py-3">
                      {deployment.status === "success" ? (
                        <StatusBadge status={deployment.active ? "active" : "deprecated"} />
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                      {deployment.status === "success" && !deployment.active && (
                        <div className="text-[11px] text-slate-500 mt-1">{deployment.deprecated_reason || "Solo trafico existente"}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="max-w-xl space-y-2">
                        <div className="text-sm text-slate-200">{deployment.change_summary || "Sin notas de version"}</div>
                        {Array.isArray(deployment.change_details) && deployment.change_details.length > 0 && (
                          <details className="text-xs text-slate-400">
                            <summary className="cursor-pointer text-violet-300 hover:text-violet-200">Ver detalles</summary>
                            <ul className="mt-2 space-y-1">
                              {deployment.change_details.map((detail, index) => (
                                <li key={`${deployment.id}-change-${index}`} className="flex flex-wrap gap-x-2 gap-y-1">
                                  <span className="chip" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>{detail.label || "Cambio"}</span>
                                  <span>{detail.message || "Actualizacion registrada"}</span>
                                  {detail.before !== undefined && detail.after !== undefined ? (
                                    <span className="text-slate-500">
                                      {detail.before || "-"} → {detail.after || "-"}
                                    </span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {deployment.url && deployment.active ? (
                        <a href={deployment.url} target="_blank" className="text-violet-300 hover:underline">{deployment.url}</a>
                      ) : deployment.url ? (
                        <span className="text-slate-500" title="Deployment deprecado; no se puede abrir desde la plataforma.">URL deprecada</span>
                      ) : (
                        <span className="text-slate-600">/{normalizeDeployVersion(deployment.version)}/{fn.slug}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{deployment.validation_status ? <StatusBadge status={deployment.validation_status} /> : "-"}</td>
                    <td className="px-4 py-3"><StatusBadge status={deployment.status} /></td>
                    <td className="px-4 py-3 text-xs text-slate-500">{new Date(deployment.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      {deployment.status === "success" && !deployment.active && deployment.snapshot?.function ? (
                        <button
                          type="button"
                          onClick={() => rollbackDeployment(deployment)}
                          disabled={busy || rollbackDeploymentId === deployment.id}
                          className="btn-ghost inline-flex items-center gap-2 disabled:opacity-60"
                          title={`Rollback a ${deployment.version}`}
                        >
                          {rollbackDeploymentId === deployment.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <History className="w-4 h-4" />}
                          Rollback
                        </button>
                      ) : (
                        <span className="text-xs text-slate-600">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "settings" && (
          <div className="space-y-4 max-w-xl">
            <div>
              <label className="text-xs text-slate-400">Nombre</label>
              <input className="input mt-1 disabled:opacity-60" value={fn.name} onChange={(e) => setFn({ ...fn, name: e.target.value })} disabled={baseReadOnly} />
            </div>
            <div>
              <label className="text-xs text-slate-400">Descripcion</label>
              <textarea className="input mt-1 disabled:opacity-60" rows={3} value={fn.description || ""} onChange={(e) => setFn({ ...fn, description: e.target.value })} disabled={baseReadOnly} />
            </div>
            <div>
              <label className="text-xs text-slate-400">Runtime</label>
                <select className="input mt-1 disabled:opacity-60" value={fn.runtime || "node20"} onChange={(e) => setFn({ ...fn, runtime: e.target.value })} disabled={baseReadOnly}>
                  <option value="node20">Node 20</option>
                  <option value="deno">Deno</option>
                  <option value="python311">Python 3.11</option>
                  <option value="java-spring">Java Spring Boot</option>
                  <option value="dotnet8">.NET 8 C#</option>
                  <option value="custom">Custom Dockerfile</option>
                </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400">Memoria funcion</label>
                <select
                  className="input mt-1 disabled:opacity-60"
                  value={fn.memory_mb || 256}
                  onChange={(e) => setFn({ ...fn, memory_mb: Number(e.target.value) })}
                  disabled={baseReadOnly}
                >
                  {MEMORY_OPTIONS.map((memory) => <option key={memory} value={memory}>{memory} MB</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400">Timeout segundos</label>
                <input type="number" className="input mt-1 disabled:opacity-60" value={fn.timeout_seconds || 30} onChange={(e) => setFn({ ...fn, timeout_seconds: Number(e.target.value) })} disabled={baseReadOnly} />
              </div>
            </div>
            <p className="text-xs text-slate-500">
              La memoria queda como referencia operativa de la funcion; no bloquea el deploy por suma de MB del ambiente.
            </p>
            <div>
              <label className="text-xs text-slate-400">Slug</label>
              <input className="input mt-1" value={fn.slug} disabled />
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-black/20 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-sm">Auth por API key</h3>
                  <p className="text-xs text-slate-500 mt-1">El consumidor envia el token en este header. Node, Deno export default, Python, Java y .NET lo validan en la plataforma; Deno.serve directo y Custom Dockerfile deben validarlo dentro del codigo.</p>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" checked={Boolean(fn.auth_required)} onChange={(e) => setFn({ ...fn, auth_required: e.target.checked })} disabled={baseReadOnly} />
                  Requerir token
                </label>
              </div>
              <div>
                <label className="text-xs text-slate-400">Header</label>
                <input className="input mt-1 font-mono disabled:opacity-60" value={fn.auth_header_name || "x-api-key"} onChange={(e) => setFn({ ...fn, auth_header_name: e.target.value })} disabled={baseReadOnly} />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr_auto_auto] gap-2">
                <input className="input" placeholder="Nombre del token" value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
                <input className="input font-mono" placeholder="Pega una clave existente" value={tokenValue} onChange={(e) => setTokenValue(e.target.value)} />
                <button type="button" onClick={uploadToken} disabled={busy || !tokenValue.trim()} className="btn-ghost disabled:opacity-50">
                  {pendingAction === "token-upload" && <Loader2 className="w-4 h-4 animate-spin" />}
                  Cargar clave
                </button>
                <button type="button" onClick={generateToken} disabled={busy} className="btn-primary">
                  {pendingAction === "token" && <Loader2 className="w-4 h-4 animate-spin" />}
                  Generar token
                </button>
              </div>
              {newToken && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                  <div className="text-emerald-200 font-medium">Token generado</div>
                  <div className="font-mono text-xs text-emerald-100 mt-1 break-all">{newToken.value}</div>
                </div>
              )}
              <div className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
                {(fn.api_tokens || []).length === 0 && <div className="p-3 text-xs text-slate-500">Sin tokens generados.</div>}
                {(fn.api_tokens || []).map((token) => (
                  <div key={token.id} className="p-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                    <div>
                      <div className="font-medium">{token.name}</div>
                      <div className="font-mono text-xs text-slate-500">{token.value}</div>
                    </div>
                    <button type="button" onClick={() => deleteToken(token.id)} disabled={busy} className="text-rose-400 hover:text-rose-300 text-xs inline-flex items-center gap-1 disabled:opacity-60">
                      {pendingAction === `token:${token.id}` && <Loader2 className="w-3 h-3 animate-spin" />}
                      eliminar
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <button onClick={save} disabled={saveDisabled} className="btn-primary disabled:opacity-50">
              {pendingAction === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Guardar cambios
            </button>
          </div>
        )}
      </div>

      {fileModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--border)]">
              <div>
                <h3 className="font-semibold">Nuevo archivo</h3>
                <p className="text-xs text-slate-500 font-mono mt-1">{selectedVersion}/{fn.slug}/</p>
              </div>
              <button onClick={() => setFileModalOpen(false)} className="btn-ghost h-8 w-8 p-0" aria-label="Cerrar">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400">Ruta</label>
                <input
                  autoFocus
                  value={newFilePath}
                  onChange={(e) => { setNewFilePath(e.target.value); setFileError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") createFile(); }}
                  className="input mt-1 font-mono"
                  placeholder={defaultHelperPath(fn.runtime)}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[defaultHelperPath(fn.runtime), `routes/${fn.slug}.${fn.runtime === "deno" ? "ts" : fn.runtime === "python311" ? "py" : fn.runtime === "java-spring" ? "java" : fn.runtime === "dotnet8" ? "cs" : "mjs"}`].map((path) => (
                  <button key={path} onClick={() => { setNewFilePath(path); setFileError(""); }} className="text-left rounded-lg border border-[var(--border)] bg-black/20 px-3 py-2 text-xs font-mono text-slate-300 hover:border-violet-500">
                    {path}
                  </button>
                ))}
              </div>
              {fileError && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{fileError}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--border)]">
              <button onClick={() => setFileModalOpen(false)} className="btn-ghost">Cancelar</button>
              <button onClick={createFile} className="btn-primary"><FilePlus2 className="w-4 h-4" /> Crear archivo</button>
            </div>
          </div>
        </div>
      )}

      {folderModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl">
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--border)]">
              <div>
                <h3 className="font-semibold">Nueva carpeta</h3>
                <p className="text-xs text-slate-500 font-mono mt-1">{selectedVersion}/{fn.slug}/</p>
              </div>
              <button onClick={() => setFolderModalOpen(false)} className="btn-ghost h-8 w-8 p-0" aria-label="Cerrar">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400">Ruta</label>
                <input
                  autoFocus
                  value={newFolderPath}
                  onChange={(e) => { setNewFolderPath(e.target.value); setFolderError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") createFolder(); }}
                  className="input mt-1 font-mono"
                  placeholder="services/auth"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {["_shared", "routes", "services", "lib"].map((path) => (
                  <button key={path} onClick={() => { setNewFolderPath(path); setFolderError(""); }} className="text-left rounded-lg border border-[var(--border)] bg-black/20 px-3 py-2 text-xs font-mono text-slate-300 hover:border-violet-500">
                    {path}
                  </button>
                ))}
              </div>
              {folderError && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{folderError}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--border)]">
              <button onClick={() => setFolderModalOpen(false)} className="btn-ghost">Cancelar</button>
              <button onClick={createFolder} className="btn-primary"><FolderPlus className="w-4 h-4" /> Crear carpeta</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

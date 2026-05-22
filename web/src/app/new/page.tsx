"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useCurrentEnvironment } from "@/lib/environment";
import { Topbar } from "@/components/Topbar";
import { CodeEditor } from "@/components/CodeEditor";
import { CheckCircle2, FileText, FolderKanban, FolderOpen, Rocket, Server, UploadCloud } from "lucide-react";

const TEMPLATE = `export default async function handler(req) {
  const name = new URL(req.url).searchParams.get("name") ?? "world";
  return new Response(JSON.stringify({ hello: name, env: process.env.GREETING ?? null }), {
    headers: { "content-type": "application/json" }
  });
}
`;

type Project = { id: string; name: string; slug: string };
type Environment = { id: string; name: string; slug: string; project_id: string };
type SourceFile = { path: string; content: string };
type TemplateItem = { id: string; name: string; slug: string; runtime: string; code: string; files?: SourceFile[]; entrypoint?: string };
const MEMORY_OPTIONS = [128, 256, 512, 1024, 2048, 4096];

function looksLikeDockerfile(content = "") {
  const lines = String(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines.find((line) => !line.startsWith("#") || /^#\s*syntax=docker\/dockerfile\b/i.test(line)) || "";
  if (!first) return false;
  if (/^#\s*syntax=docker\/dockerfile\b/i.test(first)) return true;
  if (/^ARG\s+[A-Z_][A-Z0-9_]*(=.+)?$/i.test(first)) return lines.some((line) => /^FROM\s+\S+/i.test(line));
  return /^FROM\s+\S+/i.test(first);
}

function detectRuntime(code: string) {
  if (looksLikeDockerfile(code)) return "custom";
  if (/\b(@SpringBootApplication|@RestController|@GetMapping|@PostMapping|org\.springframework|public\s+class)\b|<artifactId>spring-boot|pom\.xml/m.test(code)) return "java-spring";
  if (/\b(WebApplication\.CreateBuilder|MapGet\s*\(|MapPost\s*\(|Results\.Json|Microsoft\.AspNetCore)\b|<Project\s+Sdk="Microsoft\.NET\.Sdk\.Web"/m.test(code)) return "dotnet8";
  if (/\b(def\s+handler\s*\(|import\s+os|from\s+flask|FastAPI)\b|\.py$/m.test(code)) return "python311";
  if (/\bDeno\.|from\s+["']npm:|import\s*\(\s*["']npm:|:\s*(Request|Response|unknown|string|number|boolean)\b|interface\s+\w+|type\s+\w+\s*=/m.test(code)) {
    return "deno";
  }
  return "node20";
}

function detectRuntimeFromFiles(files: SourceFile[]) {
  const joined = files.map((file) => `${file.path}\n${file.content}`).join("\n\n");
  if (files.some((file) => /^dockerfile$/i.test(file.path.split("/").pop() || "") && looksLikeDockerfile(file.content))) return "custom";
  if (files.some((file) => /(^|\/)pom\.xml$/i.test(file.path) || /\.java$/i.test(file.path)) || /\b(@SpringBootApplication|@RestController|@GetMapping|@PostMapping|org\.springframework)\b/m.test(joined)) return "java-spring";
  if (files.some((file) => /\.(cs|csproj)$/i.test(file.path)) || /\b(WebApplication\.CreateBuilder|MapGet\s*\(|MapPost\s*\(|Results\.Json|Microsoft\.AspNetCore)\b/m.test(joined)) return "dotnet8";
  if (files.some((file) => /\.py$/i.test(file.path)) || /\b(def\s+handler\s*\(|import\s+os|from\s+flask|FastAPI)\b/m.test(joined)) return "python311";
  if (/\bDeno\.|from\s+["']npm:|import\s*\(\s*["']npm:|:\s*(Request|Response|unknown|string|number|boolean)\b|interface\s+\w+|type\s+\w+\s*=/m.test(joined)) {
    return "deno";
  }
  if (files.some((file) => /\.ts$/i.test(file.path))) return "deno";
  return detectRuntime(joined);
}

function runtimeLabel(runtime: string) {
  if (runtime === "python311") return "Python 3.11";
  if (runtime === "java-spring") return "Java Spring Boot";
  if (runtime === "dotnet8") return ".NET 8 C#";
  if (runtime === "custom") return "Custom Dockerfile";
  return runtime === "deno" ? "Deno" : "Node 20";
}

function entrypointFor(runtime: string) {
  if (runtime === "python311") return "index.py";
  if (runtime === "java-spring") return "src/main/java/com/example/demo/controller/TestController.java";
  if (runtime === "dotnet8") return "Program.cs";
  if (runtime === "custom") return "Dockerfile";
  return runtime === "deno" ? "index.ts" : "index.mjs";
}

function normalizeBrowserFilePath(path: string) {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function stripCommonRoot(paths: string[]) {
  const firstParts = paths[0]?.split("/") || [];
  if (firstParts.length <= 1) return { root: "", paths };
  const root = firstParts[0];
  if (!paths.every((path) => path.split("/")[0] === root)) return { root: "", paths };
  return {
    root,
    paths: paths.map((path) => path.split("/").slice(1).join("/")).filter(Boolean),
  };
}

function pickEntrypoint(files: SourceFile[], runtime: string) {
  const candidates = [
    entrypointFor(runtime),
    "index.ts",
    "index.mjs",
    "index.js",
    "index.py",
    "Program.cs",
    "Api.csproj",
    "pom.xml",
    "src/main/java/com/example/demo/controller/TestController.java",
    "src/main/java/com/example/demo/DemoApplication.java",
    "handler.ts",
    "handler.mjs",
    "handler.js",
    "handler.py",
    "Dockerfile",
  ];
  return candidates.find((path) => files.some((file) => file.path === path)) || files[0]?.path || entrypointFor(runtime);
}

function NewFnInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const currentEnv = useCurrentEnvironment();
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(sp.get("name") || "");
  const [desc, setDesc] = useState("");
  const [code, setCode] = useState(sp.get("code") || TEMPLATE);
  const [importedFiles, setImportedFiles] = useState<SourceFile[] | null>(null);
  const [importedEntrypoint, setImportedEntrypoint] = useState("");
  const [importSummary, setImportSummary] = useState("");
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [projectId, setProjectId] = useState(sp.get("project_id") || "");
  const [environmentId, setEnvironmentId] = useState("");
  const [runtimeMode, setRuntimeMode] = useState("auto");
  const [memoryMb, setMemoryMb] = useState(256);
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);

  useEffect(() => {
    const templateId = sp.get("template_id");
    if (!templateId) return;
    api<TemplateItem[]>("/api/templates")
      .then((items) => {
        const template = (items || []).find((item) => item.id === templateId || item.slug === templateId);
        if (!template) return;
        const files = template.files?.length ? template.files : [{ path: template.entrypoint || entrypointFor(template.runtime), content: template.code }];
        const entry = template.entrypoint || pickEntrypoint(files, template.runtime);
        const entryFile = files.find((file) => file.path === entry) || files[0];
        setName((current) => current || template.slug);
        setDesc(template.name);
        setImportedFiles(files);
        setImportedEntrypoint(entry);
        setCode(entryFile?.content || template.code || "");
        setRuntimeMode(template.runtime || "auto");
        setImportSummary(`${files.length} archivo(s) cargados desde template ${template.name}`);
        setStep(2);
      })
      .catch((error) => setErr(error.message));
  }, []);

  useEffect(() => {
    api<Project[]>("/api/projects")
      .then((items) => {
        setProjects(items || []);
        if (!projectId && items?.[0]) setProjectId(items[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!projectId) {
      setEnvironments([]);
      setEnvironmentId("");
      return;
    }
    api<Environment[]>(`/api/environments?project_id=${projectId}`)
      .then((items) => {
        setEnvironments(items || []);
        const scoped = items?.find((env) => env.slug === currentEnv.slug) || items?.[0];
        setEnvironmentId(scoped?.id || "");
      })
      .catch(() => {});
  }, [projectId, currentEnv.slug]);

  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projects, projectId]);
  const selectedEnv = useMemo(() => environments.find((env) => env.id === environmentId), [environments, environmentId]);
  const detectedRuntime = useMemo(() => importedFiles?.length ? detectRuntimeFromFiles(importedFiles) : detectRuntime(code), [code, importedFiles]);
  const runtime = runtimeMode === "auto" ? detectedRuntime : runtimeMode;
  const entrypoint = importedFiles?.length ? (importedEntrypoint || pickEntrypoint(importedFiles, runtime)) : entrypointFor(runtime);
  const finalFiles = useMemo(() => {
    if (!importedFiles?.length) return [{ path: entrypoint, content: code }];
    return importedFiles.map((file) => file.path === entrypoint ? { ...file, content: code } : file);
  }, [code, entrypoint, importedFiles]);

  async function importFolder(e: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    e.target.value = "";
    if (!selected.length) return;

    setBusy(true);
    setErr(null);
    try {
      const rawPaths = selected.map((file) => normalizeBrowserFilePath((file as any).webkitRelativePath || file.name));
      const stripped = stripCommonRoot(rawPaths);
      const files = await Promise.all(selected.map(async (file, index) => ({
        path: stripped.paths[index] || file.name,
        content: await file.text(),
      })));
      const unique = new Map<string, SourceFile>();
      for (const file of files) {
        if (!file.path || unique.has(file.path)) continue;
        unique.set(file.path, file);
      }
      const nextFiles = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
      if (!nextFiles.length) throw new Error("No se encontraron archivos para importar.");
      const nextRuntime = detectRuntimeFromFiles(nextFiles);
      const nextEntrypoint = pickEntrypoint(nextFiles, nextRuntime);
      const entryFile = nextFiles.find((file) => file.path === nextEntrypoint) || nextFiles[0];

      setImportedFiles(nextFiles);
      setImportedEntrypoint(nextEntrypoint);
      setCode(entryFile.content);
      setRuntimeMode("auto");
      setImportSummary(`${nextFiles.length} archivo(s) importados desde ${stripped.root || "la carpeta seleccionada"}`);
      if (!name.trim() && stripped.root) setName(stripped.root);
      if (!desc.trim()) setDesc(`Importada desde carpeta local con ${nextFiles.length} archivo(s).`);
      setStep(2);
    } catch (error: any) {
      setErr(error?.message || "No se pudo importar la carpeta.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const fn = await api<any>("/api/functions", {
        method: "POST",
        body: JSON.stringify({
          name,
          description: desc,
          code,
          files: finalFiles,
          entrypoint,
          project_id: projectId || null,
          environment_id: environmentId || null,
          runtime,
          memory_mb: memoryMb,
          timeout_seconds: timeoutSeconds,
        }),
      });
      router.push(`/functions/${fn.id}`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  const steps = ["Información", "Código", "Configuración", "Revisión"];

  return (
    <div>
      <Topbar title="Crear Función" subtitle={`Crea funciones directamente en ${currentEnv.label}`} />

      <div className="card mb-6">
        <div className="flex items-center justify-between">
          {steps.map((s, i) => {
            const n = i + 1;
            const active = step === n;
            const done = step > n;
            return (
              <div key={s} className="flex items-center flex-1 min-w-0">
                <div className={`w-8 h-8 rounded-full grid place-items-center text-xs font-semibold border ${done ? "bg-emerald-500/20 border-emerald-400 text-emerald-300" : active ? "bg-violet-500/20 border-violet-400 text-violet-200" : "bg-slate-800 border-slate-700 text-slate-500"}`}>
                  {done ? <CheckCircle2 className="w-4 h-4" /> : n}
                </div>
                <div className={`ml-2 text-sm truncate ${active ? "text-white" : "text-slate-500"}`}>{s}</div>
                {i < steps.length - 1 && <div className="flex-1 h-px bg-[var(--border)] mx-3" />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="card lg:col-span-2">
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="font-semibold">Información básica</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400">Proyecto</label>
                  <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setEnvironmentId(""); }} className="input mt-1">
                    <option value="">Sin proyecto</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Entorno</label>
                  <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} className="input mt-1" disabled>
                    <option value="">Sin entorno</option>
                    {environments.filter((env) => env.slug === currentEnv.slug).map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
                  </select>
                </div>
              </div>
              {projects.length === 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm p-3">
                  No hay proyectos todavía. Puedes crear uno desde <Link href="/projects" className="underline">Proyectos</Link>.
                </div>
              )}
              <div>
                <label className="text-xs text-slate-400">Nombre</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="send-email" className="input mt-1" />
              </div>
              <div>
                <label className="text-xs text-slate-400">Descripción</label>
                <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="Qué hace esta función" className="input mt-1" />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-semibold">Código ({entrypoint})</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={importFolder}
                    {...({ webkitdirectory: "", directory: "" } as any)}
                  />
                  <button type="button" onClick={() => folderInputRef.current?.click()} className="btn-ghost h-9 text-xs">
                    <FolderOpen className="w-4 h-4" /> Importar carpeta
                  </button>
                  <span className="chip" style={{ borderColor: "var(--border-2)", color: "var(--text-2)" }}>
                    Runtime: {runtimeLabel(runtime)}
                  </span>
                </div>
              </div>
              {importedFiles?.length ? (
                <div className="rounded-lg border border-[var(--border)] bg-black/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm text-slate-300 inline-flex items-center gap-2">
                      <UploadCloud className="w-4 h-4 text-cyan-300" />
                      {importSummary || `${importedFiles.length} archivo(s) importados`}
                    </div>
                    <select value={entrypoint} onChange={(e) => {
                      const nextPath = e.target.value;
                      const currentFiles = finalFiles.map((file) => file.path === entrypoint ? { ...file, content: code } : file);
                      const nextFile = currentFiles.find((file) => file.path === nextPath);
                      setImportedFiles(currentFiles);
                      setImportedEntrypoint(nextPath);
                      setCode(nextFile?.content || "");
                    }} className="input max-w-xs font-mono">
                      {finalFiles.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
                    </select>
                  </div>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-28 overflow-auto">
                    {finalFiles.map((file) => (
                      <div key={file.path} className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs font-mono text-slate-300 truncate">
                        <FileText className="w-3.5 h-3.5 inline mr-1 text-slate-500" />{file.path}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-[var(--border-2)] bg-black/10 p-3 text-sm text-slate-400">
                  Puedes pegar codigo o importar una carpeta completa; se conservan subcarpetas como <span className="font-mono text-slate-300">_shared/</span> y archivos auxiliares.
                </div>
              )}
              <CodeEditor
                value={code}
                fileName={entrypoint}
                runtime={runtime}
                onChange={setCode}
              />
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h3 className="font-semibold">Configuración</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400">Runtime</label>
                  <select className="input mt-1" value={runtimeMode} onChange={(e) => setRuntimeMode(e.target.value)}>
                    <option value="auto">Auto ({runtimeLabel(detectedRuntime)})</option>
                    <option value="node20">Node 20</option>
                    <option value="deno">Deno</option>
                    <option value="python311">Python 3.11</option>
                    <option value="java-spring">Java Spring Boot</option>
                    <option value="dotnet8">.NET 8 C#</option>
                    <option value="custom">Custom Dockerfile</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Memoria funcion</label>
                  <select className="input mt-1" value={memoryMb} onChange={(e) => setMemoryMb(Number(e.target.value))}>
                    {MEMORY_OPTIONS.map((memory) => <option key={memory} value={memory}>{memory} MB</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Timeout</label>
                  <input type="number" min={1} max={300} value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(Number(e.target.value))} className="input mt-1" />
                </div>
              </div>
              <p className="text-xs text-slate-500">La memoria queda como referencia operativa de la funcion. La plataforma detecta Deno, TypeScript, Node, Python, Java Spring Boot, .NET o Dockerfile.</p>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <h3 className="font-semibold">Revisión</h3>
              <div className="rounded-lg bg-[var(--panel-2)] border border-[var(--border)] p-4 text-sm space-y-2">
                <div className="flex justify-between gap-3"><span className="text-slate-400">Proyecto</span><strong>{selectedProject?.name || "Sin proyecto"}</strong></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Entorno</span><strong>{selectedEnv?.name || "Sin entorno"}</strong></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Nombre</span><strong>{name || "Pendiente"}</strong></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Archivos</span><span>{finalFiles.length}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Líneas principal</span><span>{code.split("\n").length}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Runtime</span><span>{runtimeLabel(runtime)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Principal</span><span className="font-mono">{entrypoint}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Memoria</span><span>{memoryMb} MB</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Timeout</span><span>{timeoutSeconds}s</span></div>
              </div>
              {err && <div className="text-rose-400 text-sm">Error: {err}</div>}
            </div>
          )}

          <div className="flex justify-between mt-6">
            <button disabled={step === 1} onClick={() => setStep((s) => s - 1)} className="btn-ghost disabled:opacity-40">Atrás</button>
            {step < 4 ? (
              <button disabled={step === 1 && !name} onClick={() => setStep((s) => s + 1)} className="btn-primary disabled:opacity-50">Siguiente</button>
            ) : (
              <button disabled={busy || !name} onClick={submit} className="btn-primary disabled:opacity-50">{busy ? "Creando..." : "Crear función"}</button>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card">
            <h3 className="font-semibold mb-3">Resumen</h3>
            <div className="text-sm space-y-2">
              <div className="flex justify-between gap-3"><span className="text-slate-400">Paso</span><span>{step}/4</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400">Proyecto</span><span className="truncate max-w-[150px]">{selectedProject?.name || "-"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400">Entorno</span><span>{selectedEnv?.slug || "-"}</span></div>
              <div className="flex justify-between gap-3"><span className="text-slate-400">Runtime</span><span>{runtimeLabel(runtime)}</span></div>
            </div>
          </div>

          <div className="card">
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-lg bg-[var(--panel-2)] border border-[var(--border)] p-3">
                <FolderKanban className="w-4 h-4 mx-auto mb-2 text-violet-300" />
                Proyecto
              </div>
              <div className="rounded-lg bg-[var(--panel-2)] border border-[var(--border)] p-3">
                <Server className="w-4 h-4 mx-auto mb-2 text-cyan-300" />
                Entorno
              </div>
              <div className="rounded-lg bg-[var(--panel-2)] border border-[var(--border)] p-3">
                <Rocket className="w-4 h-4 mx-auto mb-2 text-emerald-300" />
                Deploy
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NewFn() {
  return <Suspense fallback={<div className="text-slate-400">Cargando...</div>}><NewFnInner /></Suspense>;
}

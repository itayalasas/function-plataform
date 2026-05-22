import { builtinModules } from "node:module";

export const RUNTIMES = {
  node20: {
    id: "node20",
    label: "Node 20",
    entrypoint: "index.mjs",
    port: 8080,
  },
  deno: {
    id: "deno",
    label: "Deno",
    entrypoint: "index.ts",
    port: 8000,
  },
  python311: {
    id: "python311",
    label: "Python 3.11",
    entrypoint: "index.py",
    port: 8080,
  },
  "java-spring": {
    id: "java-spring",
    label: "Java Spring Boot",
    entrypoint: "src/main/java/com/example/demo/controller/TestController.java",
    port: 8080,
  },
  dotnet8: {
    id: "dotnet8",
    label: ".NET 8 C#",
    entrypoint: "Program.cs",
    port: 8080,
  },
  custom: {
    id: "custom",
    label: "Custom Dockerfile",
    entrypoint: "Dockerfile",
    port: 8080,
  },
};

const DEFAULT_NODE_CODE = `export default async function handler(req) {
  const name = new URL(req.url).searchParams.get("name") ?? "world";
  return Response.json({ hello: name });
}
`;

const DEFAULT_DENO_CODE = `export default async function handler(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "world";
  return Response.json({ hello: name });
}
`;

const DEFAULT_PYTHON_CODE = `import os

def handler(request):
    name = request.get("query", {}).get("name", "world")
    return {"hello": name, "greeting": os.environ.get("GREETING")}
`;

const DEFAULT_JAVA_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>function-api</artifactId>
  <version>1.0.0</version>
  <properties>
    <java.version>21</java.version>
    <spring.boot.version>3.3.5</spring.boot.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>\${spring.boot.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
        <version>\${spring.boot.version}</version>
        <executions>
          <execution>
            <goals><goal>repackage</goal></goals>
          </execution>
        </executions>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
        <configuration>
          <release>\${java.version}</release>
          <parameters>true</parameters>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;

const DEFAULT_JAVA_APP = `package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {
  public static void main(String[] args) {
    SpringApplication.run(DemoApplication.class, args);
  }
}
`;

const DEFAULT_JAVA_CONTROLLER = `package com.example.demo.controller;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TestController {
  @GetMapping({"/", "/api/test"})
  public Map<String, Object> test(@RequestParam(name = "name", defaultValue = "world") String name) {
    Map<String, Object> response = new HashMap<>();
    response.put("status", "OK");
    response.put("message", "API Java funcionando");
    response.put("name", name);
    response.put("timestamp", LocalDateTime.now().toString());
    response.put("version", "1.0");
    return response;
  }

  @PostMapping({"/", "/echo", "/api/echo"})
  public Map<String, Object> echo(@RequestBody(required = false) Map<String, Object> body) {
    return Map.of("ok", true, "received", body == null ? Map.of() : body);
  }
}
`;

const DEFAULT_JAVA_PROPERTIES = `server.address=0.0.0.0
server.port=\${FPM_PORT:8080}
`;

const DEFAULT_CSHARP_PROJECT = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>app</AssemblyName>
  </PropertyGroup>
</Project>
`;

const DEFAULT_CSHARP_PROGRAM = `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var testHandler = (string? name) => Results.Json(new {
    status = "OK",
    message = "API C# funcionando",
    name = name ?? "world",
    timestamp = DateTimeOffset.UtcNow,
    version = "1.0"
});

app.MapGet("/", testHandler);
app.MapGet("/api/test", testHandler);

var echoHandler = async (HttpRequest request) => {
    var body = await request.ReadFromJsonAsync<Dictionary<string, object>>() ?? new();
    return Results.Json(new { ok = true, received = body });
};

app.MapPost("/", echoHandler);
app.MapPost("/echo", echoHandler);
app.MapPost("/api/echo", echoHandler);

app.Run();
`;

function runtimeOrDefault(runtime) {
  return RUNTIMES[runtime]?.id || "node20";
}

export function runtimePort(fnOrRuntime) {
  const runtime = typeof fnOrRuntime === "string" ? fnOrRuntime : fnOrRuntime?.runtime;
  return RUNTIMES[runtimeOrDefault(runtime)].port;
}

export function normalizeDeployVersion(value = "v1") {
  const raw = String(value || "v1").trim().toLowerCase();
  const normalized = raw
    .replace(/^version[\s_-]*/, "v")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) return "v1";
  if (/^\d+$/.test(normalized)) return `v${normalized}`;
  return normalized;
}

export function routePath(fn, version = "v1") {
  return `/${normalizeDeployVersion(version)}/${normalizeSourcePath(fn?.slug || fn?.name || "function")}`;
}

export function withRoutePath(baseUrl, fn, version = "v1") {
  if (!baseUrl) return null;
  return `${String(baseUrl).replace(/\/$/, "")}${routePath(fn, version)}`;
}

export function defaultEntrypoint(runtime) {
  return RUNTIMES[runtimeOrDefault(runtime)].entrypoint;
}

export function defaultCode(runtime) {
  const resolved = runtimeOrDefault(runtime);
  if (resolved === "deno") return DEFAULT_DENO_CODE;
  if (resolved === "python311") return DEFAULT_PYTHON_CODE;
  if (resolved === "java-spring") return DEFAULT_JAVA_CONTROLLER;
  if (resolved === "dotnet8") return DEFAULT_CSHARP_PROGRAM;
  if (resolved === "custom") {
    return `FROM alpine:3.20
EXPOSE 8080
CMD ["sh", "-c", "while true; do nc -lp 8080 -e echo ok; done"]
`;
  }
  return DEFAULT_NODE_CODE;
}

function packagePathFromJava(content, fallback = "com.example.demo.controller") {
  const pkg = /package\s+([a-zA-Z_][\w.]*);/.exec(content)?.[1] || fallback;
  return pkg.replace(/\./g, "/");
}

function javaSpringFiles(content) {
  const text = String(content || "").trim();
  const files = [
    { path: "pom.xml", content: DEFAULT_JAVA_POM },
    { path: "src/main/java/com/example/demo/DemoApplication.java", content: DEFAULT_JAVA_APP },
    { path: "src/main/resources/application.properties", content: DEFAULT_JAVA_PROPERTIES },
  ];

  if (/@SpringBootApplication\b/.test(text)) {
    const pkgPath = packagePathFromJava(text, "com.example.demo");
    files[1] = { path: `src/main/java/${pkgPath}/DemoApplication.java`, content: text };
    files.push({ path: "src/main/java/com/example/demo/controller/TestController.java", content: DEFAULT_JAVA_CONTROLLER });
    return files;
  }

  const controller = text && /@(RestController|Controller|GetMapping|PostMapping|RequestMapping)\b/.test(text)
    ? text
    : DEFAULT_JAVA_CONTROLLER;
  const controllerPath = packagePathFromJava(controller, "com.example.demo.controller");
  files.push({ path: `src/main/java/${controllerPath}/TestController.java`, content: controller });
  return files;
}

function ensureJavaCompilerParameters(content) {
  const text = String(content || "");
  if (/<parameters>\s*true\s*<\/parameters>/i.test(text)) return text;
  if (/<artifactId>\s*maven-compiler-plugin\s*<\/artifactId>/i.test(text)) {
    if (/<artifactId>\s*maven-compiler-plugin\s*<\/artifactId>[\s\S]*?<configuration>/i.test(text)) {
      return text.replace(
        /(<artifactId>\s*maven-compiler-plugin\s*<\/artifactId>[\s\S]*?<configuration>)/i,
        `$1\n          <parameters>true</parameters>`
      );
    }
    return text.replace(
      /(<artifactId>\s*maven-compiler-plugin\s*<\/artifactId>[\s\S]*?)(<\/plugin>)/i,
      `$1\n        <configuration>\n          <parameters>true</parameters>\n        </configuration>\n      $2`
    );
  }
  const plugin = `      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
        <configuration>
          <parameters>true</parameters>
        </configuration>
      </plugin>
`;
  if (/<\/plugins>/i.test(text)) return text.replace(/<\/plugins>/i, `${plugin}    </plugins>`);
  return text;
}

function withJavaSpringBuildDefaults(files) {
  return files.map((file) => /(^|\/)pom\.xml$/i.test(file.path)
    ? { ...file, content: ensureJavaCompilerParameters(file.content) }
    : file);
}

function dotnetFiles(content) {
  return [
    { path: "Api.csproj", content: DEFAULT_CSHARP_PROJECT },
    { path: "Program.cs", content: String(content || "").trim() || DEFAULT_CSHARP_PROGRAM },
  ];
}

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function normalizeNodePackageName(specifier) {
  const value = String(specifier || "").trim();
  if (!value) return null;
  if (value.startsWith(".") || value.startsWith("/") || /^(node:|npm:|data:|file:|https?:)/i.test(value)) return null;
  const root = value.startsWith("@")
    ? value.split("/").slice(0, 2).join("/")
    : value.split("/")[0];
  if (!root || NODE_BUILTINS.has(root)) return null;
  return root;
}

export function detectNodeDependencies(files = []) {
  const joined = files
    .filter((file) => /\.(m?jsx?|c?tsx?)$/i.test(file.path))
    .map((file) => String(file.content || ""))
    .join("\n\n");
  if (!joined.trim()) return [];

  const specs = new Set();
  const patterns = [
    /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:\*\s+from\s+|{[^}]*}\s+from\s+)['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of joined.matchAll(pattern)) {
      const name = normalizeNodePackageName(match[1]);
      if (name) specs.add(name);
    }
  }

  return [...specs].sort((a, b) => a.localeCompare(b));
}

function parseJsonObject(text, fallback = {}) {
  try {
    const parsed = JSON.parse(String(text || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function buildNodePackageJson(files, name = "function") {
  const existing = files.find((file) => /(^|\/)package\.json$/i.test(file.path));
  const inferred = detectNodeDependencies(files);
  const parsed = existing ? parseJsonObject(existing.content, {}) : {};
  const dependencies = {
    ...(parsed.dependencies || {}),
  };
  for (const dep of inferred) {
    if (!dependencies[dep]) dependencies[dep] = "*";
  }
  return JSON.stringify({
    ...parsed,
    name: parsed.name || normalizeSourcePath(name || "function").split("/").pop() || "function",
    private: parsed.private ?? true,
    type: "module",
    dependencies,
  }, null, 2);
}

export function normalizeSourcePath(path) {
  const cleaned = String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  const parts = cleaned.split("/").filter(Boolean);
  if (!parts.length) throw new Error("La ruta del archivo es obligatoria");
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Ruta no permitida: ${path}`);
  }
  return parts.join("/");
}

function sourceBasename(path) {
  return String(path || "").split("/").pop() || "";
}

function isDockerfilePath(path) {
  return /^dockerfile$/i.test(sourceBasename(path));
}

export function looksLikeDockerfile(content = "") {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstMeaningful = lines.find((line) => !line.startsWith("#") || /^#\s*syntax=docker\/dockerfile\b/i.test(line)) || "";
  if (!firstMeaningful) return false;
  if (/^#\s*syntax=docker\/dockerfile\b/i.test(firstMeaningful)) return true;

  // SQL snippets and TypeScript strings often contain lines such as
  // "FROM applications"; a real Dockerfile starts with ARG or FROM.
  if (/^ARG\s+[A-Z_][A-Z0-9_]*(=.+)?$/i.test(firstMeaningful)) {
    return lines.some((line) => /^FROM\s+\S+/i.test(line));
  }
  return /^FROM\s+\S+/i.test(firstMeaningful);
}

function hasDockerfileSource(file) {
  return isDockerfilePath(file.path) && looksLikeDockerfile(file.content);
}

export function detectRuntimeFromFiles(files = []) {
  const joined = files.map((file) => `${file.path}\n${file.content}`).join("\n\n");
  if (files.some(hasDockerfileSource)) return "custom";
  if (files.some((file) => /(^|\/)pom\.xml$/i.test(file.path) || /\.java$/i.test(file.path)) || /@(SpringBootApplication|RestController|GetMapping|PostMapping|RequestMapping)\b|org\.springframework/m.test(joined)) return "java-spring";
  if (files.some((file) => /\.(cs|csproj)$/i.test(file.path)) || /\b(WebApplication\.CreateBuilder|MapGet\s*\(|Microsoft\.AspNetCore|Results\.Json|namespace\s+\w+)/m.test(joined)) return "dotnet8";
  if (/\bDeno\.|from\s+["']npm:|import\s*\(\s*["']npm:/m.test(joined)) return "deno";
  if (/\bDeno\.serve\s*\(/m.test(joined)) return "deno";
  if (files.some((file) => /\.py$/i.test(file.path)) || /\b(import\s+os|from\s+flask|FastAPI|def\s+handler\s*\()/m.test(joined)) return "python311";
  if (/:\s*(Request|Response|unknown|string|number|boolean)\b|interface\s+\w+|type\s+\w+\s*=/m.test(joined)) {
    return "deno";
  }
  if (files.some((file) => /\.ts$/i.test(file.path)) && !/\b(require|module\.exports)\b/.test(joined)) return "deno";
  return "node20";
}

function normalizeRouteMappingPath(value) {
  const path = String(value || "").trim();
  if (!path || path.includes("*") || path.includes("{") || path.includes("$")) return null;
  return path.startsWith("/") ? path : `/${path}`;
}

function firstJavaMappingPath(text, method) {
  const methodMapping = {
    GET: "GetMapping",
    POST: "PostMapping",
    PUT: "PutMapping",
    DELETE: "DeleteMapping",
    PATCH: "PatchMapping",
  }[method];
  const mappingRegex = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(?:\(([\s\S]*?)\))?/g;
  let rootPath = null;
  for (const match of text.matchAll(mappingRegex)) {
    const annotation = match[1];
    const args = match[2] || "";
    if (annotation === "RequestMapping" && !new RegExp(`RequestMethod\\.${method}\\b|method\\s*=\\s*["']${method}["']`, "i").test(args)) {
      continue;
    }
    if (annotation !== "RequestMapping" && annotation !== methodMapping) continue;
    const literals = [...args.matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
    for (const literal of literals.length ? literals : ["/"]) {
      const path = normalizeRouteMappingPath(literal);
      if (path && path !== "/") return path;
      if (path === "/") rootPath = path;
    }
  }
  return rootPath;
}

function firstDotnetMappingPath(text, method) {
  const regex = new RegExp(`\\bMap${method[0]}${method.slice(1).toLowerCase()}\\s*\\(\\s*["']([^"']+)["']`, "g");
  let rootPath = null;
  for (const match of text.matchAll(regex)) {
    const path = normalizeRouteMappingPath(match[1]);
    if (path && path !== "/") return path;
    if (path === "/") rootPath = path;
  }
  return rootPath;
}

export function defaultUpstreamPaths(fnOrSource = {}) {
  const runtime = runtimeOrDefault(fnOrSource.runtime);
  if (runtime !== "java-spring" && runtime !== "dotnet8") return {};

  const files = Array.isArray(fnOrSource.files) && fnOrSource.files.length
    ? fnOrSource.files
    : [{ path: fnOrSource.entrypoint || defaultEntrypoint(runtime), content: fnOrSource.code || "" }];
  const text = files.map((file) => file.content || "").join("\n\n");
  const result = {};
  for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
    const path = runtime === "java-spring"
      ? firstJavaMappingPath(text, method)
      : firstDotnetMappingPath(text, method);
    if (path && path !== "/") result[method] = path;
  }
  return result;
}

function pickEntrypoint(files, runtime, preferred) {
  const normalizedPreferred = preferred ? normalizeSourcePath(preferred) : null;
  if (normalizedPreferred && files.some((file) => file.path === normalizedPreferred)) return normalizedPreferred;

  const byName = [
    defaultEntrypoint(runtime),
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
  return byName.find((path) => files.some((file) => file.path === path)) || files[0]?.path || defaultEntrypoint(runtime);
}

function remapMisnamedDockerfile(files, runtime, preferred) {
  if (runtime === "custom") return files;

  let normalizedPreferred = null;
  try {
    normalizedPreferred = preferred ? normalizeSourcePath(preferred) : null;
  } catch {}

  const target = defaultEntrypoint(runtime);
  const rewritten = files.map((file) => {
    const shouldRemap =
      isDockerfilePath(file.path) &&
      !looksLikeDockerfile(file.content) &&
      (files.length === 1 || normalizedPreferred === file.path);
    return shouldRemap ? { ...file, path: target } : file;
  });

  const seen = new Set();
  return rewritten.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

export function normalizeFunctionSource({ name, code, files, runtime, entrypoint } = {}) {
  let normalizedFiles = [];
  if (Array.isArray(files) && files.length) {
    const seen = new Set();
    for (const file of files) {
      const path = normalizeSourcePath(file.path);
      if (seen.has(path)) throw new Error(`Archivo duplicado: ${path}`);
      seen.add(path);
      normalizedFiles.push({ path, content: String(file.content ?? "") });
    }
  } else {
    const content = String(code ?? defaultCode(runtime));
    const detected = detectRuntimeFromFiles([{ path: entrypoint || "index.mjs", content }]);
    const initialRuntime = ["deno", "python311", "java-spring", "dotnet8", "custom"].includes(detected) ? detected : runtimeOrDefault(runtime);
    if (initialRuntime === "java-spring") {
      normalizedFiles = javaSpringFiles(content);
    } else if (initialRuntime === "dotnet8") {
      normalizedFiles = dotnetFiles(content);
    } else {
      const path = entrypoint ? normalizeSourcePath(entrypoint) : defaultEntrypoint(initialRuntime);
      normalizedFiles = [{ path, content }];
    }
  }

  const detectedRuntime = detectRuntimeFromFiles(normalizedFiles);
  const requestedRuntime = RUNTIMES[runtime]?.id;
  const resolvedRuntime = ["deno", "python311", "java-spring", "dotnet8", "custom"].includes(detectedRuntime) ? detectedRuntime : requestedRuntime || "node20";

  normalizedFiles = remapMisnamedDockerfile(normalizedFiles, resolvedRuntime, entrypoint);

  if (resolvedRuntime === "java-spring") {
    normalizedFiles = withJavaSpringBuildDefaults(normalizedFiles);
  }

  if (resolvedRuntime === "node20") {
    const packageIndex = normalizedFiles.findIndex((file) => /(^|\/)package\.json$/i.test(file.path));
    const packageJson = buildNodePackageJson(normalizedFiles, name || "function");
    if (packageIndex >= 0) {
      normalizedFiles[packageIndex] = { ...normalizedFiles[packageIndex], content: packageJson };
    } else {
      normalizedFiles.unshift({ path: "package.json", content: packageJson });
    }
  }

  if (
    resolvedRuntime === "deno" &&
    normalizedFiles.length === 1 &&
    normalizedFiles[0].path === "index.mjs" &&
    (!entrypoint || entrypoint === "index.mjs")
  ) {
    normalizedFiles = [{ ...normalizedFiles[0], path: "index.ts" }];
    entrypoint = "index.ts";
  }

  const resolvedEntrypoint = pickEntrypoint(normalizedFiles, resolvedRuntime, entrypoint);

  if (!normalizedFiles.some((file) => file.path === resolvedEntrypoint)) {
    normalizedFiles.unshift({
      path: resolvedEntrypoint,
      content: String(code ?? defaultCode(resolvedRuntime)),
    });
  }

  const entryFile = normalizedFiles.find((file) => file.path === resolvedEntrypoint);
  return {
    code: entryFile?.content || "",
    files: normalizedFiles,
    entrypoint: resolvedEntrypoint,
    runtime: resolvedRuntime,
    detected_runtime: detectedRuntime,
    directory: normalizeSourcePath(name || "function"),
  };
}

export function denoSelfServes(fn) {
  const entry = (fn.files || []).find((file) => file.path === fn.entrypoint);
  return /\bDeno\.serve\s*\(/m.test(entry?.content || fn.code || "");
}

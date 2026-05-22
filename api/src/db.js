import pg from "pg";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { nanoid } from "nanoid";
import { normalizeDeployVersion, normalizeFunctionSource } from "./functionSource.js";
import { getRequestTenantId } from "./requestContext.js";

const { Pool } = pg;

const now = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));

function isLocalPlatformHost() {
  const host = String(process.env.PUBLIC_HOST || process.env.NEXT_PUBLIC_API_URL || "").trim().toLowerCase();
  if (!host) return false;
  return /(^|[^a-z0-9])(localhost|127\.0\.0\.1|0\.0\.0\.0)([^a-z0-9]|$)/i.test(host);
}

function knownTenantIdsFromProjects() {
  return [...new Set(
    (state.projects || [])
      .map((project) => String(project?.tenant_id || "").trim())
      .filter(Boolean)
  )];
}

function resolveTenantId(tenantId = null) {
  const explicit = String(tenantId || getRequestTenantId() || "").trim();
  if (explicit) {
    if (storeMode === "file") {
      const knownTenantIds = knownTenantIdsFromProjects();
      if (!knownTenantIds.includes(explicit) && isLocalPlatformHost()) {
        const fallbackTenant = String(process.env.DEFAULT_TENANT_ID || process.env.FPM_DEFAULT_TENANT_ID || "").trim();
        if (fallbackTenant && knownTenantIds.includes(fallbackTenant)) {
          return fallbackTenant;
        }
        if (knownTenantIds.length === 1) {
          return knownTenantIds[0];
        }
      }
    }
    return explicit;
  }

  if (storeMode === "file" && Array.isArray(state.projects)) {
    const projectTenantIds = knownTenantIdsFromProjects();
    if (projectTenantIds.length === 1) {
      return projectTenantIds[0];
    }
  }

  return String(process.env.DEFAULT_TENANT_ID || process.env.FPM_DEFAULT_TENANT_ID || "").trim() || null;
}

function hasTenantAccess(entityTenantId, tenantId = null) {
  const resolved = resolveTenantId(tenantId);
  if (!resolved) return false;
  return String(entityTenantId || "") === resolved;
}

function projectVisible(project, tenantId = null) {
  const resolved = resolveTenantId(tenantId);
  if (!resolved) return false;
  return String(project?.tenant_id || "") === resolved;
}

export const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "item";

function normalizeAuthHeaderName(value) {
  return String(value || "x-api-key")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x-api-key";
}

function normalizeApiTokens(tokens = []) {
  if (typeof tokens === "string") {
    try {
      tokens = JSON.parse(tokens);
    } catch {
      tokens = [];
    }
  }
  if (!Array.isArray(tokens)) return [];
  return tokens
    .filter((token) => token?.value)
    .map((token) => ({
      id: token.id || nanoid(10),
      name: String(token.name || "default").trim() || "default",
      value: String(token.value),
      last4: String(token.value).slice(-4),
      created_at: token.created_at || now(),
    }));
}

function newApiTokenValue() {
  return `fpm_${randomBytes(24).toString("base64url")}`;
}

function promotedEnvironmentTokens(source, existingTarget, targetEnv) {
  const existing = normalizeApiTokens(existingTarget?.api_tokens);
  if (existing.length) return existing;
  if (!source?.auth_required) return [];
  return normalizeApiTokens([{
    name: `${targetEnv?.slug || "env"}-default`,
    value: newApiTokenValue(),
  }]);
}

function normalizeDeploymentChangeDetails(details = []) {
  if (!Array.isArray(details)) return [];
  return details
    .map((detail) => ({
      label: String(detail?.label || "").trim(),
      message: String(detail?.message || "").trim(),
      before: detail?.before === undefined || detail?.before === null ? null : String(detail.before),
      after: detail?.after === undefined || detail?.after === null ? null : String(detail.after),
    }))
    .filter((detail) => detail.label || detail.message);
}

function deploymentFilesSignature(files = []) {
  if (!Array.isArray(files)) return "[]";
  return JSON.stringify(
    files
      .map((file) => ({
        path: String(file?.path || ""),
        content: String(file?.content || ""),
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  );
}

function deploymentTokensSignature(tokens = []) {
  if (!Array.isArray(tokens)) return "[]";
  return JSON.stringify(
    tokens
      .map((token) => ({
        id: String(token?.id || ""),
        name: String(token?.name || ""),
        last4: String(token?.last4 || ""),
      }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name))
  );
}

function deploymentSecretSignature(secrets = []) {
  if (!Array.isArray(secrets)) return "[]";
  return JSON.stringify(
    secrets
      .map((secret) => ({
        key: normalizeSecretKey(secret?.key),
      }))
      .filter((secret) => secret.key)
      .sort((a, b) => a.key.localeCompare(b.key))
  );
}

function deploymentStringListSignature(values = []) {
  if (!Array.isArray(values)) return "[]";
  return JSON.stringify(
    values
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  );
}

function buildDeploymentSnapshot(fn, secrets = []) {
  const tokens = normalizeApiTokens(fn?.api_tokens);
  return {
    function: {
      id: fn?.id || null,
      slug: fn?.slug || null,
      name: fn?.name || null,
      description: fn?.description ?? null,
      code: String(fn?.code || ""),
      files: Array.isArray(fn?.files) ? clone(fn.files) : [],
      entrypoint: fn?.entrypoint || null,
      runtime: fn?.runtime || "node20",
      memory_mb: Number(fn?.memory_mb || 256) || 256,
      timeout_seconds: Number(fn?.timeout_seconds || 30) || 30,
      auth_required: Boolean(fn?.auth_required),
      auth_header_name: normalizeAuthHeaderName(fn?.auth_header_name),
      api_tokens: tokens.map((token) => ({
        id: token.id,
        name: token.name,
        last4: token.last4 || String(token.value || "").slice(-4),
        created_at: token.created_at || now(),
      })),
      validation_status: fn?.validation_status ?? null,
      validation_summary: fn?.validation_summary ?? null,
      active_deploy_version: normalizeDeployVersion(fn?.active_deploy_version || "v1"),
    },
    meta: {
      project_id: fn?.project_id || null,
      environment_id: fn?.environment_id || null,
      source_function_id: fn?.source_function_id || null,
      secret_keys: [...new Set((Array.isArray(secrets) ? secrets : []).map((secret) => normalizeSecretKey(secret?.key)).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    },
  };
}

function buildDeploymentChangeDetails(previousSnapshot = null, snapshot = null, note = "") {
  const previous = previousSnapshot?.function || {};
  const current = snapshot?.function || {};
  const details = [];
  const compareText = [
    ["name", "Nombre"],
    ["description", "Descripcion"],
    ["runtime", "Runtime"],
    ["entrypoint", "Entrypoint"],
    ["auth_header_name", "Header auth"],
  ];
  for (const [key, label] of compareText) {
    if (String(previous[key] ?? "") === String(current[key] ?? "")) continue;
    details.push({
      label,
      before: previous[key] ?? null,
      after: current[key] ?? null,
      message: `${label} actualizado`,
    });
  }

  if (String(previous.code || "") !== String(current.code || "")) {
    details.push({ label: "Codigo", message: "Codigo actualizado" });
  }
  if (deploymentFilesSignature(previous.files || []) !== deploymentFilesSignature(current.files || [])) {
    details.push({
      label: "Archivos",
      message: "Archivos auxiliares o estructura del proyecto actualizados",
    });
  }
  if (Number(previous.memory_mb || 0) !== Number(current.memory_mb || 0)) {
    details.push({
      label: "Memoria",
      before: `${Number(previous.memory_mb || 256)} MB`,
      after: `${Number(current.memory_mb || 256)} MB`,
      message: "Memoria ajustada",
    });
  }
  if (Number(previous.timeout_seconds || 0) !== Number(current.timeout_seconds || 0)) {
    details.push({
      label: "Timeout",
      before: `${Number(previous.timeout_seconds || 30)} s`,
      after: `${Number(current.timeout_seconds || 30)} s`,
      message: "Timeout ajustado",
    });
  }
  if (Boolean(previous.auth_required) !== Boolean(current.auth_required)) {
    details.push({
      label: "Auth",
      before: previous.auth_required ? "Activa" : "Inactiva",
      after: current.auth_required ? "Activa" : "Inactiva",
      message: current.auth_required ? "Autenticacion por API key activada" : "Autenticacion por API key desactivada",
    });
  }
  if (deploymentTokensSignature(previous.api_tokens || []) !== deploymentTokensSignature(current.api_tokens || [])) {
    details.push({
      label: "Tokens",
      message: "Tokens de API actualizados",
    });
  }
  if (deploymentStringListSignature(previous?.meta?.secret_keys || []) !== deploymentStringListSignature(snapshot?.meta?.secret_keys || [])) {
    details.push({
      label: "Secrets",
      message: "Secrets del ambiente actualizados",
    });
  }

  const summary = details.length
    ? details.slice(0, 4).map((item) => item.message || item.label).join(" · ")
    : "Sin cambios relevantes";

  return {
    summary: note ? `${note}${details.length ? ` · ${summary}` : ""}` : summary,
    details: normalizeDeploymentChangeDetails(details),
  };
}

function normalizePlatformDeploymentChangeDetails(details = []) {
  return normalizeDeploymentChangeDetails(details);
}

function platformDeploymentVersionSummary(_target = {}, version = null) {
  return `Plataforma ${normalizeDeployVersion(version || "1.0.0")}`;
}

export function buildPlatformDeploymentSnapshot(target = {}, extra = {}) {
  const version = normalizeDeployVersion(extra.version || target?.platform_version || "1.0.0");
  const deployedVersion = normalizeDeployVersion(extra.deployedVersion || target?.platform_deployed_version || version);
  const webUrl = String(target?.platform_web_container_app_url || target?.azure_container_app_url || "").replace(/\/+$/, "");
  return {
    target: {
      id: target?.id || null,
      project_id: target?.project_id || null,
      environment_id: target?.environment_id || null,
      project_name: target?.project_name || null,
      environment_name: target?.environment_name || null,
      environment_slug: target?.environment_slug || null,
      name: target?.name || null,
      provider: target?.provider || "azure",
      deployment_mode: target?.deployment_mode || "manual",
      auto_deploy: Boolean(target?.auto_deploy),
      azure_resource_group: target?.azure_resource_group || null,
      azure_location: target?.azure_location || null,
      acr_name: target?.acr_name || null,
      container_app_environment: target?.container_app_environment || null,
      container_app_name_prefix: target?.container_app_name_prefix || null,
      platform_version: version,
      platform_deployed_version: deployedVersion,
      platform_deployed_at: target?.platform_deployed_at || null,
      platform_deploy_started_at: target?.platform_deploy_started_at || null,
      platform_deploy_step: target?.platform_deploy_step || null,
      platform_deploy_percent: Number(target?.platform_deploy_percent || 0),
      platform_deploy_status: target?.platform_deploy_status || null,
      platform_api_container_app_name: target?.platform_api_container_app_name || null,
      platform_api_container_app_url: target?.platform_api_container_app_url || null,
      platform_api_image: target?.platform_api_image || null,
      platform_web_container_app_name: target?.platform_web_container_app_name || null,
      platform_web_container_app_url: target?.platform_web_container_app_url || null,
      platform_web_image: target?.platform_web_image || null,
      platform_ready: Boolean(target?.platform_api_container_app_url && target?.platform_web_container_app_url),
      auth_redirect_uri: webUrl ? `${webUrl}/callback` : null,
      memory_budget_mb: Number(target?.memory_budget_mb || 0) || 0,
      git_repo_url: target?.git_repo_url || null,
      git_branch: target?.git_branch || null,
      git_workflow_path: target?.git_workflow_path || null,
    },
    meta: {
      target_id: target?.id || null,
      project_id: target?.project_id || null,
      environment_id: target?.environment_id || null,
      version,
      deployed_version: deployedVersion,
    },
  };
}

export function buildPlatformDeploymentChangeDetails(previousSnapshot = null, snapshot = null, note = "") {
  const previous = previousSnapshot?.target || {};
  const current = snapshot?.target || {};
  const details = [];
  const compareText = [
    ["platform_version", "Version plataforma"],
    ["platform_deployed_version", "Version impactada"],
    ["platform_api_container_app_url", "API"],
    ["platform_web_container_app_url", "Web"],
    ["auth_redirect_uri", "Callback auth"],
    ["platform_api_image", "Imagen API"],
    ["platform_web_image", "Imagen Web"],
    ["container_app_environment", "Managed Environment"],
    ["azure_resource_group", "Resource group"],
    ["azure_location", "Region"],
    ["acr_name", "ACR"],
    ["git_repo_url", "Repositorio"],
    ["git_branch", "Branch"],
    ["git_workflow_path", "Workflow"],
  ];

  for (const [key, label] of compareText) {
    if (String(previous[key] ?? "") === String(current[key] ?? "")) continue;
    details.push({
      label,
      before: previous[key] ?? null,
      after: current[key] ?? null,
      message: `${label} actualizado`,
    });
  }

  if (Number(previous.memory_budget_mb || 0) !== Number(current.memory_budget_mb || 0)) {
    details.push({
      label: "Memoria",
      before: `${Number(previous.memory_budget_mb || 0)} MB`,
      after: `${Number(current.memory_budget_mb || 0)} MB`,
      message: "Memoria del target actualizada",
    });
  }
  if (Boolean(previous.auto_deploy) !== Boolean(current.auto_deploy)) {
    details.push({
      label: "Auto deploy",
      before: previous.auto_deploy ? "Activo" : "Inactivo",
      after: current.auto_deploy ? "Activo" : "Inactivo",
      message: current.auto_deploy ? "Auto deploy activado" : "Auto deploy desactivado",
    });
  }
  if (Boolean(previous.platform_ready) !== Boolean(current.platform_ready)) {
    details.push({
      label: "Estado",
      before: previous.platform_ready ? "Listo" : "Pendiente",
      after: current.platform_ready ? "Listo" : "Pendiente",
      message: current.platform_ready ? "Web y API disponibles" : "Aun faltan URLs de plataforma",
    });
  }

  const summary = details.length
    ? details.slice(0, 4).map((item) => item.message || item.label).join(" · ")
    : "Sin cambios relevantes";

  return {
    summary: note ? `${note}${details.length ? ` · ${summary}` : ""}` : summary,
    details: normalizePlatformDeploymentChangeDetails(details),
  };
}

const DEFAULT_ENVIRONMENTS = [
  { name: "Development", slug: "dev", description: "Validacion rapida y pruebas locales" },
  { name: "Testing", slug: "test", description: "QA, integracion y aprobaciones" },
  { name: "Production", slug: "prod", description: "Funciones publicas y estables" },
];

const DEFAULT_TEMPLATES = [
  {
    id: "tpl-http-json",
    name: "HTTP JSON",
    slug: "http-json",
    category: "api",
    runtime: "node20",
    description: "Endpoint HTTP que responde JSON y lee query params.",
    code: `export default async function handler(req) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "world";

  return new Response(JSON.stringify({ hello: name }), {
    headers: { "content-type": "application/json" }
  });
}
`,
  },
  {
    id: "tpl-webhook",
    name: "Webhook Handler",
    slug: "webhook-handler",
    category: "integrations",
    runtime: "node20",
    description: "Recibe eventos JSON y devuelve un acuse de recibo.",
    code: `export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const event = await req.json();
  console.log("Webhook received", event.type ?? "unknown");

  return Response.json({ received: true });
}
`,
  },
  {
    id: "tpl-secret-check",
    name: "Secret Check",
    slug: "secret-check",
    category: "ops",
    runtime: "node20",
    description: "Ejemplo de lectura segura de variables de entorno.",
    code: `export default async function handler() {
  const configured = Boolean(process.env.API_KEY);

  return Response.json({
    ok: configured,
    message: configured ? "Secret loaded" : "Missing API_KEY"
  });
}
`,
  },
  {
    id: "tpl-python-json-api",
    name: "Python JSON API",
    slug: "python-json-api",
    category: "api",
    runtime: "python311",
    description: "API Python simple con GET/POST, query params y body JSON.",
    entrypoint: "index.py",
    code: `import json
import os
from datetime import datetime, timezone

def handler(request):
    method = request.get("method", "GET")
    query = request.get("query", {})
    name = query.get("name", "world")

    if method == "POST":
        raw_body = request.get("body") or b"{}"
        payload = json.loads(raw_body.decode("utf-8") or "{}")
        return {
            "ok": True,
            "received": payload,
            "runtime": "python311"
        }

    return {
        "status": "OK",
        "message": f"Hola {name} desde Python",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "greeting": os.getenv("GREETING", "default"),
        "version": "1.0"
    }
`,
    files: [{
      path: "index.py",
      content: `import json
import os
from datetime import datetime, timezone

def handler(request):
    method = request.get("method", "GET")
    query = request.get("query", {})
    name = query.get("name", "world")

    if method == "POST":
        raw_body = request.get("body") or b"{}"
        payload = json.loads(raw_body.decode("utf-8") or "{}")
        return {
            "ok": True,
            "received": payload,
            "runtime": "python311"
        }

    return {
        "status": "OK",
        "message": f"Hola {name} desde Python",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "greeting": os.getenv("GREETING", "default"),
        "version": "1.0"
    }
`,
    }],
  },
  {
    id: "tpl-java-spring-api",
    name: "Java Spring Boot API",
    slug: "java-spring-api",
    category: "api",
    runtime: "java-spring",
    description: "Proyecto Spring Boot con clase principal, controller y Maven.",
    entrypoint: "src/main/java/com/example/demo/controller/TestController.java",
    code: `package com.example.demo.controller;

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
`,
    files: [
      {
        path: "pom.xml",
        content: `<?xml version="1.0" encoding="UTF-8"?>
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
`,
      },
      {
        path: "src/main/java/com/example/demo/DemoApplication.java",
        content: `package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {
  public static void main(String[] args) {
    SpringApplication.run(DemoApplication.class, args);
  }
}
`,
      },
      {
        path: "src/main/java/com/example/demo/controller/TestController.java",
        content: `package com.example.demo.controller;

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
`,
      },
      {
        path: "src/main/resources/application.properties",
        content: `server.address=0.0.0.0
server.port=\${FPM_PORT:8080}
`,
      },
    ],
  },
  {
    id: "tpl-dotnet-minimal-api",
    name: "C# .NET Minimal API",
    slug: "dotnet-minimal-api",
    category: "api",
    runtime: "dotnet8",
    description: "API ASP.NET Core Minimal API con GET/POST JSON.",
    entrypoint: "Program.cs",
    code: `var builder = WebApplication.CreateBuilder(args);
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
`,
    files: [
      {
        path: "Api.csproj",
        content: `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AssemblyName>app</AssemblyName>
  </PropertyGroup>
</Project>
`,
      },
      {
        path: "Program.cs",
        content: `var builder = WebApplication.CreateBuilder(args);
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
`,
      },
    ],
  },
  {
    id: "tpl-deno-api-key-auth",
    name: "Deno API Key Auth",
    slug: "deno-api-key-auth",
    category: "security",
    runtime: "deno",
    description: "Endpoint Deno que valida x-api-key contra API_KEY y responde JSON.",
    entrypoint: "index.ts",
    code: `const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const expected = Deno.env.get("API_KEY");
  const provided = req.headers.get("x-api-key");

  if (!expected) return json({ error: "Missing API_KEY secret" }, 500);
  if (!provided) return json({ error: "Missing x-api-key header" }, 401);
  if (provided !== expected) return json({ error: "Invalid API key" }, 403);

  return json({ ok: true, runtime: "deno", message: "Acceso autorizado" });
});
`,
    files: [{
      path: "index.ts",
      content: `const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const expected = Deno.env.get("API_KEY");
  const provided = req.headers.get("x-api-key");

  if (!expected) return json({ error: "Missing API_KEY secret" }, 500);
  if (!provided) return json({ error: "Missing x-api-key header" }, 401);
  if (provided !== expected) return json({ error: "Invalid API key" }, 403);

  return json({ ok: true, runtime: "deno", message: "Acceso autorizado" });
});
`,
    }],
  },
  {
    id: "tpl-node-token-generator",
    name: "Node Token Generator",
    slug: "node-token-generator",
    category: "security",
    runtime: "node20",
    description: "Genera tokens opacos para consumidores y usa TOKEN_ISSUER desde secrets.",
    entrypoint: "index.mjs",
    code: `import crypto from "node:crypto";

export default async function handler(req) {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await req.json().catch(() => ({}));
  const subject = body.subject || "consumer";
  const issuer = process.env.TOKEN_ISSUER || "function-platform";
  const token = "tok_" + crypto.randomBytes(32).toString("base64url");

  return Response.json({
    token,
    subject,
    issuer,
    created_at: new Date().toISOString(),
  });
}
`,
    files: [{
      path: "index.mjs",
      content: `import crypto from "node:crypto";

export default async function handler(req) {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await req.json().catch(() => ({}));
  const subject = body.subject || "consumer";
  const issuer = process.env.TOKEN_ISSUER || "function-platform";
  const token = "tok_" + crypto.randomBytes(32).toString("base64url");

  return Response.json({
    token,
    subject,
    issuer,
    created_at: new Date().toISOString(),
  });
}
`,
    }],
  },
  {
    id: "tpl-python-authenticator",
    name: "Python Authenticator",
    slug: "python-authenticator",
    category: "security",
    runtime: "python311",
    description: "Autenticador Python que valida x-api-key y devuelve datos del consumidor.",
    entrypoint: "index.py",
    code: `import os

def handler(request):
    headers = request.get("headers", {})
    expected = os.getenv("API_KEY")
    provided = headers.get("x-api-key") or headers.get("X-Api-Key")

    if not expected:
        return {"error": "Missing API_KEY secret"}, 500
    if not provided:
        return {"error": "Missing x-api-key header"}, 401
    if provided != expected:
        return {"error": "Invalid API key"}, 403

    return {"ok": True, "runtime": "python311", "consumer": request.get("query", {}).get("consumer", "default")}
`,
    files: [{
      path: "index.py",
      content: `import os

def handler(request):
    headers = request.get("headers", {})
    expected = os.getenv("API_KEY")
    provided = headers.get("x-api-key") or headers.get("X-Api-Key")

    if not expected:
        return {"error": "Missing API_KEY secret"}, 500
    if not provided:
        return {"error": "Missing x-api-key header"}, 401
    if provided != expected:
        return {"error": "Invalid API key"}, 403

    return {"ok": True, "runtime": "python311", "consumer": request.get("query", {}).get("consumer", "default")}
`,
    }],
  },
];

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  tenant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS functions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  code TEXT NOT NULL,
  files JSONB,
  entrypoint TEXT,
  runtime TEXT NOT NULL DEFAULT 'node20',
  memory_mb INTEGER NOT NULL DEFAULT 256,
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'idle',
  container_id TEXT,
  url TEXT,
  active_deploy_version TEXT NOT NULL DEFAULT 'v1',
  auth_required BOOLEAN NOT NULL DEFAULT false,
  auth_header_name TEXT NOT NULL DEFAULT 'x-api-key',
  api_tokens JSONB DEFAULT '[]'::jsonb,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  source_function_id TEXT REFERENCES functions(id) ON DELETE SET NULL,
  validation_status TEXT,
  validation_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (function_id, key)
);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  deployment_id TEXT,
  message TEXT NOT NULL,
  ts TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  url TEXT,
  validation_status TEXT,
  validation_summary TEXT,
  error TEXT,
  deprecated_at TIMESTAMPTZ,
  deprecated_reason TEXT,
  snapshot JSONB DEFAULT '{}'::jsonb,
  change_summary TEXT,
  change_details JSONB DEFAULT '[]'::jsonb,
  source_deployment_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS deployment_targets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'azure',
  deployment_mode TEXT NOT NULL DEFAULT 'manual',
  auto_deploy BOOLEAN NOT NULL DEFAULT false,
  azure_subscription_id TEXT,
  azure_tenant_id TEXT,
  azure_client_id TEXT,
  azure_client_secret TEXT,
  azure_resource_group TEXT,
  azure_location TEXT,
  acr_name TEXT,
  acr_login_server TEXT,
  acr_username TEXT,
  acr_password TEXT,
  container_app_environment TEXT,
  container_app_name_prefix TEXT,
  azure_container_app_name TEXT,
  azure_container_app_url TEXT,
  azure_container_config_hash TEXT,
  azure_container_created_at TIMESTAMPTZ,
  azure_managed_environment_created_at TIMESTAMPTZ,
  azure_provisioning_status TEXT,
  azure_provisioning_step TEXT,
  azure_provisioning_percent INTEGER NOT NULL DEFAULT 0,
  azure_provisioning_error TEXT,
  azure_provisioning_steps JSONB DEFAULT '[]'::jsonb,
  platform_api_container_app_name TEXT,
  platform_api_container_app_url TEXT,
  platform_api_image TEXT,
  platform_web_container_app_name TEXT,
  platform_web_container_app_url TEXT,
  platform_web_image TEXT,
  platform_version TEXT NOT NULL DEFAULT '1.0.0',
  platform_deployed_version TEXT,
  platform_deployed_at TIMESTAMPTZ,
  platform_deploy_started_at TIMESTAMPTZ,
  platform_deploy_step TEXT,
  platform_deploy_percent INTEGER NOT NULL DEFAULT 0,
  platform_deploy_logs JSONB DEFAULT '[]'::jsonb,
  platform_deploy_status TEXT,
  platform_deploy_error TEXT,
  memory_budget_mb INTEGER NOT NULL DEFAULT 0,
  git_repo_url TEXT,
  git_branch TEXT,
  git_workflow_path TEXT,
  git_token TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, environment_id)
);

CREATE TABLE IF NOT EXISTS platform_deployments (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES deployment_targets(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  snapshot JSONB DEFAULT '{}'::jsonb,
  change_summary TEXT,
  change_details JSONB DEFAULT '[]'::jsonb,
  source_platform_deployment_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  category TEXT,
  runtime TEXT NOT NULL DEFAULT 'node20',
  description TEXT,
  code TEXT NOT NULL,
  files JSONB,
  entrypoint TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS runtime TEXT NOT NULL DEFAULT 'node20';
ALTER TABLE functions ADD COLUMN IF NOT EXISTS files JSONB;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS entrypoint TEXT;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS active_deploy_version TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE functions ADD COLUMN IF NOT EXISTS auth_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS auth_header_name TEXT NOT NULL DEFAULT 'x-api-key';
ALTER TABLE functions ADD COLUMN IF NOT EXISTS api_tokens JSONB DEFAULT '[]'::jsonb;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS memory_mb INTEGER NOT NULL DEFAULT 256;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER NOT NULL DEFAULT 30;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS source_function_id TEXT REFERENCES functions(id) ON DELETE SET NULL;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS validation_status TEXT;
ALTER TABLE functions ADD COLUMN IF NOT EXISTS validation_summary TEXT;
DO $$
DECLARE
  constraint_record record;
BEGIN
  FOR constraint_record IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attname = 'slug'
    WHERE con.conrelid = 'functions'::regclass
      AND con.contype = 'u'
      AND con.conkey = ARRAY[att.attnum]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE functions DROP CONSTRAINT IF EXISTS %I', constraint_record.conname);
  END LOOP;
END $$;
WITH normalized_function_slugs AS (
  SELECT f.id,
         regexp_replace(f.slug, '-' || e.slug || '$', '') AS new_slug,
         f.project_id,
         f.environment_id
  FROM functions f
  JOIN environments e ON e.id = f.environment_id
  WHERE e.slug IN ('test', 'prod')
    AND f.slug ~ ('-' || e.slug || '$')
),
safe_function_slugs AS (
  SELECT item.*
  FROM normalized_function_slugs item
  WHERE item.new_slug <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM functions other
      WHERE other.id <> item.id
        AND COALESCE(other.project_id, '') = COALESCE(item.project_id, '')
        AND COALESCE(other.environment_id, '') = COALESCE(item.environment_id, '')
        AND other.slug = item.new_slug
    )
)
UPDATE functions f
SET slug = item.new_slug,
    updated_at = now()
FROM safe_function_slugs item
WHERE f.id = item.id;
CREATE UNIQUE INDEX IF NOT EXISTS functions_project_environment_slug_idx
ON functions (COALESCE(project_id, ''), COALESCE(environment_id, ''), slug);
CREATE INDEX IF NOT EXISTS projects_tenant_id_idx
ON projects (tenant_id);
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL;
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE secrets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE secrets ALTER COLUMN function_id DROP NOT NULL;
UPDATE secrets s
SET project_id=COALESCE(s.project_id, f.project_id),
    environment_id=COALESCE(s.environment_id, f.environment_id)
FROM functions f
WHERE s.function_id=f.id
  AND (s.project_id IS NULL OR s.environment_id IS NULL);
UPDATE secrets s
SET environment_id=e.id
FROM environments e
WHERE s.project_id=e.project_id
  AND e.slug='dev'
  AND s.project_id IS NOT NULL
  AND s.environment_id IS NULL;
DELETE FROM secrets a USING secrets b
WHERE a.project_id IS NOT NULL
  AND b.project_id IS NOT NULL
  AND a.project_id=b.project_id
  AND COALESCE(a.environment_id, '')=COALESCE(b.environment_id, '')
  AND a.key=b.key
  AND a.id > b.id;
DROP INDEX IF EXISTS secrets_project_key_idx;
INSERT INTO secrets (id,function_id,project_id,environment_id,key,value,created_at,updated_at)
SELECT substr(md5(s.id || test_env.id || clock_timestamp()::text || random()::text), 1, 10),
       NULL,
       s.project_id,
       test_env.id,
       s.key,
       s.value,
       now(),
       now()
FROM secrets s
JOIN environments dev_env ON dev_env.id=s.environment_id AND dev_env.slug='dev'
JOIN environments test_env ON test_env.project_id=s.project_id AND test_env.slug='test'
WHERE s.project_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key='secrets_dev_to_test_migrated')
  AND NOT EXISTS (
    SELECT 1
    FROM secrets existing
    WHERE existing.project_id=s.project_id
      AND existing.environment_id=test_env.id
      AND existing.key=s.key
  );
CREATE UNIQUE INDEX IF NOT EXISTS secrets_project_environment_key_idx
ON secrets (project_id, environment_id, key)
WHERE project_id IS NOT NULL AND environment_id IS NOT NULL;
INSERT INTO settings (key,value)
VALUES ('secrets_dev_to_test_migrated','true')
ON CONFLICT (key) DO NOTHING;
ALTER TABLE logs ADD COLUMN IF NOT EXISTS environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL;
ALTER TABLE logs ADD COLUMN IF NOT EXISTS deployment_id TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deprecated_at TIMESTAMPTZ;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deprecated_reason TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS snapshot JSONB DEFAULT '{}'::jsonb;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS change_summary TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS change_details JSONB DEFAULT '[]'::jsonb;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS source_deployment_id TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS memory_budget_mb INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_container_app_name TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_container_app_url TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_container_config_hash TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_container_created_at TIMESTAMPTZ;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_managed_environment_created_at TIMESTAMPTZ;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_provisioning_status TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_provisioning_step TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_provisioning_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_provisioning_error TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS azure_provisioning_steps JSONB DEFAULT '[]'::jsonb;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_api_container_app_name TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_api_container_app_url TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_api_image TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_web_container_app_name TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_web_container_app_url TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_web_image TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_deployed_version TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_deployed_at TIMESTAMPTZ;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_deploy_started_at TIMESTAMPTZ;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_deploy_step TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_deploy_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_deploy_logs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_deploy_status TEXT;
ALTER TABLE deployment_targets ADD COLUMN IF NOT EXISTS platform_deploy_error TEXT;
ALTER TABLE platform_deployments ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE platform_deployments ADD COLUMN IF NOT EXISTS snapshot JSONB DEFAULT '{}'::jsonb;
ALTER TABLE platform_deployments ADD COLUMN IF NOT EXISTS change_summary TEXT;
ALTER TABLE platform_deployments ADD COLUMN IF NOT EXISTS change_details JSONB DEFAULT '[]'::jsonb;
ALTER TABLE platform_deployments ADD COLUMN IF NOT EXISTS source_platform_deployment_id TEXT;
ALTER TABLE platform_deployments ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE platform_deployments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
CREATE INDEX IF NOT EXISTS platform_deployments_target_updated_idx ON platform_deployments (target_id, updated_at DESC);
ALTER TABLE templates ADD COLUMN IF NOT EXISTS files JSONB;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS entrypoint TEXT;
WITH latest_deployments AS (
  SELECT DISTINCT ON (function_id) id, function_id
  FROM deployments
  WHERE status='success'
  ORDER BY function_id, created_at DESC
)
UPDATE deployments d
SET active = CASE WHEN d.id = l.id THEN true ELSE false END,
    deprecated_at = CASE
      WHEN d.id <> l.id AND d.status='success' AND d.deprecated_at IS NULL THEN COALESCE(d.finished_at, d.created_at, now())
      ELSE d.deprecated_at
    END,
    deprecated_reason = CASE
      WHEN d.id <> l.id AND d.status='success' AND d.deprecated_reason IS NULL THEN 'Version reemplazada por un deployment mas reciente'
      ELSE d.deprecated_reason
    END
FROM latest_deployments l
WHERE d.function_id=l.function_id
  AND d.status='success';
`;

let pool = null;
let storeMode = "file";
const filePath = process.env.DATA_FILE || join(process.cwd(), "data", "function-platform.json");
const FILE_ENCRYPTION_PREFIX = "fpm:v1:aes-256-gcm:";
let state = {
  projects: [],
  environments: [],
  functions: [],
  secrets: [],
  logs: [],
  deployments: [],
  platform_deployments: [],
  deployment_targets: [],
  templates: [],
  settings: [],
};

function dataEncryptionKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY || process.env.FPM_DATA_ENCRYPTION_KEY || "";
  if (!String(raw).trim()) return null;
  return createHash("sha256").update(String(raw)).digest();
}

function requireDataEncryptionKey() {
  if (String(process.env.DATA_ENCRYPTION_REQUIRED || "").toLowerCase() !== "true") return;
  if (!dataEncryptionKey()) {
    throw new Error("DATA_ENCRYPTION_REQUIRED=true pero falta DATA_ENCRYPTION_KEY. Configura una clave estable antes de iniciar en modo file.");
  }
}

function encryptFileStorePayload(plainText) {
  const key = dataEncryptionKey();
  if (!key) return plainText;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FILE_ENCRYPTION_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

function decryptFileStorePayload(raw) {
  const text = String(raw || "");
  if (!text.trim().startsWith(FILE_ENCRYPTION_PREFIX)) {
    return { json: text, encrypted: false };
  }

  const key = dataEncryptionKey();
  if (!key) {
    throw new Error("El DATA_FILE esta cifrado. Configura DATA_ENCRYPTION_KEY con la misma clave usada al crearlo.");
  }

  const payload = Buffer.from(text.trim().slice(FILE_ENCRYPTION_PREFIX.length), "base64url");
  if (payload.length <= 28) throw new Error("El DATA_FILE cifrado tiene un formato invalido.");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return { json: decrypted.toString("utf8"), encrypted: true };
}

function normalizeConnectionString(raw) {
  const url = new URL(raw);
  const sslMode = url.searchParams.get("sslmode");
  if (["prefer", "require", "verify-ca"].includes(sslMode || "")) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

function poolConfig(raw) {
  const normalized = normalizeConnectionString(raw);
  const url = new URL(normalized);
  const sslMode = url.searchParams.get("sslmode");
  const cfg = { connectionString: normalized, connectionTimeoutMillis: 5000 };
  if (sslMode && sslMode !== "disable" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    cfg.ssl = { rejectUnauthorized: sslMode === "verify-full" };
  }
  return cfg;
}

async function loadFileStore() {
  requireDataEncryptionKey();
  await mkdir(dirname(filePath), { recursive: true });
  let loadedEncrypted = false;
  try {
    const raw = await readFile(filePath, "utf8");
    const decoded = decryptFileStorePayload(raw);
    loadedEncrypted = decoded.encrypted;
    state = { ...state, ...JSON.parse(decoded.json) };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await persist();
  }
  seedFileStore();
  await ensureLegacyTenantBackfill();
  if (dataEncryptionKey() && !loadedEncrypted) {
    console.warn(`[data] Migrando ${filePath} a almacenamiento cifrado at-rest.`);
  }
  await persist();
}

async function persist() {
  if (storeMode !== "file") return;
  requireDataEncryptionKey();
  await mkdir(dirname(filePath), { recursive: true });
  const json = JSON.stringify(state, null, 2);
  await writeFile(filePath, encryptFileStorePayload(json));
}

function seedFileStore() {
  const defaultTenantId = resolveTenantId(process.env.DEFAULT_TENANT_ID || process.env.FPM_DEFAULT_TENANT_ID || null);
  state.projects = (state.projects || []).map((project) => ({
    ...project,
    tenant_id: project.tenant_id || defaultTenantId || null,
  }));
  state.templates ||= [];
  state.deployment_targets ||= [];
  state.deployments ||= [];
  state.functions = (state.functions || []).map((fn) => ({
    ...fn,
    active_deploy_version: normalizeDeployVersion(fn.active_deploy_version || "v1"),
    auth_required: Boolean(fn.auth_required),
    auth_header_name: normalizeAuthHeaderName(fn.auth_header_name),
    api_tokens: normalizeApiTokens(fn.api_tokens),
      ...normalizeFunctionSource(fn),
  }));
  normalizeFileFunctionSlugs();
  normalizeFileDeploymentHistory();
  normalizeFilePlatformDeploymentHistory();
  normalizeFileSecrets();
  for (const tpl of DEFAULT_TEMPLATES) {
    const existing = state.templates.find((t) => t.slug === tpl.slug);
    if (!existing) {
      state.templates.push({ ...tpl, created_at: now(), updated_at: now() });
    } else {
      Object.assign(existing, {
        ...tpl,
        id: existing.id || tpl.id,
        created_at: existing.created_at || now(),
        updated_at: now(),
      });
    }
  }
}

export async function ensureLegacyTenantBackfill(tenantId = null) {
  if (storeMode !== "file") return false;
  const resolvedTenantId = resolveTenantId(tenantId);
  if (!resolvedTenantId) return false;

  const legacyProjects = (state.projects || []).filter((project) => !String(project.tenant_id || "").trim());
  if (!legacyProjects.length) return false;

  for (const project of legacyProjects) {
    project.tenant_id = resolvedTenantId;
    project.updated_at = project.updated_at || now();
  }

  await persist();
  return true;
}

function normalizeFileSecrets() {
  state.settings ||= [];
  const hadLegacySecrets = (state.secrets || []).some((secret) => !secret.environment_id);
  const devToTestMigrationDone = state.settings.some((item) => item.key === "secrets_dev_to_test_migrated");

  for (const project of state.projects || []) {
    for (const env of DEFAULT_ENVIRONMENTS) {
      if (!state.environments.some((item) => item.project_id === project.id && item.slug === env.slug)) {
        state.environments.push({
          id: nanoid(10),
          project_id: project.id,
          name: env.name,
          slug: env.slug,
          description: env.description,
          created_at: now(),
          updated_at: now(),
        });
      }
    }
  }

  const envById = new Map((state.environments || []).map((env) => [env.id, env]));
  const functionById = new Map((state.functions || []).map((fn) => [fn.id, fn]));
  const envByProjectSlug = new Map((state.environments || []).map((env) => [`${env.project_id}:${env.slug}`, env]));
  const secretByScope = new Map();

  state.secrets = (state.secrets || []).reduce((items, secret) => {
    const fn = secret.function_id ? functionById.get(secret.function_id) : null;
    const projectId = secret.project_id || fn?.project_id || null;
    const env = envById.get(secret.environment_id) || (fn?.environment_id ? envById.get(fn.environment_id) : null) || envByProjectSlug.get(`${projectId}:dev`);
    const key = String(secret.key || "").trim().toUpperCase();
    if (!projectId || !env?.id || !key) return items;

    const mapKey = `${projectId}:${env.id}:${key}`;
    const next = {
      ...secret,
      id: secret.id || nanoid(10),
      function_id: null,
      project_id: projectId,
      environment_id: env.id,
      key,
      value: secret.value ?? "",
      created_at: secret.created_at || now(),
      updated_at: secret.updated_at || now(),
    };
    const existingIndex = secretByScope.get(mapKey);
    if (existingIndex === undefined) {
      secretByScope.set(mapKey, items.length);
      items.push(next);
    } else if (String(next.updated_at).localeCompare(String(items[existingIndex].updated_at)) >= 0) {
      items[existingIndex] = next;
    }
    return items;
  }, []);

  if (!hadLegacySecrets || devToTestMigrationDone) return;

  for (const project of state.projects || []) {
    const devEnv = envByProjectSlug.get(`${project.id}:dev`);
    const testEnv = envByProjectSlug.get(`${project.id}:test`);
    if (!devEnv || !testEnv) continue;

    const testKeys = new Set(
      state.secrets
        .filter((secret) => secret.project_id === project.id && secret.environment_id === testEnv.id)
        .map((secret) => secret.key)
    );
    const devSecrets = state.secrets.filter((secret) => secret.project_id === project.id && secret.environment_id === devEnv.id);
    for (const secret of devSecrets) {
      if (testKeys.has(secret.key)) continue;
      state.secrets.push({
        ...secret,
        id: nanoid(10),
        function_id: null,
        environment_id: testEnv.id,
        created_at: now(),
        updated_at: now(),
      });
      testKeys.add(secret.key);
    }
  }

  state.settings.push({
    key: "secrets_dev_to_test_migrated",
    value: "true",
    updated_at: now(),
  });
}

function normalizeFileFunctionSlugs() {
  const byId = new Map((state.environments || []).map((env) => [env.id, env]));
  for (const fn of state.functions || []) {
    const env = byId.get(fn.environment_id);
    if (!env || !["test", "prod"].includes(env.slug)) continue;
    const suffix = `-${env.slug}`;
    if (!String(fn.slug || "").endsWith(suffix)) continue;
    const nextSlug = String(fn.slug).slice(0, -suffix.length);
    if (!nextSlug) continue;
    const hasCollision = state.functions.some((other) =>
      other.id !== fn.id &&
      other.project_id === fn.project_id &&
      other.environment_id === fn.environment_id &&
      other.slug === nextSlug
    );
    if (!hasCollision) fn.slug = nextSlug;
  }
}

function normalizeFileDeploymentHistory() {
  state.deployments = (state.deployments || []).map((deployment) => ({
    ...deployment,
    active: Boolean(deployment.active),
    deprecated_at: deployment.deprecated_at || null,
    deprecated_reason: deployment.deprecated_reason || null,
    snapshot: deployment.snapshot || {},
    change_summary: deployment.change_summary || null,
    change_details: normalizeDeploymentChangeDetails(deployment.change_details || []),
    source_deployment_id: deployment.source_deployment_id || null,
    updated_at: deployment.updated_at || deployment.finished_at || deployment.created_at || now(),
  }));

  const byFunction = new Map();
  for (const deployment of state.deployments) {
    if (!deployment.function_id || deployment.status !== "success") continue;
    byFunction.set(deployment.function_id, [...(byFunction.get(deployment.function_id) || []), deployment]);
  }

  for (const deployments of byFunction.values()) {
    const latest = deployments
      .slice()
      .sort((a, b) => String(b.finished_at || b.created_at || "").localeCompare(String(a.finished_at || a.created_at || "")))[0];
    for (const deployment of deployments) {
      if (latest && deployment.id === latest.id) {
        deployment.active = true;
        deployment.deprecated_at = null;
        deployment.deprecated_reason = null;
      } else {
        deployment.active = false;
        deployment.deprecated_at ||= deployment.finished_at || deployment.created_at || now();
        deployment.deprecated_reason ||= "Version reemplazada por un deployment mas reciente";
      }
    }
  }
}

function normalizeFilePlatformDeploymentHistory() {
  state.platform_deployments = (state.platform_deployments || []).map((deployment) => ({
    ...deployment,
    active: Boolean(deployment.active),
    snapshot: deployment.snapshot || {},
    change_summary: deployment.change_summary || null,
    change_details: normalizePlatformDeploymentChangeDetails(deployment.change_details || []),
    source_platform_deployment_id: deployment.source_platform_deployment_id || null,
    error: deployment.error || null,
    updated_at: deployment.updated_at || deployment.finished_at || deployment.created_at || now(),
  }));

  const byTarget = new Map();
  for (const deployment of state.platform_deployments) {
    if (!deployment.target_id || deployment.status !== "success") continue;
    byTarget.set(deployment.target_id, [...(byTarget.get(deployment.target_id) || []), deployment]);
  }

  for (const deployments of byTarget.values()) {
    const latest = deployments
      .slice()
      .sort((a, b) => String(b.finished_at || b.created_at || "").localeCompare(String(a.finished_at || a.created_at || "")))[0];
    for (const deployment of deployments) {
      if (latest && deployment.id === latest.id) {
        deployment.active = true;
      } else {
        deployment.active = false;
      }
    }
  }
}

async function seedPostgres() {
  for (const tpl of DEFAULT_TEMPLATES) {
    await pool.query(
      `INSERT INTO templates (id,name,slug,category,runtime,description,code,files,entrypoint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (slug) DO UPDATE SET
         name=EXCLUDED.name,
         category=EXCLUDED.category,
         runtime=EXCLUDED.runtime,
         description=EXCLUDED.description,
         code=EXCLUDED.code,
         files=EXCLUDED.files,
         entrypoint=EXCLUDED.entrypoint,
         updated_at=now()`,
      [tpl.id, tpl.name, tpl.slug, tpl.category, tpl.runtime, tpl.description, tpl.code, JSON.stringify(tpl.files || null), tpl.entrypoint || null]
    );
  }
}

export async function initDb() {
  if (process.env.DATA_STORE !== "file" && process.env.DATABASE_URL) {
    try {
      pool = new Pool(poolConfig(process.env.DATABASE_URL));
      await pool.query(INIT_SQL);
      await seedPostgres();
      storeMode = "postgres";
      return;
    } catch (error) {
      console.warn("[db] PostgreSQL unavailable, using local file store:", error?.message || error);
      pool = null;
    }
  }

  storeMode = "file";
  await loadFileStore();
}

export function getStoreMode() {
  return storeMode;
}

export async function q(text, params) {
  if (!pool) throw new Error("Raw SQL is available only when PostgreSQL is active");
  return pool.query(text, params);
}

async function ensureProjectEnvironments(projectId) {
  if (!projectId) return [];

  if (storeMode === "postgres") {
    for (const env of DEFAULT_ENVIRONMENTS) {
      await pool.query(
        `INSERT INTO environments (id,project_id,name,slug,description)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (project_id, slug) DO NOTHING`,
        [nanoid(10), projectId, env.name, env.slug, env.description]
      );
    }
    return (await listEnvironments({ project_id: projectId })).rows;
  }

  for (const env of DEFAULT_ENVIRONMENTS) {
    if (!state.environments.some((e) => e.project_id === projectId && e.slug === env.slug)) {
      state.environments.push({
        id: nanoid(10),
        project_id: projectId,
        name: env.name,
        slug: env.slug,
        description: env.description,
        created_at: now(),
        updated_at: now(),
      });
    }
  }
  await persist();
  return state.environments.filter((e) => e.project_id === projectId);
}

async function uniqueSlug(table, base, predicate = () => true) {
  let slug = slugify(base);
  let exists = false;

  if (storeMode === "postgres") {
    const column = table === "projects" || table === "templates" ? "slug" : "slug";
    exists = (await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1 LIMIT 1`, [slug])).rowCount > 0;
  } else {
    exists = state[table].some((row) => row.slug === slug && predicate(row));
  }

  if (!exists) return slug;
  return `${slug}-${nanoid(4).toLowerCase()}`;
}

async function uniqueFunctionSlug(base, { project_id = null, environment_id = null, exclude_id = null } = {}) {
  const slug = slugify(base);
  const scopedProjectId = project_id || "";
  const scopedEnvironmentId = environment_id || "";
  const excludedId = exclude_id || "";
  let exists = false;

  if (storeMode === "postgres") {
    exists = (await pool.query(
      `SELECT 1
       FROM functions
       WHERE slug=$1
         AND COALESCE(project_id, '')=$2
         AND COALESCE(environment_id, '')=$3
         AND ($4='' OR id<>$4)
       LIMIT 1`,
      [slug, scopedProjectId, scopedEnvironmentId, excludedId]
    )).rowCount > 0;
  } else {
    exists = state.functions.some((row) =>
      row.slug === slug &&
      (row.project_id || "") === scopedProjectId &&
      (row.environment_id || "") === scopedEnvironmentId &&
      (!excludedId || row.id !== excludedId)
    );
  }

  if (!exists) return slug;
  return `${slug}-${nanoid(4).toLowerCase()}`;
}

function hydrateFunction(fn) {
  if (!fn) return fn;
  return {
    ...fn,
    active_deploy_version: normalizeDeployVersion(fn.active_deploy_version || "v1"),
    auth_required: Boolean(fn.auth_required),
    auth_header_name: normalizeAuthHeaderName(fn.auth_header_name),
    api_tokens: normalizeApiTokens(fn.api_tokens),
    ...normalizeFunctionSource(fn),
  };
}

function enrichFunction(fn) {
  if (!fn) return fn;
  const hydrated = hydrateFunction(fn);
  if (storeMode === "postgres") return hydrated;
  const project = state.projects.find((p) => p.id === hydrated.project_id);
  const environment = state.environments.find((e) => e.id === hydrated.environment_id);
  return {
    ...hydrated,
    project_name: project?.name || null,
    project_slug: project?.slug || null,
    environment_name: environment?.name || null,
    environment_slug: environment?.slug || null,
  };
}

const FUNCTION_SELECT = `
  SELECT f.*,
         p.name AS project_name,
         p.slug AS project_slug,
         e.name AS environment_name,
         e.slug AS environment_slug
  FROM functions f
  LEFT JOIN projects p ON p.id=f.project_id
  LEFT JOIN environments e ON e.id=f.environment_id
`;

export async function listProjects({ tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return [];
  if (storeMode === "postgres") {
    const params = [];
    const clauses = [];
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      clauses.push(`p.tenant_id=$${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT p.*,
              COUNT(f.id)::int AS function_count
       FROM projects p
       LEFT JOIN functions f ON f.project_id=p.id
       ${where}
       GROUP BY p.id
       ORDER BY p.created_at DESC`
      ,
      params
    );
    return result.rows;
  }

  return clone(
    state.projects
      .filter((project) => !resolvedTenantId || String(project.tenant_id || "") === resolvedTenantId)
      .map((project) => ({
        ...project,
        function_count: state.functions.filter((fn) => fn.project_id === project.id).length,
      }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  );
}

export async function createProject({ name, description, tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  const id = nanoid(10);
  const slug = await uniqueSlug("projects", name || `project-${id.slice(0, 4)}`);
  const project = {
    id,
    name: name || slug,
    slug,
    description: description || null,
    tenant_id: resolvedTenantId,
    created_at: now(),
    updated_at: now(),
  };

  if (storeMode === "postgres") {
    await pool.query(
      "INSERT INTO projects (id,name,slug,description,tenant_id) VALUES ($1,$2,$3,$4,$5)",
      [project.id, project.name, project.slug, project.description, project.tenant_id]
    );
    await ensureProjectEnvironments(project.id);
    return getProject(project.id);
  }

  state.projects.push(project);
  await ensureProjectEnvironments(project.id);
  await persist();
  return getProject(project.id);
}

export async function getProject(id, { tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return null;
  if (storeMode === "postgres") {
    const params = [id];
    let where = "WHERE id=$1";
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      where += ` AND tenant_id=$${params.length}`;
    }
    const project = (await pool.query(`SELECT * FROM projects ${where}`, params)).rows[0];
    if (!project) return null;
    const environments = await listEnvironments({ project_id: id, tenant_id: resolvedTenantId });
    const functions = await listFunctions({ project_id: id, tenant_id: resolvedTenantId });
    return { ...project, environments: environments.rows, functions };
  }

  const project = state.projects.find((p) => p.id === id);
  if (!project || (resolvedTenantId && String(project.tenant_id || "") !== resolvedTenantId)) return null;
  const environments = state.environments.filter((e) => e.project_id === id);
  const functions = state.functions.filter((fn) => fn.project_id === id).map(enrichFunction);
  return clone({ ...project, environments, functions });
}

export async function listEnvironments({ project_id, environment_slug, tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return { rows: [] };
  if (storeMode === "postgres") {
    const params = [];
    const clauses = [];
    if (project_id) {
      params.push(project_id);
      clauses.push(`e.project_id=$${params.length}`);
    }
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      clauses.push(`p.tenant_id=$${params.length}`);
    }
    if (environment_slug) {
      params.push(environment_slug);
      clauses.push(`e.slug=$${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT e.*,
              p.name AS project_name,
              COUNT(f.id)::int AS function_count
       FROM environments e
       JOIN projects p ON p.id=e.project_id
       LEFT JOIN functions f ON f.environment_id=e.id
       ${where}
       GROUP BY e.id,p.name,p.created_at
       ORDER BY COALESCE(e.updated_at, e.created_at) DESC,
         CASE e.slug WHEN 'dev' THEN 1 WHEN 'test' THEN 2 WHEN 'prod' THEN 3 ELSE 9 END`,
      params
    );
    return result;
  }

  const environments = state.environments
    .filter((env) => !project_id || env.project_id === project_id)
    .filter((env) => {
      if (!resolvedTenantId) return false;
      const project = state.projects.find((p) => p.id === env.project_id);
      return project?.tenant_id === resolvedTenantId;
    })
    .filter((env) => !environment_slug || env.slug === environment_slug)
    .map((env) => ({
      ...env,
      project_name: state.projects.find((p) => p.id === env.project_id)?.name || null,
      function_count: state.functions.filter((fn) => fn.environment_id === env.id).length,
    }));
  return { rows: clone(environments) };
}

export async function getEnvironment(id, { tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return null;
  if (storeMode === "postgres") {
    const params = [id];
    let where = "WHERE e.id=$1";
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      where += ` AND p.tenant_id=$${params.length}`;
    }
    return (await pool.query(
      `SELECT e.*
       FROM environments e
       JOIN projects p ON p.id=e.project_id
       ${where}`,
      params
    )).rows[0] || null;
  }
  const env = state.environments.find((e) => e.id === id) || null;
  if (!env) return null;
  if (resolvedTenantId) {
    const project = state.projects.find((p) => p.id === env.project_id);
    if (!project || project.tenant_id !== resolvedTenantId) return null;
  }
  return clone(env);
}

function maskTargetSecrets(target) {
  if (!target) return target;
  return {
    ...target,
    azure_client_secret: target.azure_client_secret ? "********" : "",
    acr_password: target.acr_password ? "********" : "",
    git_token: target.git_token ? "********" : "",
  };
}

function deploymentTargetDefaults(project, env) {
  const base = `${slugify(project?.slug || project?.name || "project")}-${slugify(env?.slug || env?.name || "env")}`;
  return {
    name: `${env?.slug || "env"} Container Apps`,
    container_app_name_prefix: base,
    container_app_environment: base,
    platform_version: "1.0.0",
  };
}

function normalizeTargetPayload(payload = {}, existing = {}, defaults = {}) {
  const keepSecret = (key) => {
    const value = payload[key];
    if (value === undefined) return existing[key] || "";
    if (value === "********") return existing[key] || "";
    return value || "";
  };

  return {
    name: payload.name || existing.name || defaults.name || "Container Apps target",
    provider: payload.provider || existing.provider || "azure",
    deployment_mode: payload.deployment_mode || existing.deployment_mode || "manual",
    auto_deploy: Boolean(payload.auto_deploy),
    azure_subscription_id: payload.azure_subscription_id || "",
    azure_tenant_id: payload.azure_tenant_id || "",
    azure_client_id: payload.azure_client_id || "",
    azure_client_secret: keepSecret("azure_client_secret"),
    azure_resource_group: payload.azure_resource_group || "",
    azure_location: payload.azure_location || "",
    acr_name: payload.acr_name || "",
    acr_login_server: payload.acr_login_server || "",
    acr_username: payload.acr_username || "",
    acr_password: keepSecret("acr_password"),
    container_app_environment: payload.container_app_environment || defaults.container_app_environment || "",
    container_app_name_prefix: payload.container_app_name_prefix || defaults.container_app_name_prefix || "",
    platform_version: payload.platform_version || existing.platform_version || defaults.platform_version || "1.0.0",
    memory_budget_mb: Number(payload.memory_budget_mb ?? existing.memory_budget_mb ?? 0) || 0,
    git_repo_url: payload.git_repo_url || "",
    git_branch: payload.git_branch || "main",
    git_workflow_path: payload.git_workflow_path || ".github/workflows/deploy-container-app.yml",
    git_token: keepSecret("git_token"),
  };
}

export async function listDeploymentTargets({ project_id, environment_id, environment_slug, includeSecrets = false, tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return [];
  if (storeMode === "postgres") {
    const clauses = [];
    const params = [];
    if (project_id) {
      params.push(project_id);
      clauses.push(`t.project_id=$${params.length}`);
    }
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      clauses.push(`p.tenant_id=$${params.length}`);
    }
    if (environment_id) {
      params.push(environment_id);
      clauses.push(`t.environment_id=$${params.length}`);
    }
    if (environment_slug) {
      params.push(environment_slug);
      clauses.push(`e.slug=$${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = (
      await pool.query(
        `SELECT t.*,
                p.name AS project_name,
                p.slug AS project_slug,
                e.name AS environment_name,
                e.slug AS environment_slug
         FROM deployment_targets t
         JOIN projects p ON p.id=t.project_id
         JOIN environments e ON e.id=t.environment_id
         ${where}
         ORDER BY p.name,
           CASE e.slug WHEN 'dev' THEN 1 WHEN 'test' THEN 2 WHEN 'prod' THEN 3 ELSE 9 END`,
        params
      )
    ).rows;
    return includeSecrets ? rows : rows.map(maskTargetSecrets);
  }

  const rows = state.deployment_targets
    .filter((target) => !project_id || target.project_id === project_id)
    .filter((target) => !environment_id || target.environment_id === environment_id)
    .filter((target) => {
      if (!resolvedTenantId) return false;
      const project = state.projects.find((p) => p.id === target.project_id);
      return project?.tenant_id === resolvedTenantId;
    })
    .map((target) => {
      const project = state.projects.find((p) => p.id === target.project_id);
      const env = state.environments.find((e) => e.id === target.environment_id);
      return {
        ...target,
        project_name: project?.name || null,
        project_slug: project?.slug || null,
        environment_name: env?.name || null,
        environment_slug: env?.slug || null,
      };
    })
    .filter((target) => !environment_slug || target.environment_slug === environment_slug);
  return clone(includeSecrets ? rows : rows.map(maskTargetSecrets));
}

export async function getDeploymentTarget(id, { includeSecrets = false, tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return null;
  if (!id) return null;

  if (storeMode === "postgres") {
    const params = [id];
    let where = "WHERE t.id=$1";
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      where += ` AND p.tenant_id=$${params.length}`;
    }
    const row = (
      await pool.query(
        `SELECT t.*,
                p.name AS project_name,
                p.slug AS project_slug,
                e.name AS environment_name,
                e.slug AS environment_slug
         FROM deployment_targets t
         JOIN projects p ON p.id=t.project_id
         JOIN environments e ON e.id=t.environment_id
         ${where}`,
        params
      )
    ).rows[0];
    if (!row) return null;
    return includeSecrets ? row : maskTargetSecrets(row);
  }

  const target = state.deployment_targets.find((item) => item.id === id);
  if (!target) return null;
  if (resolvedTenantId) {
    const project = state.projects.find((p) => p.id === target.project_id);
    if (!project || project.tenant_id !== resolvedTenantId) return null;
  }
  const project = state.projects.find((p) => p.id === target.project_id);
  const env = state.environments.find((e) => e.id === target.environment_id);
  const enriched = {
    ...target,
    project_name: project?.name || null,
    project_slug: project?.slug || null,
    environment_name: env?.name || null,
    environment_slug: env?.slug || null,
  };
  return clone(includeSecrets ? enriched : maskTargetSecrets(enriched));
}

export async function updateDeploymentTargetProvisioning(id, patch = {}) {
  const allowed = [
    "azure_container_app_name",
    "azure_container_app_url",
    "azure_container_config_hash",
    "azure_container_created_at",
    "azure_managed_environment_created_at",
    "azure_provisioning_status",
    "azure_provisioning_step",
    "azure_provisioning_percent",
    "azure_provisioning_error",
    "azure_provisioning_steps",
  ];
  const data = Object.fromEntries(Object.entries(patch).filter(([key, value]) => allowed.includes(key) && value !== undefined));
  if (!id || !Object.keys(data).length) return getDeploymentTarget(id);

  if (storeMode === "postgres") {
    const sets = [];
    const params = [id];
    for (const [key, value] of Object.entries(data)) {
      params.push(key === "azure_provisioning_steps" ? JSON.stringify(value || []) : value);
      sets.push(`${key}=$${params.length}`);
    }
    params.push(now());
    sets.push(`updated_at=$${params.length}`);
    await pool.query(`UPDATE deployment_targets SET ${sets.join(", ")} WHERE id=$1`, params);
    return getDeploymentTarget(id);
  }

  const target = state.deployment_targets.find((item) => item.id === id);
  if (!target) return null;
  Object.assign(target, data, { updated_at: now() });
  await persist();
  return getDeploymentTarget(id);
}

export async function updateDeploymentTargetPlatform(id, patch = {}) {
  const allowed = [
    "platform_api_container_app_name",
    "platform_api_container_app_url",
    "platform_api_image",
    "platform_web_container_app_name",
    "platform_web_container_app_url",
    "platform_web_image",
    "platform_version",
    "platform_deployed_version",
    "platform_deployed_at",
    "platform_deploy_started_at",
    "platform_deploy_step",
    "platform_deploy_percent",
    "platform_deploy_logs",
    "platform_deploy_status",
    "platform_deploy_error",
  ];
  const data = Object.fromEntries(Object.entries(patch).filter(([key, value]) => allowed.includes(key) && value !== undefined));
  if (!id || !Object.keys(data).length) return getDeploymentTarget(id);

  if (storeMode === "postgres") {
    const sets = [];
    const params = [id];
    for (const [key, value] of Object.entries(data)) {
      params.push(key === "platform_deploy_logs" ? JSON.stringify(value || []) : value);
      sets.push(`${key}=$${params.length}`);
    }
    params.push(now());
    sets.push(`updated_at=$${params.length}`);
    await pool.query(`UPDATE deployment_targets SET ${sets.join(", ")} WHERE id=$1`, params);
    return getDeploymentTarget(id);
  }

  const target = state.deployment_targets.find((item) => item.id === id);
  if (!target) return null;
  Object.assign(target, data, { updated_at: now() });
  await persist();
  return getDeploymentTarget(id);
}

export async function upsertDeploymentTarget({ project_id, environment_id, ...payload }) {
  if (!project_id || !environment_id) throw new Error("project_id and environment_id are required");
  const existing = (await listDeploymentTargets({ project_id, environment_id, includeSecrets: true }))[0] || {};
  const project = await getProject(project_id);
  const env = await getEnvironment(environment_id);
  if (!project || !env || env.project_id !== project.id) {
    throw new Error("El ambiente no pertenece al proyecto indicado");
  }
  const defaults = deploymentTargetDefaults(project, env);
  const data = normalizeTargetPayload(payload, existing, defaults);

  if (storeMode === "postgres") {
    const id = existing.id || nanoid(10);
    await pool.query(
      `INSERT INTO deployment_targets
       (id,project_id,environment_id,name,provider,deployment_mode,auto_deploy,
        azure_subscription_id,azure_tenant_id,azure_client_id,azure_client_secret,
        azure_resource_group,azure_location,acr_name,acr_login_server,acr_username,acr_password,
        container_app_environment,container_app_name_prefix,platform_version,memory_budget_mb,
        git_repo_url,git_branch,git_workflow_path,git_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (project_id, environment_id) DO UPDATE SET
        name=EXCLUDED.name,
        provider=EXCLUDED.provider,
        deployment_mode=EXCLUDED.deployment_mode,
        auto_deploy=EXCLUDED.auto_deploy,
        azure_subscription_id=EXCLUDED.azure_subscription_id,
        azure_tenant_id=EXCLUDED.azure_tenant_id,
        azure_client_id=EXCLUDED.azure_client_id,
        azure_client_secret=EXCLUDED.azure_client_secret,
        azure_resource_group=EXCLUDED.azure_resource_group,
        azure_location=EXCLUDED.azure_location,
        acr_name=EXCLUDED.acr_name,
        acr_login_server=EXCLUDED.acr_login_server,
        acr_username=EXCLUDED.acr_username,
        acr_password=EXCLUDED.acr_password,
        container_app_environment=EXCLUDED.container_app_environment,
        container_app_name_prefix=EXCLUDED.container_app_name_prefix,
        platform_version=EXCLUDED.platform_version,
        memory_budget_mb=EXCLUDED.memory_budget_mb,
        git_repo_url=EXCLUDED.git_repo_url,
        git_branch=EXCLUDED.git_branch,
        git_workflow_path=EXCLUDED.git_workflow_path,
        git_token=EXCLUDED.git_token,
        updated_at=now()`,
      [
        id,
        project_id,
        environment_id,
        data.name,
        data.provider,
        data.deployment_mode,
        data.auto_deploy,
        data.azure_subscription_id,
        data.azure_tenant_id,
        data.azure_client_id,
        data.azure_client_secret,
        data.azure_resource_group,
        data.azure_location,
        data.acr_name,
        data.acr_login_server,
        data.acr_username,
        data.acr_password,
        data.container_app_environment,
        data.container_app_name_prefix,
        data.platform_version,
        data.memory_budget_mb,
        data.git_repo_url,
        data.git_branch,
        data.git_workflow_path,
        data.git_token,
      ]
    );
    return (await listDeploymentTargets({ project_id, environment_id }))[0];
  }

  const existingIndex = state.deployment_targets.findIndex((target) => target.project_id === project_id && target.environment_id === environment_id);
  const next = {
    ...(existingIndex >= 0 ? state.deployment_targets[existingIndex] : { id: nanoid(10), created_at: now() }),
    ...data,
    project_id,
    environment_id,
    updated_at: now(),
  };
  if (existingIndex >= 0) state.deployment_targets[existingIndex] = next;
  else state.deployment_targets.push(next);
  await persist();
  return (await listDeploymentTargets({ project_id, environment_id }))[0];
}

export async function propagateDeploymentTarget({
  project_id,
  source_project_id,
  source_environment_id,
  target_environment_ids = [],
  target_destinations = [],
}) {
  const sourceProjectId = source_project_id || project_id;
  if (!sourceProjectId || !source_environment_id) throw new Error("project_id and source_environment_id are required");
  const source = (await listDeploymentTargets({
    project_id: sourceProjectId,
    environment_id: source_environment_id,
    includeSecrets: true,
  }))[0];
  if (!source) throw new Error("No hay target guardado para propagar desde ese ambiente");

  const targetEnvironmentIds = Array.isArray(target_environment_ids) ? target_environment_ids : [];
  const targetDestinations = Array.isArray(target_destinations) ? target_destinations : [];
  const sourceEnvironments = (await listEnvironments({ project_id: sourceProjectId })).rows;
  const defaultToSameProject = targetEnvironmentIds.length === 0 && targetDestinations.length === 0;
  const selectedIds = targetEnvironmentIds.length
    ? targetEnvironmentIds
    : defaultToSameProject
      ? sourceEnvironments.filter((env) => env.id !== source_environment_id).map((env) => env.id)
      : [];
  const destinations = [
    ...selectedIds.map((environment_id) => ({ project_id: sourceProjectId, environment_id })),
    ...targetDestinations.map((destination) => ({
      project_id: destination.project_id || sourceProjectId,
      environment_id: destination.environment_id,
    })),
  ].filter((destination) => destination.project_id && destination.environment_id);

  const uniqueDestinations = [];
  const seen = new Set();
  for (const destination of destinations) {
    if (destination.project_id === sourceProjectId && destination.environment_id === source_environment_id) continue;
    const key = `${destination.project_id}:${destination.environment_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueDestinations.push(destination);
  }

  const copiedFields = {
    provider: source.provider,
    deployment_mode: source.deployment_mode,
    auto_deploy: source.auto_deploy,
    azure_subscription_id: source.azure_subscription_id,
    azure_tenant_id: source.azure_tenant_id,
    azure_client_id: source.azure_client_id,
    azure_client_secret: source.azure_client_secret,
    azure_resource_group: source.azure_resource_group,
    azure_location: source.azure_location,
    acr_name: source.acr_name,
    acr_login_server: source.acr_login_server,
    acr_username: source.acr_username,
    acr_password: source.acr_password,
    git_repo_url: source.git_repo_url,
    git_branch: source.git_branch,
    git_workflow_path: source.git_workflow_path,
    git_token: source.git_token,
    memory_budget_mb: source.memory_budget_mb,
  };

  const saved = [];
  for (const destination of uniqueDestinations) {
    const project = await getProject(destination.project_id);
    if (!project) throw new Error(`Proyecto destino no encontrado: ${destination.project_id}`);
    const env = await getEnvironment(destination.environment_id);
    if (!env || env.project_id !== project.id) {
      throw new Error(`Ambiente destino no encontrado en ${project.name}: ${destination.environment_id}`);
    }
    const defaults = deploymentTargetDefaults(project, env);
    saved.push(await upsertDeploymentTarget({
      ...copiedFields,
      project_id: project.id,
      environment_id: env.id,
      name: defaults.name,
      container_app_name_prefix: defaults.container_app_name_prefix,
      container_app_environment: defaults.container_app_environment,
    }));
  }

  return saved;
}

export async function getDeploymentTargetForFunction(fn, { includeSecrets = true } = {}) {
  if (!fn?.project_id || !fn?.environment_id) return null;
  return (await listDeploymentTargets({
    project_id: fn.project_id,
    environment_id: fn.environment_id,
    includeSecrets,
  }))[0] || null;
}

export async function listFunctions({ project_id, environment_id, environment_slug, tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return [];
  if (storeMode === "postgres") {
    const clauses = [];
    const params = [];
    if (project_id) {
      params.push(project_id);
      clauses.push(`f.project_id=$${params.length}`);
    }
    if (environment_id) {
      params.push(environment_id);
      clauses.push(`f.environment_id=$${params.length}`);
    }
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      clauses.push(`p.tenant_id=$${params.length}`);
    }
    if (environment_slug) {
      params.push(environment_slug);
      clauses.push(`e.slug=$${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(`${FUNCTION_SELECT} ${where} ORDER BY f.updated_at DESC, f.created_at DESC`, params);
    return result.rows.map(enrichFunction);
  }

  return clone(
    state.functions
      .filter((fn) => !project_id || fn.project_id === project_id)
      .filter((fn) => !environment_id || fn.environment_id === environment_id)
      .filter((fn) => {
        if (!resolvedTenantId) return false;
        const project = state.projects.find((p) => p.id === fn.project_id);
        return project?.tenant_id === resolvedTenantId;
      })
      .map(enrichFunction)
      .filter((fn) => !environment_slug || fn.environment_slug === environment_slug)
      .sort((a, b) =>
        String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")) ||
        String(b.created_at || "").localeCompare(String(a.created_at || ""))
      )
  );
}

export async function getFunction(id, { tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return null;
  if (storeMode === "postgres") {
    const params = [id];
    let where = "WHERE f.id=$1";
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      where += ` AND p.tenant_id=$${params.length}`;
    }
    const fn = (await pool.query(`${FUNCTION_SELECT} ${where}`, params)).rows[0];
    if (!fn) return null;
    const secrets = await listSecretsForProject(fn.project_id, { environment_id: fn.environment_id, tenant_id: resolvedTenantId });
    return { ...enrichFunction(fn), secrets };
  }

  const fn = state.functions.find((f) => f.id === id);
  if (!fn) return null;
  if (resolvedTenantId) {
    const project = state.projects.find((p) => p.id === fn.project_id);
    if (!project || project.tenant_id !== resolvedTenantId) return null;
  }
  const secrets = state.secrets
    .filter((s) => s.project_id === fn.project_id && s.environment_id === fn.environment_id)
    .map(enrichSecret)
    .sort((a, b) => a.key.localeCompare(b.key));
  return clone({ ...enrichFunction(fn), secrets });
}

export async function createFunction({
  name,
  description,
  code,
  files,
  entrypoint,
  project_id,
  environment_id,
  tenant_id,
  runtime = "node20",
  memory_mb = 256,
  timeout_seconds = 30,
  auth_required = false,
  auth_header_name = "x-api-key",
  api_tokens = [],
}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  let resolvedEnvironmentId = environment_id || null;
  if (project_id) {
    const project = await getProject(project_id, { tenant_id: resolvedTenantId });
    if (!project) throw new Error("Proyecto destino no encontrado");
    const environments = await ensureProjectEnvironments(project_id);
    if (!resolvedEnvironmentId) {
      resolvedEnvironmentId = environments.find((env) => env.slug === "dev")?.id || environments[0]?.id || null;
    } else {
      const env = await getEnvironment(resolvedEnvironmentId, { tenant_id: resolvedTenantId });
      if (!env || env.project_id !== project_id) {
        throw new Error("El ambiente no pertenece al proyecto indicado");
      }
    }
  }

  const id = nanoid(10);
  const slug = await uniqueFunctionSlug(name || "fn", { project_id, environment_id: resolvedEnvironmentId });
  const created = now();
  const source = normalizeFunctionSource({ name: name || slug, code, files, entrypoint, runtime });
  const fn = {
    id,
    slug,
    name: name || slug,
    description: description || null,
    code: source.code,
    files: source.files,
    entrypoint: source.entrypoint,
    runtime: source.runtime,
    memory_mb: Number(memory_mb) || 256,
    timeout_seconds: Number(timeout_seconds) || 30,
    status: "idle",
    container_id: null,
    url: null,
    active_deploy_version: "v1",
    auth_required: Boolean(auth_required),
    auth_header_name: normalizeAuthHeaderName(auth_header_name),
    api_tokens: normalizeApiTokens(api_tokens),
    project_id: project_id || null,
    environment_id: resolvedEnvironmentId,
    source_function_id: null,
    validation_status: null,
    validation_summary: null,
    created_at: created,
    updated_at: created,
  };

  if (storeMode === "postgres") {
    await pool.query(
      `INSERT INTO functions
       (id,slug,name,description,code,files,entrypoint,runtime,memory_mb,timeout_seconds,status,active_deploy_version,auth_required,auth_header_name,api_tokens,project_id,environment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'idle',$11,$12,$13,$14,$15,$16)`,
      [
        fn.id,
        fn.slug,
        fn.name,
        fn.description,
        fn.code,
        JSON.stringify(fn.files),
        fn.entrypoint,
        fn.runtime,
        fn.memory_mb,
        fn.timeout_seconds,
        fn.active_deploy_version,
        fn.auth_required,
        fn.auth_header_name,
        JSON.stringify(fn.api_tokens),
        fn.project_id,
        fn.environment_id,
      ]
    );
    return getFunction(fn.id);
  }

  state.functions.push(fn);
  await persist();
  return getFunction(fn.id);
}

export async function updateFunction(id, patch, { tenant_id } = {}) {
  const allowed = ["name", "description", "code", "files", "entrypoint", "runtime", "memory_mb", "timeout_seconds", "environment_id", "auth_required", "auth_header_name", "api_tokens"];
  const data = Object.fromEntries(Object.entries(patch || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined));
  if ("code" in data || "files" in data || "entrypoint" in data || "runtime" in data) {
    const current = await getFunction(id, { tenant_id });
    if (!current) return null;
    const source = normalizeFunctionSource({ ...current, ...data });
    data.code = source.code;
    data.files = source.files;
    data.entrypoint = source.entrypoint;
    data.runtime = source.runtime;
  }
  if ("auth_header_name" in data) data.auth_header_name = normalizeAuthHeaderName(data.auth_header_name);
  if ("auth_required" in data) data.auth_required = Boolean(data.auth_required);
  if ("api_tokens" in data) data.api_tokens = normalizeApiTokens(data.api_tokens);

  if (storeMode === "postgres") {
    if (Object.keys(data).length) {
      const sets = [];
      const params = [id];
      for (const [key, value] of Object.entries(data)) {
        params.push(key === "files" || key === "api_tokens" ? JSON.stringify(value) : value);
        sets.push(`${key}=$${params.length}`);
      }
      params.push(now());
      sets.push(`updated_at=$${params.length}`);
      await pool.query(`UPDATE functions SET ${sets.join(", ")} WHERE id=$1`, params);
    }
    return getFunction(id);
  }

  const fn = state.functions.find((f) => f.id === id);
  if (!fn) return null;
  if (resolveTenantId(tenant_id)) {
    const project = state.projects.find((p) => p.id === fn.project_id);
    if (!project || project.tenant_id !== resolveTenantId(tenant_id)) return null;
  }
  Object.assign(fn, data, { updated_at: now() });
  await persist();
  return getFunction(id);
}

export async function createFunctionToken(functionId, { name = "default", value = null } = {}) {
  const fn = await getFunction(functionId);
  if (!fn) return null;
  const tokenValue = String(value || "").trim() || newApiTokenValue();
  const token = {
    id: nanoid(10),
    name: String(name || "default").trim() || "default",
    value: tokenValue,
    created_at: now(),
  };
  token.last4 = token.value.slice(-4);
  const api_tokens = [...normalizeApiTokens(fn.api_tokens), token];
  await updateFunction(functionId, { api_tokens });
  return token;
}

export async function deleteFunctionToken(functionId, tokenId) {
  const fn = await getFunction(functionId);
  if (!fn) return null;
  const api_tokens = normalizeApiTokens(fn.api_tokens).filter((token) => token.id !== tokenId);
  await updateFunction(functionId, { api_tokens });
  return { ok: true };
}

export async function updateFunctionStatus(id, patch) {
  if (storeMode === "postgres") {
    const allowed = ["status", "container_id", "url", "active_deploy_version", "validation_status", "validation_summary"];
    const data = Object.fromEntries(Object.entries(patch || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined));
    if (Object.keys(data).length) {
      const sets = [];
      const params = [id];
      for (const [key, value] of Object.entries(data)) {
        params.push(value);
        sets.push(`${key}=$${params.length}`);
      }
      params.push(now());
      sets.push(`updated_at=$${params.length}`);
      await pool.query(`UPDATE functions SET ${sets.join(", ")} WHERE id=$1`, params);
    }
    return getFunction(id);
  }

  const fn = state.functions.find((f) => f.id === id);
  if (!fn) return null;
  Object.assign(fn, patch, { updated_at: now() });
  await persist();
  return getFunction(id);
}

async function resolveFunctionSnapshotScope(snapshot = {}) {
  let project = snapshot.project_id ? await getProject(snapshot.project_id) : null;
  if (!project && snapshot.project_slug) {
    project = (await listProjects()).find((item) => item.slug === snapshot.project_slug);
  }
  if (!project) throw new Error("Proyecto destino no encontrado para sincronizar la funcion");

  let environment = snapshot.environment_id ? await getEnvironment(snapshot.environment_id) : null;
  if (!environment || environment.project_id !== project.id) {
    const environments = (await listEnvironments({ project_id: project.id })).rows;
    environment = environments.find((item) => item.slug === snapshot.environment_slug);
  }
  if (!environment || environment.project_id !== project.id) {
    throw new Error("Ambiente destino no encontrado para sincronizar la funcion");
  }

  return { project, environment };
}

async function findFunctionSnapshotTarget(snapshot = {}, { project_id, environment_id }) {
  const id = String(snapshot.id || "").trim();
  if (id) {
    const exact = await getFunction(id);
    if (exact) return exact.id;
  }

  const sourceId = String(snapshot.source_function_id || "").trim();
  const slug = slugify(snapshot.slug || snapshot.name || "fn");
  if (!project_id || !environment_id || (!sourceId && !slug)) return null;

  if (storeMode === "postgres") {
    const params = [project_id, environment_id];
    const matches = [];
    if (sourceId) {
      params.push(sourceId);
      matches.push(`source_function_id=$${params.length}`);
    }
    if (slug) {
      params.push(slug);
      matches.push(`slug=$${params.length}`);
    }
    if (!matches.length) return null;
    return (await pool.query(
      `SELECT id FROM functions
       WHERE project_id=$1 AND environment_id=$2 AND (${matches.join(" OR ")})
       LIMIT 1`,
      params
    )).rows[0]?.id || null;
  }

  return state.functions.find((fn) =>
    fn.project_id === project_id &&
    fn.environment_id === environment_id &&
    ((sourceId && fn.source_function_id === sourceId) || fn.slug === slug)
  )?.id || null;
}

async function postgresSafeSourceFunctionId(rawSourceId, existingSourceId = null) {
  const sourceId = String(rawSourceId || "").trim();
  if (!sourceId) return existingSourceId || null;
  if (storeMode !== "postgres") return sourceId;
  if (await getFunction(sourceId)) return sourceId;
  return existingSourceId || null;
}

async function syncMissingProjectSecrets(projectId, environmentId, incomingSecrets = []) {
  if (!projectId || !environmentId || !Array.isArray(incomingSecrets) || !incomingSecrets.length) {
    return { copied: 0, skipped: 0 };
  }

  const current = await listSecretsForProject(projectId, { environment_id: environmentId });
  const currentKeys = new Set(current.map((secret) => secret.key));
  let copied = 0;
  let skipped = 0;

  for (const secret of incomingSecrets) {
    const key = normalizeSecretKey(secret?.key);
    if (!key) continue;
    if (currentKeys.has(key)) {
      skipped += 1;
      continue;
    }
    await createProjectSecret(projectId, {
      environment_id: environmentId,
      key,
      value: secret?.value ?? "",
    });
    currentKeys.add(key);
    copied += 1;
  }

  return { copied, skipped };
}

export async function syncPromotedFunctionSnapshot(snapshot = {}) {
  if (!snapshot?.id) throw new Error("function snapshot required");
  const { project, environment } = await resolveFunctionSnapshotScope(snapshot);
  const existingId = await findFunctionSnapshotTarget(snapshot, {
    project_id: project.id,
    environment_id: environment.id,
  });
  const existing = existingId ? await getFunction(existingId) : null;
  const source = normalizeFunctionSource({
    ...snapshot,
    name: snapshot.name || existing?.name || snapshot.slug || "function",
    code: snapshot.code || existing?.code || "",
    files: snapshot.files ?? existing?.files,
    entrypoint: snapshot.entrypoint ?? existing?.entrypoint,
    runtime: snapshot.runtime || existing?.runtime || "node20",
  });
  const existingTokens = normalizeApiTokens(existing?.api_tokens);
  const incomingTokens = normalizeApiTokens(snapshot.api_tokens);
  const createdAt = existing?.created_at || snapshot.created_at || now();
  const functionId = existing?.id || String(snapshot.id);
  const functionSlug = await uniqueFunctionSlug(snapshot.slug || snapshot.name || "fn", {
    project_id: project.id,
    environment_id: environment.id,
    exclude_id: existing?.id || null,
  });
  const sourceFunctionId = await postgresSafeSourceFunctionId(
    snapshot.source_function_id,
    existing?.source_function_id
  );
  const data = {
    id: functionId,
    slug: functionSlug,
    name: snapshot.name || existing?.name || functionSlug,
    description: snapshot.description ?? existing?.description ?? null,
    code: source.code,
    files: source.files,
    entrypoint: source.entrypoint,
    runtime: source.runtime,
    memory_mb: Number(snapshot.memory_mb || existing?.memory_mb || 256) || 256,
    timeout_seconds: Number(snapshot.timeout_seconds || existing?.timeout_seconds || 30) || 30,
    status: snapshot.status || existing?.status || "idle",
    container_id: snapshot.container_id ?? existing?.container_id ?? null,
    url: snapshot.url ?? existing?.url ?? null,
    active_deploy_version: normalizeDeployVersion(snapshot.active_deploy_version || existing?.active_deploy_version || "v1"),
    auth_required: Boolean(snapshot.auth_required),
    auth_header_name: normalizeAuthHeaderName(snapshot.auth_header_name || existing?.auth_header_name),
    api_tokens: existingTokens.length ? existingTokens : incomingTokens,
    project_id: project.id,
    environment_id: environment.id,
    source_function_id: sourceFunctionId,
    validation_status: snapshot.validation_status ?? existing?.validation_status ?? null,
    validation_summary: snapshot.validation_summary ?? existing?.validation_summary ?? null,
    created_at: createdAt,
    updated_at: now(),
  };

  if (storeMode === "postgres") {
    if (existing) {
      await pool.query(
        `UPDATE functions SET
          slug=$2,
          name=$3,
          description=$4,
          code=$5,
          files=$6,
          entrypoint=$7,
          runtime=$8,
          memory_mb=$9,
          timeout_seconds=$10,
          status=$11,
          container_id=$12,
          url=$13,
          active_deploy_version=$14,
          auth_required=$15,
          auth_header_name=$16,
          api_tokens=$17,
          project_id=$18,
          environment_id=$19,
          source_function_id=$20,
          validation_status=$21,
          validation_summary=$22,
          updated_at=now()
         WHERE id=$1`,
        [
          data.id,
          data.slug,
          data.name,
          data.description,
          data.code,
          JSON.stringify(data.files),
          data.entrypoint,
          data.runtime,
          data.memory_mb,
          data.timeout_seconds,
          data.status,
          data.container_id,
          data.url,
          data.active_deploy_version,
          data.auth_required,
          data.auth_header_name,
          JSON.stringify(data.api_tokens),
          data.project_id,
          data.environment_id,
          data.source_function_id,
          data.validation_status,
          data.validation_summary,
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO functions
         (id,slug,name,description,code,files,entrypoint,runtime,memory_mb,timeout_seconds,status,
          container_id,url,active_deploy_version,auth_required,auth_header_name,api_tokens,
          project_id,environment_id,source_function_id,validation_status,validation_summary,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [
          data.id,
          data.slug,
          data.name,
          data.description,
          data.code,
          JSON.stringify(data.files),
          data.entrypoint,
          data.runtime,
          data.memory_mb,
          data.timeout_seconds,
          data.status,
          data.container_id,
          data.url,
          data.active_deploy_version,
          data.auth_required,
          data.auth_header_name,
          JSON.stringify(data.api_tokens),
          data.project_id,
          data.environment_id,
          data.source_function_id,
          data.validation_status,
          data.validation_summary,
          data.created_at,
          data.updated_at,
        ]
      );
    }
  } else {
    const existingIndex = state.functions.findIndex((fn) => fn.id === data.id);
    if (existingIndex >= 0) {
      state.functions[existingIndex] = { ...state.functions[existingIndex], ...data };
    } else {
      state.functions.push(data);
    }
    await persist();
  }

  const secretSync = await syncMissingProjectSecrets(project.id, environment.id, snapshot.secrets);
  const synced = await getFunction(data.id);
  return { ...synced, sync: { secrets: secretSync } };
}

export async function deleteFunction(id) {
  const fn = await getFunction(id);
  if (!fn) return null;
  if (storeMode === "postgres") {
    await pool.query("DELETE FROM functions WHERE id=$1", [id]);
    return { ok: true };
  }
  state.functions = state.functions.filter((fn) => fn.id !== id);
  state.logs = state.logs.filter((log) => log.function_id !== id);
  state.deployments = state.deployments.filter((deployment) => deployment.function_id !== id);
  await persist();
  return { ok: true };
}

function normalizeSecretKey(key) {
  return String(key || "").trim().toUpperCase();
}

async function resolveProjectEnvironment(projectId, { environment_id, environment_slug } = {}) {
  if (!projectId) throw new Error("project_id required");
  let env = null;
  if (environment_id) {
    env = await getEnvironment(environment_id);
  } else if (environment_slug) {
    env = (await listEnvironments({ project_id: projectId })).rows.find((item) => item.slug === environment_slug);
  }
  if (!env) throw new Error("environment_id required");
  if (env.project_id !== projectId) throw new Error("El ambiente no pertenece al proyecto indicado");
  return env;
}

function enrichSecret(secret) {
  const env = state.environments.find((item) => item.id === secret.environment_id);
  return {
    ...secret,
    environment_name: env?.name || null,
    environment_slug: env?.slug || null,
  };
}

export async function upsertSecret(functionId, { key, value }) {
  const fn = await getFunction(functionId);
  if (!fn) return null;
  if (!fn.project_id || !fn.environment_id) {
    throw new Error("La funcion debe pertenecer a un proyecto y ambiente para crear secrets");
  }
  return createProjectSecret(fn.project_id, { environment_id: fn.environment_id, key, value });
}

export async function listSecretsForProject(projectId, { environment_id, environment_slug } = {}) {
  if (!projectId) return [];
  const project = await getProject(projectId);
  if (!project) return [];
  if (storeMode === "postgres") {
    const params = [projectId];
    const clauses = ["s.project_id=$1"];
    if (environment_id) {
      params.push(environment_id);
      clauses.push(`s.environment_id=$${params.length}`);
    }
    if (environment_slug) {
      params.push(environment_slug);
      clauses.push(`e.slug=$${params.length}`);
    }
    return (await pool.query(
      `SELECT s.id,s.key,s.value,s.project_id,s.environment_id,s.created_at,s.updated_at,
              e.name AS environment_name,
              e.slug AS environment_slug
       FROM secrets s
       LEFT JOIN environments e ON e.id=s.environment_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY s.updated_at DESC, CASE e.slug WHEN 'dev' THEN 1 WHEN 'test' THEN 2 WHEN 'prod' THEN 3 ELSE 9 END, s.key`,
      params
    )).rows;
  }

  return clone(
    state.secrets
      .filter((secret) => secret.project_id === projectId)
      .filter((secret) => !environment_id || secret.environment_id === environment_id)
      .map(enrichSecret)
      .filter((secret) => !environment_slug || secret.environment_slug === environment_slug)
      .sort((a, b) =>
        String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")) ||
        String(a.environment_slug || "").localeCompare(String(b.environment_slug || "")) ||
        a.key.localeCompare(b.key)
      )
  );
}

export async function createProjectSecret(projectId, { environment_id, environment_slug, key, value }) {
  const project = await getProject(projectId);
  if (!project) return null;
  const env = await resolveProjectEnvironment(projectId, { environment_id, environment_slug });
  const secretKey = normalizeSecretKey(key);
  if (!secretKey) throw new Error("key required");

  if (storeMode === "postgres") {
    const existing = (
      await pool.query(
        "SELECT id FROM secrets WHERE project_id=$1 AND environment_id=$2 AND key=$3 LIMIT 1",
        [projectId, env.id, secretKey]
      )
    ).rows[0];
    if (existing) throw new Error(`El secret ${secretKey} ya existe en este ambiente`);
    return (await pool.query(
      `INSERT INTO secrets (id,function_id,project_id,environment_id,key,value)
       VALUES ($1,NULL,$2,$3,$4,$5)
       RETURNING id,key,value,project_id,environment_id,created_at,updated_at`,
      [nanoid(10), projectId, env.id, secretKey, value ?? ""]
    )).rows[0];
  }

  const existing = state.secrets.find((secret) =>
    secret.project_id === projectId &&
    secret.environment_id === env.id &&
    secret.key === secretKey
  );
  if (existing) throw new Error(`El secret ${secretKey} ya existe en este ambiente`);
  const secret = {
    id: nanoid(10),
    function_id: null,
    project_id: projectId,
    environment_id: env.id,
    key: secretKey,
    value: value ?? "",
    created_at: now(),
    updated_at: now(),
  };
  state.secrets.push(secret);
  await persist();
  return clone(enrichSecret(secret));
}

export async function updateSecret(id, { key, value }) {
  const secretKey = key === undefined ? null : normalizeSecretKey(key);
  if (key !== undefined && !secretKey) throw new Error("key required");

  if (storeMode === "postgres") {
    const existing = (await pool.query("SELECT * FROM secrets WHERE id=$1", [id])).rows[0];
    if (!existing) return null;
    const project = await getProject(existing.project_id);
    if (!project) return null;
    const nextKey = secretKey || existing.key;
    const duplicate = (
      await pool.query(
        `SELECT id FROM secrets
         WHERE project_id=$1 AND environment_id=$2 AND key=$3 AND id<>$4
         LIMIT 1`,
        [existing.project_id, existing.environment_id, nextKey, id]
      )
    ).rows[0];
    if (duplicate) throw new Error(`El secret ${nextKey} ya existe en este ambiente`);
    return (await pool.query(
      `UPDATE secrets
       SET key=$2, value=$3, updated_at=now()
       WHERE id=$1
       RETURNING id,key,value,project_id,environment_id,created_at,updated_at`,
      [id, nextKey, value === undefined ? existing.value : value ?? ""]
    )).rows[0];
  }

  const existing = state.secrets.find((secret) => secret.id === id);
  if (!existing) return null;
  const project = state.projects.find((p) => p.id === existing.project_id);
  if (!project) return null;
  const nextKey = secretKey || existing.key;
  const duplicate = state.secrets.find((secret) =>
    secret.id !== id &&
    secret.project_id === existing.project_id &&
    secret.environment_id === existing.environment_id &&
    secret.key === nextKey
  );
  if (duplicate) throw new Error(`El secret ${nextKey} ya existe en este ambiente`);
  Object.assign(existing, {
    key: nextKey,
    value: value === undefined ? existing.value : value ?? "",
    updated_at: now(),
  });
  await persist();
  return clone(enrichSecret(existing));
}

export async function copyProjectSecretsBetweenEnvironments(projectId, {
  source_environment_id,
  source_environment_slug = "dev",
  target_environment_id,
  target_environment_slug = "test",
} = {}) {
  const sourceEnv = await resolveProjectEnvironment(projectId, {
    environment_id: source_environment_id,
    environment_slug: source_environment_slug,
  });
  const targetEnv = await resolveProjectEnvironment(projectId, {
    environment_id: target_environment_id,
    environment_slug: target_environment_slug,
  });
  if (sourceEnv.id === targetEnv.id) throw new Error("Origen y destino deben ser ambientes distintos");

  const sourceSecrets = await listSecretsForProject(projectId, { environment_id: sourceEnv.id });
  const targetSecrets = await listSecretsForProject(projectId, { environment_id: targetEnv.id });
  const targetKeys = new Set(targetSecrets.map((secret) => secret.key));
  let copied = 0;
  let skipped = 0;
  for (const secret of sourceSecrets) {
    if (targetKeys.has(secret.key)) {
      skipped += 1;
      continue;
    }
    await createProjectSecret(projectId, {
      environment_id: targetEnv.id,
      key: secret.key,
      value: secret.value,
    });
    targetKeys.add(secret.key);
    copied += 1;
  }

  return {
    ok: true,
    source_environment_id: sourceEnv.id,
    source_environment_slug: sourceEnv.slug,
    target_environment_id: targetEnv.id,
    target_environment_slug: targetEnv.slug,
    copied,
    skipped,
  };
}

export async function deleteSecret(id) {
  if (storeMode === "postgres") {
    const existing = (await pool.query("SELECT project_id FROM secrets WHERE id=$1", [id])).rows[0];
    if (!existing || !(await getProject(existing.project_id))) return null;
    await pool.query("DELETE FROM secrets WHERE id=$1", [id]);
    return;
  }
  const existing = state.secrets.find((secret) => secret.id === id);
  if (!existing) return;
  const project = state.projects.find((p) => p.id === existing.project_id);
  if (!project) return null;
  state.secrets = state.secrets.filter((secret) => secret.id !== id);
  await persist();
}

export async function getSecretsForFunction(functionId) {
  const tenantId = resolveTenantId();
  if (!tenantId) return [];
  if (storeMode === "postgres") {
    const fn = (await pool.query(
      `SELECT f.project_id,f.environment_id
       FROM functions f
       JOIN projects p ON p.id=f.project_id
       WHERE f.id=$1 AND p.tenant_id=$2`,
      [functionId, tenantId]
    )).rows[0];
    if (!fn?.project_id || !fn?.environment_id) return [];
    return (await pool.query(
      "SELECT key,value FROM secrets WHERE project_id=$1 AND environment_id=$2 ORDER BY key",
      [fn.project_id, fn.environment_id]
    )).rows;
  }
  const fn = state.functions.find((item) => item.id === functionId);
  if (!fn || !projectVisible(state.projects.find((project) => project.id === fn.project_id))) return [];
  if (!fn?.project_id || !fn?.environment_id) return [];
  return clone(
    state.secrets
      .filter((secret) => secret.project_id === fn.project_id && secret.environment_id === fn.environment_id)
      .map(({ key, value }) => ({ key, value }))
  );
}

export async function appendLog({ function_id, environment_id = null, deployment_id = null, message }) {
  if (!message) return;

  if (storeMode === "postgres") {
    await pool.query(
      "INSERT INTO logs (id,function_id,environment_id,deployment_id,message) VALUES ($1,$2,$3,$4,$5)",
      [nanoid(10), function_id, environment_id, deployment_id, message]
    );
    return;
  }

  state.logs.push({
    id: nanoid(10),
    function_id,
    environment_id,
    deployment_id,
    message,
    ts: now(),
  });
  state.logs = state.logs.slice(-3000);
  await persist();
}

export async function listLogHistory(functionId, limit = 500) {
  const fn = await getFunction(functionId);
  if (!fn) return [];
  if (storeMode === "postgres") {
    const rows = (
      await pool.query("SELECT message, ts FROM logs WHERE function_id=$1 ORDER BY ts DESC LIMIT $2", [functionId, limit])
    ).rows;
    return rows.reverse();
  }

  return clone(
    state.logs
      .filter((log) => log.function_id === functionId)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
      .slice(-limit)
      .map(({ message, ts }) => ({ message, ts }))
  );
}

async function getLatestSuccessfulDeployment(functionId) {
  if (!functionId) return null;
  if (storeMode === "postgres") {
    return (
      await pool.query(
        `SELECT *
         FROM deployments
         WHERE function_id=$1 AND status='success'
         ORDER BY COALESCE(finished_at, updated_at, created_at) DESC, created_at DESC
         LIMIT 1`,
        [functionId]
      )
    ).rows[0] || null;
  }

  return clone(
    state.deployments
      .filter((deployment) => deployment.function_id === functionId && deployment.status === "success")
      .slice()
      .sort((a, b) =>
        String(b.finished_at || b.updated_at || b.created_at || "").localeCompare(String(a.finished_at || a.updated_at || a.created_at || ""))
      )[0] || null
  );
}

export async function createDeployment(fn, {
  status = "validating",
  validation_status = null,
  validation_summary = null,
  version = null,
  snapshot = null,
  change_summary = null,
  change_details = null,
  source_deployment_id = null,
  note = null,
} = {}) {
  const existing = storeMode === "postgres"
    ? (await pool.query("SELECT COUNT(*)::int AS count FROM deployments WHERE function_id=$1", [fn.id])).rows[0].count
    : state.deployments.filter((deployment) => deployment.function_id === fn.id).length;
  const deploymentVersion = version ? normalizeDeployVersion(version) : `v${existing + 1}`;
  const deploymentSnapshot = snapshot || buildDeploymentSnapshot(fn);
  const previousDeployment = await getLatestSuccessfulDeployment(fn.id);
  const changeReport = change_details || change_summary
    ? {
      summary: change_summary || note || "Sin cambios relevantes",
      details: normalizeDeploymentChangeDetails(change_details || []),
    }
    : buildDeploymentChangeDetails(previousDeployment?.snapshot || null, deploymentSnapshot, note || "");
  const deployment = {
    id: nanoid(10),
    function_id: fn.id,
    project_id: fn.project_id || null,
    environment_id: fn.environment_id || null,
    version: deploymentVersion,
    status,
    active: false,
    url: null,
    validation_status,
    validation_summary,
    error: null,
    deprecated_at: null,
    deprecated_reason: null,
    snapshot: deploymentSnapshot,
    change_summary: changeReport.summary,
    change_details: changeReport.details,
    source_deployment_id: source_deployment_id || null,
    created_at: now(),
    updated_at: now(),
    finished_at: null,
  };

  if (storeMode === "postgres") {
    await pool.query(
      `INSERT INTO deployments
       (id,function_id,project_id,environment_id,version,status,validation_status,validation_summary,snapshot,change_summary,change_details,source_deployment_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        deployment.id,
        deployment.function_id,
        deployment.project_id,
        deployment.environment_id,
        deployment.version,
        deployment.status,
        deployment.validation_status,
        deployment.validation_summary,
        JSON.stringify(deployment.snapshot),
        deployment.change_summary,
        JSON.stringify(deployment.change_details),
        deployment.source_deployment_id,
        deployment.created_at,
        deployment.updated_at,
      ]
    );
    return deployment;
  }

  state.deployments.push(deployment);
  await persist();
  return clone(deployment);
}

async function activateDeployment(id) {
  if (storeMode === "postgres") {
    const deployment = (await pool.query("SELECT id,function_id FROM deployments WHERE id=$1", [id])).rows[0];
    if (!deployment) return;
    await pool.query(
      `UPDATE deployments
       SET active=false,
           deprecated_at=COALESCE(deprecated_at, now()),
           deprecated_reason=COALESCE(deprecated_reason, $3),
           updated_at=now()
       WHERE function_id=$1
         AND id<>$2
         AND status='success'`,
      [deployment.function_id, id, "Version reemplazada por un deployment mas reciente"]
    );
    await pool.query(
      "UPDATE deployments SET active=true, deprecated_at=NULL, deprecated_reason=NULL, updated_at=now() WHERE id=$1",
      [id]
    );
    return;
  }

  const deployment = state.deployments.find((item) => item.id === id);
  if (!deployment) return;
  for (const item of state.deployments) {
    if (item.function_id !== deployment.function_id || item.id === id || item.status !== "success") continue;
    item.active = false;
    item.deprecated_at ||= now();
    item.deprecated_reason ||= "Version reemplazada por un deployment mas reciente";
    item.updated_at = now();
  }
  deployment.active = true;
  deployment.deprecated_at = null;
  deployment.deprecated_reason = null;
  deployment.updated_at = now();
}

export async function finishDeployment(id, patch) {
  const finishedStatus = patch?.status;
  if (storeMode === "postgres") {
    const allowed = ["status", "url", "validation_status", "validation_summary", "error", "finished_at", "updated_at"];
    const data = Object.fromEntries(Object.entries(patch || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined));
    if (!data.finished_at) data.finished_at = now();
    data.updated_at = now();
    const sets = [];
    const params = [id];
    for (const [key, value] of Object.entries(data)) {
      params.push(value);
      sets.push(`${key}=$${params.length}`);
    }
    await pool.query(`UPDATE deployments SET ${sets.join(", ")} WHERE id=$1`, params);
    if (finishedStatus === "success") await activateDeployment(id);
    return;
  }

  const deployment = state.deployments.find((d) => d.id === id);
  if (deployment) Object.assign(deployment, { finished_at: now(), updated_at: now() }, patch);
  if (finishedStatus === "success") await activateDeployment(id);
  await persist();
}

export async function getLatestSuccessfulPlatformDeployment(targetId) {
  if (!targetId) return null;
  if (storeMode === "postgres") {
    return (
      await pool.query(
        `SELECT *
         FROM platform_deployments
         WHERE target_id=$1 AND status='success'
         ORDER BY COALESCE(finished_at, updated_at, created_at) DESC, created_at DESC
         LIMIT 1`,
        [targetId]
      )
    ).rows[0] || null;
  }

  return clone(
    state.platform_deployments
      .filter((deployment) => deployment.target_id === targetId && deployment.status === "success")
      .slice()
      .sort((a, b) =>
        String(b.finished_at || b.updated_at || b.created_at || "").localeCompare(String(a.finished_at || a.updated_at || a.created_at || "")))
      [0] || null
  );
}

async function activatePlatformDeployment(id) {
  if (storeMode === "postgres") {
    const deployment = (await pool.query("SELECT id,target_id FROM platform_deployments WHERE id=$1", [id])).rows[0];
    if (!deployment) return;
    await pool.query(
      `UPDATE platform_deployments
       SET active=false,
           updated_at=now()
       WHERE target_id=$1
         AND id<>$2
         AND status='success'`,
      [deployment.target_id, id]
    );
    await pool.query(
      "UPDATE platform_deployments SET active=true, updated_at=now() WHERE id=$1",
      [id]
    );
    return;
  }

  const deployment = state.platform_deployments.find((item) => item.id === id);
  if (!deployment) return;
  for (const item of state.platform_deployments) {
    if (item.target_id !== deployment.target_id || item.id === id || item.status !== "success") continue;
    item.active = false;
    item.updated_at = now();
  }
  deployment.active = true;
  deployment.updated_at = now();
}

export async function createPlatformDeployment(target, {
  status = "running",
  version = null,
  snapshot = null,
  change_summary = null,
  change_details = null,
  source_platform_deployment_id = null,
  note = null,
} = {}) {
  if (!target?.id) throw new Error("target required");
  const deploymentVersion = normalizeDeployVersion(version || target.platform_version || "1.0.0");
  const deploymentSnapshot = snapshot || buildPlatformDeploymentSnapshot(target, { version: deploymentVersion });
  const previousDeployment = await getLatestSuccessfulPlatformDeployment(target.id);
  const changeReport = change_details || change_summary
    ? {
      summary: change_summary || note || platformDeploymentVersionSummary(target, deploymentVersion),
      details: normalizePlatformDeploymentChangeDetails(change_details || []),
    }
    : buildPlatformDeploymentChangeDetails(previousDeployment?.snapshot || null, deploymentSnapshot, note || platformDeploymentVersionSummary(target, deploymentVersion));

  const deployment = {
    id: nanoid(10),
    target_id: target.id,
    project_id: target.project_id || null,
    environment_id: target.environment_id || null,
    version: deploymentVersion,
    status,
    active: false,
    snapshot: deploymentSnapshot,
    change_summary: changeReport.summary,
    change_details: changeReport.details,
    source_platform_deployment_id: source_platform_deployment_id || null,
    error: null,
    created_at: now(),
    updated_at: now(),
    finished_at: null,
  };

  if (storeMode === "postgres") {
    await pool.query(
      `INSERT INTO platform_deployments
       (id,target_id,project_id,environment_id,version,status,active,snapshot,change_summary,change_details,source_platform_deployment_id,error,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        deployment.id,
        deployment.target_id,
        deployment.project_id,
        deployment.environment_id,
        deployment.version,
        deployment.status,
        deployment.active,
        JSON.stringify(deployment.snapshot),
        deployment.change_summary,
        JSON.stringify(deployment.change_details),
        deployment.source_platform_deployment_id,
        deployment.error,
        deployment.created_at,
        deployment.updated_at,
      ]
    );
    return deployment;
  }

  state.platform_deployments.push(deployment);
  await persist();
  return clone(deployment);
}

export async function finishPlatformDeployment(id, patch = {}) {
  const finishedStatus = patch?.status;
  if (storeMode === "postgres") {
    const allowed = ["status", "snapshot", "change_summary", "change_details", "error", "finished_at", "updated_at"];
    const data = Object.fromEntries(Object.entries(patch || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined));
    if (!data.finished_at) data.finished_at = now();
    data.updated_at = now();
    const sets = [];
    const params = [id];
    for (const [key, value] of Object.entries(data)) {
      params.push(key === "snapshot" || key === "change_details" ? JSON.stringify(value || (key === "snapshot" ? {} : [])) : value);
      sets.push(`${key}=$${params.length}`);
    }
    await pool.query(`UPDATE platform_deployments SET ${sets.join(", ")} WHERE id=$1`, params);
    if (finishedStatus === "success") await activatePlatformDeployment(id);
    return;
  }

  const deployment = state.platform_deployments.find((item) => item.id === id);
  if (deployment) Object.assign(deployment, { finished_at: now(), updated_at: now() }, patch);
  if (finishedStatus === "success") await activatePlatformDeployment(id);
  await persist();
}

export async function listPlatformDeployments({ target_id, project_id, environment_id, environment_slug, tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return [];
  if (storeMode === "postgres") {
    const clauses = [];
    const params = [];
    if (target_id) {
      params.push(target_id);
      clauses.push(`d.target_id=$${params.length}`);
    }
    if (project_id) {
      params.push(project_id);
      clauses.push(`d.project_id=$${params.length}`);
    }
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      clauses.push(`p.tenant_id=$${params.length}`);
    }
    if (environment_id) {
      params.push(environment_id);
      clauses.push(`d.environment_id=$${params.length}`);
    }
    if (environment_slug) {
      params.push(environment_slug);
      clauses.push(`e.slug=$${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      await pool.query(
        `SELECT d.*,
                t.name AS target_name,
                p.name AS project_name,
                e.name AS environment_name,
                e.slug AS environment_slug
         FROM platform_deployments d
         JOIN deployment_targets t ON t.id=d.target_id
         LEFT JOIN projects p ON p.id=d.project_id
         LEFT JOIN environments e ON e.id=d.environment_id
         ${where}
         ORDER BY d.updated_at DESC, d.created_at DESC`,
        params
      )
    ).rows;
  }

  return clone(
    state.platform_deployments
      .filter((deployment) => !target_id || deployment.target_id === target_id)
      .filter((deployment) => !project_id || deployment.project_id === project_id)
      .filter((deployment) => {
        if (!resolvedTenantId) return false;
        const project = state.projects.find((p) => p.id === deployment.project_id);
        return project?.tenant_id === resolvedTenantId;
      })
      .filter((deployment) => !environment_id || deployment.environment_id === environment_id)
      .map((deployment) => {
        const target = state.deployment_targets.find((item) => item.id === deployment.target_id);
        const project = state.projects.find((p) => p.id === deployment.project_id);
        const environment = state.environments.find((e) => e.id === deployment.environment_id);
        return {
          ...deployment,
          target_name: target?.name || null,
          project_name: project?.name || null,
          environment_name: environment?.name || null,
          environment_slug: environment?.slug || null,
        };
      })
      .filter((deployment) => !environment_slug || deployment.environment_slug === environment_slug)
      .sort((a, b) =>
        String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")) ||
        String(b.created_at || "").localeCompare(String(a.created_at || ""))
      )
  );
}

export async function listDeployments({ project_id, environment_id, environment_slug, function_id, tenant_id } = {}) {
  const resolvedTenantId = resolveTenantId(tenant_id);
  if (!resolvedTenantId) return [];
  if (storeMode === "postgres") {
    const clauses = [];
    const params = [];
    if (project_id) {
      params.push(project_id);
      clauses.push(`d.project_id=$${params.length}`);
    }
    if (resolvedTenantId) {
      params.push(resolvedTenantId);
      clauses.push(`p.tenant_id=$${params.length}`);
    }
    if (environment_id) {
      params.push(environment_id);
      clauses.push(`d.environment_id=$${params.length}`);
    }
    if (environment_slug) {
      params.push(environment_slug);
      clauses.push(`e.slug=$${params.length}`);
    }
    if (function_id) {
      params.push(function_id);
      clauses.push(`d.function_id=$${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      await pool.query(
        `SELECT d.*,
                f.name AS function_name,
                f.slug AS function_slug,
                p.name AS project_name,
                e.name AS environment_name,
                e.slug AS environment_slug
         FROM deployments d
         JOIN functions f ON f.id=d.function_id
         LEFT JOIN projects p ON p.id=d.project_id
         LEFT JOIN environments e ON e.id=d.environment_id
         ${where}
         ORDER BY d.updated_at DESC, d.created_at DESC`,
        params
      )
    ).rows;
  }

  return clone(
    state.deployments
      .filter((d) => !project_id || d.project_id === project_id)
      .filter((d) => {
        if (!resolvedTenantId) return false;
        const project = state.projects.find((p) => p.id === d.project_id);
        return project?.tenant_id === resolvedTenantId;
      })
      .filter((d) => !environment_id || d.environment_id === environment_id)
      .filter((d) => !function_id || d.function_id === function_id)
      .map((deployment) => {
        const fn = state.functions.find((f) => f.id === deployment.function_id);
        const project = state.projects.find((p) => p.id === deployment.project_id);
        const environment = state.environments.find((e) => e.id === deployment.environment_id);
        return {
          ...deployment,
          function_name: fn?.name || null,
          function_slug: fn?.slug || null,
          project_name: project?.name || null,
          environment_name: environment?.name || null,
          environment_slug: environment?.slug || null,
        };
      })
      .filter((deployment) => !environment_slug || deployment.environment_slug === environment_slug)
      .sort((a, b) =>
        String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")) ||
        String(b.created_at || "").localeCompare(String(a.created_at || ""))
      )
  );
}

export async function listTemplates() {
  if (storeMode === "postgres") {
    return (await pool.query("SELECT * FROM templates ORDER BY name")).rows;
  }
  return clone(state.templates.sort((a, b) => a.name.localeCompare(b.name)));
}

export async function promoteFunction(sourceId, { target_environment_id, target_environment_slug }) {
  const source = await getFunction(sourceId);
  if (!source) return null;
  if (!source.project_id) throw new Error("La funcion debe pertenecer a un proyecto para promoverse");

  const environments = (await listEnvironments({ project_id: source.project_id })).rows;
  const targetEnv = target_environment_id
    ? environments.find((env) => env.id === target_environment_id)
    : environments.find((env) => env.slug === target_environment_slug);

  if (!targetEnv) throw new Error("Entorno destino no encontrado");
  if (targetEnv.id === source.environment_id) throw new Error("La funcion ya esta en ese entorno");

  const promotedSlugBase = source.slug.replace(/-(test|prod)$/i, "");
  const sourceRootId = source.source_function_id || source.id;
  const existingPromoted = storeMode === "postgres"
    ? (await pool.query(
      `SELECT id
       FROM functions
       WHERE project_id=$1
         AND environment_id=$2
         AND (
           source_function_id=$3
           OR source_function_id=$4
           OR id=$4
           OR slug=$5
         )
       LIMIT 1`,
      [source.project_id, targetEnv.id, source.id, sourceRootId, promotedSlugBase]
    )).rows[0]
    : state.functions.find((fn) =>
      fn.project_id === source.project_id &&
      fn.environment_id === targetEnv.id &&
      (
        fn.source_function_id === source.id ||
        fn.source_function_id === sourceRootId ||
        fn.id === sourceRootId ||
        fn.slug === promotedSlugBase
      )
    );

  if (existingPromoted) {
    const existingTarget = await getFunction(existingPromoted.id);
    const targetTokens = promotedEnvironmentTokens(source, existingTarget, targetEnv);
    const targetSlug = await uniqueFunctionSlug(promotedSlugBase || source.name || "fn", {
      project_id: source.project_id,
      environment_id: targetEnv.id,
      exclude_id: existingPromoted.id,
    });
    if (storeMode === "postgres") {
      await pool.query(
        `UPDATE functions SET
          slug=$2,
          name=$3,
          description=$4,
          code=$5,
          files=$6,
          entrypoint=$7,
          runtime=$8,
          memory_mb=$9,
          timeout_seconds=$10,
          status='idle',
          active_deploy_version=$11,
          auth_required=$12,
          auth_header_name=$13,
          api_tokens=$14,
          validation_status=$15,
          validation_summary=$16,
          container_id=NULL,
          url=NULL,
          updated_at=now()
         WHERE id=$1`,
        [
          existingPromoted.id,
          targetSlug,
          source.name,
          source.description,
          source.code,
          JSON.stringify(source.files),
          source.entrypoint,
          source.runtime,
          source.memory_mb,
          source.timeout_seconds,
          normalizeDeployVersion(source.active_deploy_version || "v1"),
          Boolean(source.auth_required),
          normalizeAuthHeaderName(source.auth_header_name),
          JSON.stringify(targetTokens),
          source.validation_status,
          source.validation_summary,
        ]
      );
      await copyProjectSecretsBetweenEnvironments(source.project_id, {
        source_environment_id: source.environment_id,
        target_environment_id: targetEnv.id,
      });
      return getFunction(existingPromoted.id);
    }

    Object.assign(existingPromoted, {
      slug: targetSlug,
      name: source.name,
      description: source.description,
      code: source.code,
      files: source.files,
      entrypoint: source.entrypoint,
      runtime: source.runtime,
      memory_mb: source.memory_mb,
      timeout_seconds: source.timeout_seconds,
      status: "idle",
      container_id: null,
      url: null,
      active_deploy_version: normalizeDeployVersion(source.active_deploy_version || "v1"),
      auth_required: Boolean(source.auth_required),
      auth_header_name: normalizeAuthHeaderName(source.auth_header_name),
      api_tokens: targetTokens,
      validation_status: source.validation_status,
      validation_summary: source.validation_summary,
      updated_at: now(),
    });
    await persist();
    await copyProjectSecretsBetweenEnvironments(source.project_id, {
      source_environment_id: source.environment_id,
      target_environment_id: targetEnv.id,
    });
    return getFunction(existingPromoted.id);
  }

  const name = source.name;
  const targetSlug = await uniqueFunctionSlug(promotedSlugBase || name || "fn", {
    project_id: source.project_id,
    environment_id: targetEnv.id,
  });
  const created = now();
  const target = {
    id: nanoid(10),
    slug: targetSlug,
    name,
    description: source.description,
    code: source.code,
    files: source.files,
    entrypoint: source.entrypoint,
    runtime: source.runtime,
    memory_mb: source.memory_mb,
    timeout_seconds: source.timeout_seconds,
    status: "idle",
    container_id: null,
    url: null,
    active_deploy_version: normalizeDeployVersion(source.active_deploy_version || "v1"),
    auth_required: Boolean(source.auth_required),
    auth_header_name: normalizeAuthHeaderName(source.auth_header_name),
    api_tokens: promotedEnvironmentTokens(source, null, targetEnv),
    project_id: source.project_id,
    environment_id: targetEnv.id,
    source_function_id: source.id,
    validation_status: source.validation_status,
    validation_summary: source.validation_summary,
    created_at: created,
    updated_at: created,
  };

  if (storeMode === "postgres") {
    await pool.query(
      `INSERT INTO functions
       (id,slug,name,description,code,files,entrypoint,runtime,memory_mb,timeout_seconds,status,active_deploy_version,auth_required,auth_header_name,api_tokens,project_id,environment_id,source_function_id,validation_status,validation_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'idle',$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        target.id,
        target.slug,
        target.name,
        target.description,
        target.code,
        JSON.stringify(target.files),
        target.entrypoint,
        target.runtime,
        target.memory_mb,
        target.timeout_seconds,
        target.active_deploy_version,
        target.auth_required,
        target.auth_header_name,
        JSON.stringify(target.api_tokens),
        target.project_id,
        target.environment_id,
        target.source_function_id,
        target.validation_status,
        target.validation_summary,
      ]
    );

    await copyProjectSecretsBetweenEnvironments(source.project_id, {
      source_environment_id: source.environment_id,
      target_environment_id: targetEnv.id,
    });
    return getFunction(target.id);
  }

  state.functions.push(target);
  await persist();
  await copyProjectSecretsBetweenEnvironments(source.project_id, {
    source_environment_id: source.environment_id,
    target_environment_id: targetEnv.id,
  });
  return getFunction(target.id);
}

export async function promoteProject(projectId, { source_environment_slug = "dev", target_environment_slug = "test" } = {}) {
  const project = await getProject(projectId);
  if (!project) return null;
  const environments = (await listEnvironments({ project_id: projectId })).rows;
  const sourceEnv = environments.find((env) => env.slug === source_environment_slug);
  const targetEnv = environments.find((env) => env.slug === target_environment_slug);
  if (!sourceEnv || !targetEnv) throw new Error("Entorno origen o destino no encontrado");

  const sourceFunctions = await listFunctions({ project_id: projectId, environment_id: sourceEnv.id });
  const promoted = [];
  for (const fn of sourceFunctions) {
    promoted.push(await promoteFunction(fn.id, { target_environment_id: targetEnv.id }));
  }
  return {
    project,
    source_environment: sourceEnv,
    target_environment: targetEnv,
    promoted,
    count: promoted.length,
  };
}

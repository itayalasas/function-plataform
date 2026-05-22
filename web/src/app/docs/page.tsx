import { Topbar } from "@/components/Topbar";
import {
  BookOpen,
  BrainCircuit,
  Boxes,
  Cloud,
  Code2,
  FileText,
  FolderKanban,
  History,
  KeyRound,
  Rocket,
  Server,
  ShieldCheck,
} from "lucide-react";

const sections = [
  { id: "vision", label: "Vision", icon: BookOpen },
  { id: "proyectos", label: "Proyectos y entornos", icon: FolderKanban },
  { id: "funciones", label: "Funciones y codigo", icon: Boxes },
  { id: "secrets", label: "Secrets", icon: KeyRound },
  { id: "tokens", label: "Tokens API", icon: ShieldCheck },
  { id: "validacion", label: "Validacion IA", icon: BrainCircuit },
  { id: "deploy", label: "Deploy y versiones", icon: Rocket },
  { id: "container-apps", label: "Container Apps", icon: Cloud },
  { id: "logs", label: "Logs e historial", icon: FileText },
];

const runtimeRows = [
  ["Auto", "Detecta el runtime por codigo y archivos."],
  ["Node 20", "Usa export default async function handler(req)."],
  ["Deno", "Prefiere export default async function handler(req). Deno.serve(...) requiere auth manual si activas token."],
  ["Python 3.11", "Usa def handler(request) en index.py."],
  ["Java Spring Boot", "Proyecto Maven con @SpringBootApplication y controllers @RestController."],
  [".NET 8 C#", "ASP.NET Core Minimal API o controllers compilados con dotnet publish."],
  ["Custom Dockerfile", "Para Go u otros lenguajes. Debe escuchar en puerto 8080 y validar auth dentro del contenedor."],
];

const envExamples = [
  ["Node", "const value = process.env.GREETING;"],
  ["Deno", "const value = Deno.env.get(\"GREETING\");"],
  ["Python", "value = os.getenv(\"GREETING\")"],
  ["Java", "String value = System.getenv(\"GREETING\");"],
  ["C#", "var value = Environment.GetEnvironmentVariable(\"GREETING\");"],
];

const authRows = [
  ["Node 20", `const apiKey = req.headers.get("x-api-key");`],
  ["Deno", `const apiKey = req.headers.get("x-api-key");`],
  ["Python", `api_key = request["headers"].get("x-api-key")`],
  ["Java", `@RequestHeader("x-api-key") String apiKey`],
  ["C#", `var apiKey = Request.Headers["x-api-key"].FirstOrDefault();`],
];

function SectionTitle({ id, icon: Icon, title, subtitle }: { id: string; icon: any; title: string; subtitle: string }) {
  return (
    <div id={id} className="scroll-mt-8">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-violet-500/15 text-violet-300 grid place-items-center shrink-0">
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-slate-400 mt-1">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="rounded-lg border border-[var(--border)] bg-black/50 p-3 overflow-auto text-xs text-slate-200">
      <code>{children}</code>
    </pre>
  );
}

export default function DocsPage() {
  return (
    <div>
      <Topbar title="Documentacion" subtitle="Guia practica de la plataforma y de los flujos implementados" />

      <div className="grid grid-cols-1 xl:grid-cols-[280px_1fr] gap-5">
        <aside className="card xl:sticky xl:top-7 h-fit">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-3">Indice</div>
          <div className="space-y-1">
            {sections.map((section) => {
              const Icon = section.icon;
              return (
                <a key={section.id} href={`#${section.id}`} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5 hover:text-white">
                  <Icon className="w-4 h-4 text-slate-500" />
                  {section.label}
                </a>
              );
            })}
          </div>
        </aside>

        <div className="space-y-5">
          <section className="card space-y-4">
            <SectionTitle id="vision" icon={BookOpen} title="Vision general" subtitle="La plataforma organiza APIs serverless por proyecto, ambiente, version y destino de deploy." />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded-lg border border-[var(--border)] bg-black/20 p-4">
                <div className="font-semibold text-sm">Proyecto</div>
                <p className="text-xs text-slate-400 mt-2">Agrupa funciones, secrets, entornos y targets de deploy.</p>
              </div>
              <div className="rounded-lg border border-[var(--border)] bg-black/20 p-4">
                <div className="font-semibold text-sm">Ambiente</div>
                <p className="text-xs text-slate-400 mt-2">Cada proyecto crea dev, test y prod para promover APIs entre estados.</p>
              </div>
              <div className="rounded-lg border border-[var(--border)] bg-black/20 p-4">
                <div className="font-semibold text-sm">Funcion/API</div>
                <p className="text-xs text-slate-400 mt-2">El codigo se valida, versiona y despliega como contenedor local, Azure Container App o workflow Git.</p>
              </div>
            </div>
          </section>

          <section className="card space-y-4">
            <SectionTitle id="proyectos" icon={FolderKanban} title="Proyectos y entornos" subtitle="Usa proyectos para separar productos, clientes o dominios de negocio." />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-300">
              <div>
                <h3 className="font-semibold text-white mb-2">Flujo recomendado</h3>
                <ol className="list-decimal list-inside space-y-1 text-slate-400">
                  <li>Crea un proyecto desde Proyectos.</li>
                  <li>Trabaja funciones en dev.</li>
                  <li>Promueve a test para QA.</li>
                  <li>Promueve a prod cuando este aprobada.</li>
                </ol>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-2">Asociaciones</h3>
                <p className="text-slate-400">Funciones, secrets, deployments y targets quedan asociados al proyecto y al ambiente. Esto permite filtrar, auditar y desplegar por contexto.</p>
              </div>
            </div>
          </section>

          <section className="card space-y-4">
            <SectionTitle id="funciones" icon={Code2} title="Funciones y codigo" subtitle="Cada funcion puede tener un archivo principal y archivos internos auxiliares." />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Estructura logica</h3>
                <CodeBlock>{`v1/send-email/index.mjs
v1/send-email/_shared/mailer.mjs
v2/send-email/index.mjs`}</CodeBlock>
                <p className="text-sm text-slate-400">La ruta publica queda como /version/nombre-funcion. Si despliegas v1 otra vez, se sobrescribe v1. Si despliegas v2, v1 queda disponible.</p>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Runtimes soportados</h3>
                <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                  {runtimeRows.map(([name, desc]) => (
                    <div key={name} className="grid grid-cols-[140px_1fr] gap-3 border-b border-[var(--border)] last:border-b-0 px-3 py-2 text-sm">
                      <span className="font-mono text-violet-300">{name}</span>
                      <span className="text-slate-400">{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="card space-y-4">
            <SectionTitle id="secrets" icon={KeyRound} title="Secrets" subtitle="Son variables de entorno de proyecto inyectadas al deploy y validadas antes de publicar." />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <h3 className="font-semibold text-sm mb-3">Como leerlos desde codigo</h3>
                <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                  {envExamples.map(([runtime, example]) => (
                    <div key={runtime} className="grid grid-cols-[90px_1fr] gap-3 border-b border-[var(--border)] last:border-b-0 px-3 py-2 text-sm">
                      <span className="text-slate-400">{runtime}</span>
                      <span className="font-mono text-xs text-slate-200">{example}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Validacion</h3>
                <p className="text-sm text-slate-400">Si el codigo usa GREETING, DATABASE_URL o cualquier variable detectada, la validacion exige que exista en Secrets del proyecto. No se permite repetir la misma KEY dentro de un proyecto.</p>
                <CodeBlock>{`const greeting = process.env.GREETING;
const db = process.env.DATABASE_URL;`}</CodeBlock>
              </div>
            </div>
          </section>

          <section className="card space-y-4">
            <SectionTitle id="tokens" icon={ShieldCheck} title="Tokens API" subtitle="Protegen endpoints publicados y tambien pueden ser leidos por la funcion." />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Uso automatico de plataforma</h3>
                <p className="text-sm text-slate-400">Activa Requerir token en Configuracion de la funcion. El consumidor debe enviar el token generado en el header configurado, por defecto x-api-key. Node, Deno con export default, Python, Java Spring y .NET responden 401 antes de ejecutar tu codigo si falta o no coincide.</p>
                <CodeBlock>{`GET /v1/send-email
x-api-key: fpm_xxxxx

curl -X GET "https://host/v1/send-email" \\
  -H "Accept: application/json" \\
  -H "x-api-key: fpm_xxxxx"`}</CodeBlock>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Variables disponibles</h3>
                <p className="text-sm text-slate-400">El primer token se inyecta como FPM_API_KEY y API_KEY. Todos los tokens se inyectan como FPM_AUTH_TOKENS y FPM_API_KEYS en JSON, y como FPM_API_KEYS_CSV/API_KEYS_CSV en CSV. FPM_AUTH_HEADER contiene el nombre del header configurado.</p>
                <CodeBlock>{`FPM_AUTH_HEADER=x-api-key
FPM_AUTH_TOKENS=["fpm_xxxxx"]
FPM_API_KEY=fpm_xxxxx
FPM_API_KEYS=["fpm_xxxxx"]
FPM_API_KEYS_CSV=fpm_xxxxx`}</CodeBlock>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Leer el header por lenguaje</h3>
                <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                  {authRows.map(([runtime, example]) => (
                    <div key={runtime} className="grid grid-cols-[90px_1fr] gap-3 border-b border-[var(--border)] last:border-b-0 px-3 py-2 text-sm">
                      <span className="text-slate-400">{runtime}</span>
                      <span className="font-mono text-xs text-slate-200">{example}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold text-sm">Cuando debes validar manualmente</h3>
                <p className="text-sm text-slate-400">Deno.serve(...) directo y Custom Dockerfile no pasan por el wrapper de auth administrado. En esos casos valida el header dentro de tu codigo contra FPM_API_KEY o FPM_AUTH_TOKENS.</p>
                <CodeBlock>{`function parseTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function validateApiKey(req: Request): Response | null {
  const headerName = Deno.env.get("FPM_AUTH_HEADER") || "x-api-key";
  const apiKey = req.headers.get(headerName);
  const allowed = [
    Deno.env.get("FPM_API_KEY"),
    Deno.env.get("API_KEY"),
    ...parseTokens(Deno.env.get("FPM_AUTH_TOKENS")),
    ...parseTokens(Deno.env.get("FPM_API_KEYS")),
    ...parseTokens(Deno.env.get("FPM_API_KEYS_CSV")),
  ].filter((value): value is string => !!value);

  return apiKey && allowed.includes(apiKey)
    ? null
    : Response.json({ error: "Unauthorized" }, { status: 401 });
}`}</CodeBlock>
              </div>
            </div>
          </section>

          <section className="card space-y-4">
            <SectionTitle id="validacion" icon={BrainCircuit} title="Validacion IA" subtitle="Antes de deployar se ejecuta validacion estatica y, si esta configurada, revision con OpenAI." />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-400">
              <div>
                <h3 className="font-semibold text-white mb-2">Que valida</h3>
                <ul className="list-disc list-inside space-y-1">
                  <li>Sintaxis y runtime compatible.</li>
                  <li>Archivo principal correcto.</li>
                  <li>Secrets usados por codigo.</li>
                  <li>Tokens requeridos cuando auth esta activa.</li>
                  <li>Hallazgos de IA si OPENAI_API_KEY esta configurada.</li>
                </ul>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-2">OpenAI</h3>
                <p>Configura OPENAI_API_KEY en el .env del backend. Si no existe, la validacion estatica sigue corriendo y la IA queda omitida.</p>
                <p className="mt-3">Cuando hay errores criticos, Validar y Deploy piden a la IA una autocorreccion del codigo. Si la respuesta es segura, se actualizan los archivos de la funcion, se revalida el resultado y cada cambio queda escrito en Logs.</p>
              </div>
            </div>
          </section>

          <section className="card space-y-4">
            <SectionTitle id="deploy" icon={Rocket} title="Deploy y versiones" subtitle="El deploy siempre valida primero y despues publica la version seleccionada." />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded-lg border border-[var(--border)] bg-black/20 p-4">
                <History className="w-5 h-5 text-violet-300 mb-3" />
                <div className="font-semibold text-sm">Version</div>
                <p className="text-xs text-slate-400 mt-2">Selecciona v1, v2 o escribe otra. Reusar la misma version sobrescribe esa version.</p>
              </div>
              <div className="rounded-lg border border-[var(--border)] bg-black/20 p-4">
                <Server className="w-5 h-5 text-cyan-300 mb-3" />
                <div className="font-semibold text-sm">Memoria</div>
                <p className="text-xs text-slate-400 mt-2">Memoria MB limita el contenedor de esa funcion/API.</p>
              </div>
              <div className="rounded-lg border border-[var(--border)] bg-black/20 p-4">
                <Rocket className="w-5 h-5 text-emerald-300 mb-3" />
                <div className="font-semibold text-sm">Timeout</div>
                <p className="text-xs text-slate-400 mt-2">Timeout segundos devuelve 504 si la funcion tarda mas.</p>
              </div>
            </div>
          </section>

          <section className="card space-y-4">
            <SectionTitle id="container-apps" icon={Cloud} title="Container Apps" subtitle="Define el destino por ambiente: local/manual, Azure automatico o Git workflow." />
            <div className="space-y-3 text-sm text-slate-400">
              <p>En Azure automatico se usa Subscription, Tenant, Service Principal, Resource Group, ACR, region y Container Apps Environment. El prefijo y environment pueden generarse como proyecto-ambiente.</p>
              <p>El presupuesto de memoria del ambiente no crea memoria compartida real; sirve como regla de validacion para que la suma de memoria asignada a funciones no exceda el limite definido.</p>
              <p>En Git workflow se dispara workflow_dispatch si el repositorio es GitHub y hay token configurado.</p>
            </div>
          </section>

          <section className="card space-y-4">
            <SectionTitle id="logs" icon={FileText} title="Logs e historial" subtitle="Los errores de validacion, deploy y runtime quedan consultables." />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-400">
              <div>
                <h3 className="font-semibold text-white mb-2">Logs</h3>
                <p>Muestran validaciones, errores de deploy y salida del contenedor con fecha.</p>
              </div>
              <div>
                <h3 className="font-semibold text-white mb-2">Deployments</h3>
                <p>Registran version, estado, URL, validacion, errores y fecha de cada intento de publicacion.</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

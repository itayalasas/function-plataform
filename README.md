# Function Platform MVP

Plataforma local para crear proyectos, organizar funciones/APIs por entornos, gestionar secrets, validar codigo antes del deploy y desplegar runtimes administrados o contenedores Docker.

## Stack

- **Web**: Next.js 14 + TailwindCSS
- **API**: Fastify + Node.js 20
- **Datos**: PostgreSQL opcional o almacenamiento local en archivo
- **Runtime**: cada funcion se construye y corre como contenedor Docker. Soporta Node 20, Deno, Python 3.11, Java Spring Boot, .NET 8 y Custom Dockerfile.
- **Validacion**: reglas estaticas siempre activas y revision IA opcional con `OPENAI_API_KEY`

## Arranque con Docker

```bash
cp .env.example .env
docker compose up --build
```

- UI: http://localhost:3000
- API: http://localhost:4000

Por defecto Docker Compose usa almacenamiento local en `./data/function-platform.json`. Si detienes o reconstruyes los contenedores, los proyectos, funciones, secrets, targets y deployments siguen ahi. Evita borrar la carpeta `data` si quieres conservar la configuracion.

Para proteger codigo, archivos de funciones, tokens y secrets cuando usas `DATA_STORE=file`, configura una clave estable:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Guarda el resultado como `DATA_ENCRYPTION_KEY` en `.env`. Si el archivo ya existia en JSON plano, el primer arranque con esa clave lo migra a cifrado automaticamente.

## Arranque local sin Docker Compose

API:

```bash
cd api
npm install
$env:DATA_STORE="file"
$env:PORT="4000"
npm start
```

Web:

```bash
cd web
npm install
$env:NEXT_PUBLIC_API_URL="http://localhost:4000"
npm run dev
```

## Flujo principal

1. Crear un proyecto en **Proyectos**.
2. La plataforma genera entornos `dev`, `test` y `prod`.
3. Crear funciones asociadas al proyecto y entorno. El runtime puede quedar en auto: Deno/TypeScript usa `index.ts`, Node usa `index.mjs`, Python usa `index.py`, Java Spring usa Maven y .NET usa `dotnet publish`.
4. Agregar secrets desde el detalle de la funcion.
5. En **Codigo**, agregar archivos auxiliares dentro del directorio logico de la funcion, por ejemplo `_shared/pdf-renderer.ts`.
6. Ejecutar **Validar** o **Deploy**.
7. El deploy valida sintaxis/runtime y, si hay `OPENAI_API_KEY`, suma revision IA.
8. Promover funciones desde **Entornos** de `dev` a `test` y de `test` a `prod`.
9. Configurar **Container Apps** por ambiente para que el deploy use Azure o dispare un workflow Git.

## Tokens API

En la configuracion de cada funcion puedes activar **Requerir token** y generar uno o mas tokens. El consumidor debe enviarlo en el header configurado, por defecto:

```http
x-api-key: fpm_xxxxx
```

Node, Deno con `export default`, Python, Java Spring Boot y .NET validan ese header en el wrapper/gateway de la plataforma antes de ejecutar el codigo. En `Deno.serve(...)` directo y `Custom Dockerfile`, el codigo debe validar el header manualmente contra `FPM_API_KEY` o `FPM_AUTH_TOKENS`.

Variables de token disponibles dentro del contenedor:

- `FPM_AUTH_HEADER`: nombre del header configurado.
- `FPM_AUTH_TOKENS`: todos los tokens como JSON array.
- `FPM_API_KEY`: primer token generado.
- `FPM_API_KEYS`: todos los tokens como JSON array.
- `FPM_API_KEYS_CSV`: todos los tokens separados por coma.
- `API_KEY`, `API_KEYS` y `API_KEYS_CSV`: alias cuando no existen secrets del proyecto con esos nombres.

## CORS

Las APIs administradas por la plataforma responden `OPTIONS` de preflight y agregan headers CORS en todas las respuestas del wrapper/gateway, incluyendo errores de autenticacion y errores 5xx. Esto evita que un front externo falle antes del `POST` cuando envia `Content-Type: application/json`, `x-api-key` o `Authorization`.

Por defecto se permite cualquier origen:

- `Access-Control-Allow-Origin: *`
- Metodos: `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`
- Headers: `authorization, content-type, x-api-key`

Variables opcionales para ajustar la politica desde el entorno donde corre el API de plataforma; se propagan a los contenedores desplegados y al gateway de Azure:

- `FPM_CORS_ENABLED=false`: desactiva CORS automatico.
- `FPM_CORS_ORIGINS=https://app.example.com,https://admin.example.com`: limita origenes permitidos.
- `FPM_CORS_METHODS=GET,POST,OPTIONS`: cambia metodos permitidos.
- `FPM_CORS_HEADERS=authorization,content-type,x-api-key`: cambia headers permitidos por defecto.
- `FPM_CORS_MAX_AGE=86400`: cache del preflight en segundos.
- `FPM_CORS_ALLOW_CREDENTIALS=true`: habilita credenciales; en ese caso se refleja el origen recibido en lugar de usar `*`.

En `Custom Dockerfile` local el contenedor propio debe implementar CORS si no pasa por el gateway de la plataforma.

## Deploy a Azure Container Apps

La pantalla **Container Apps** guarda un target por proyecto y ambiente. Cada target puede quedar en:

- `Manual/local`: el deploy usa Docker local.
- `Azure automatico`: el API se autentica contra Azure Resource Manager, construye la imagen con Docker, la sube a ACR y crea/actualiza la Container App.
- `Git workflow`: el API guarda la configuracion del repositorio y, si hay token, dispara `workflow_dispatch`.

Para el modo Azure automatico, el runtime donde corre el API debe tener disponibles:

- Docker CLI con acceso al daemon.
- Service principal con permisos para Azure Container Apps y ACR.
- Acceso de red a Azure Resource Manager y Azure Container Registry.
- Si la plataforma usa `DATA_STORE=file`, una `DATA_ENCRYPTION_KEY` estable configurada como secreto del API.

El presupuesto del ambiente (`memory_budget_mb`) queda como umbral operativo para visualizar uso, no bloquea el deploy. En Azure Consumption, la plataforma reparte automaticamente las APIs en extensiones del Container App cuando el limite real de CPU/memoria de Azure lo exige, manteniendo el Container App base como gateway estable.

Campos principales por ambiente:

- Subscription, tenant, service principal client id/secret.
- Resource group, location, ACR name/login server.
- Container Apps Environment.
- Prefijo para nombrar las Container Apps generadas.

Comandos utiles para obtener esos valores:

```bash
az login
az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights
az account show --query id -o tsv
az account show --query tenantId -o tsv
az group create -n rg-fpm-dev -l eastus
az acr create -g rg-fpm-dev -n <acr-unico> --sku Basic
az acr show -g rg-fpm-dev -n <acr-unico> --query loginServer -o tsv
az containerapp env create -g rg-fpm-dev -n aca-env-dev -l eastus
az ad sp create-for-rbac -n sp-fpm-dev --role Contributor --scopes /subscriptions/<subscription-id>/resourceGroups/rg-fpm-dev
az role assignment create --assignee <client-id> --role AcrPush --scope $(az acr show -g rg-fpm-dev -n <acr-unico> --query id -o tsv)
az containerapp show -g rg-fpm-dev -n <container-app-name> --query properties.configuration.ingress.fqdn -o tsv
```

El resultado de `az ad sp create-for-rbac` entrega `appId` (Client ID), `password` (Client Secret) y `tenant` (Tenant ID). Para `test` y `prod` puedes repetir el mismo patron con otros resource groups, ACR o Container Apps Environment segun el aislamiento que quieras.

Desde **Entornos** puedes promover todo el proyecto `dev -> test` o `test -> prod`. Si marcas "Deploy automatico despues de promover", cada funcion promovida se despliega usando el target configurado del ambiente destino.

## Variables utiles

- `DATA_STORE=file`: fuerza almacenamiento local.
- `DATA_FILE`: ruta del archivo JSON local. En Docker Compose es `/data/function-platform.json`.
- `DATA_ENCRYPTION_KEY`: cifra todo el archivo local at-rest con AES-256-GCM. Debe ser estable entre reinicios y despliegues.
- `DATA_ENCRYPTION_REQUIRED=true`: impide iniciar en modo file si falta `DATA_ENCRYPTION_KEY`.
- `DATABASE_URL`: conexion PostgreSQL opcional si quieres persistir fuera de archivos.
- `OPENAI_API_KEY`: activa revision IA antes del deploy.
- `OPENAI_MODEL`: modelo usado para la revision IA.
- `PUBLIC_HOST`: host publico usado para URLs de funciones desplegadas.

## Estructura

```text
api/      Fastify, capa de datos, Docker runtime y validacion
web/      Next.js UI
```

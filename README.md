# Function Platform MVP

Plataforma para crear funciones Node.js, gestionar secrets, desplegarlas como contenedores Docker y ver su URL pública + logs.

## Stack

- **Web (UI)**: Next.js 14 (App Router) + TailwindCSS
- **API**: Fastify (Node 20) + PostgreSQL
- **DB**: Neon PostgreSQL usando `DATABASE_URL`
- **Runtime**: cada función se construye y corre como contenedor Docker independiente con puerto público asignado automáticamente

## Requisitos

- Docker + Docker Compose
- El socket Docker (`/var/run/docker.sock`) debe estar accesible
- Una conexión PostgreSQL de Neon

## Arrancar local

1. Crea tu archivo `.env` desde el ejemplo:

```bash
cp .env.example .env
```

2. Pega tu conexión Neon en `DATABASE_URL`. Si tu URL trae `sslmode=require`, puedes dejarla: la API la normaliza a `verify-full`.

3. Levanta la plataforma:

```bash
docker compose up --build
```

- UI:  http://localhost:3000
- API: http://localhost:4000

> Ya no se usa Traefik ni Postgres local, así se evita el error `Failed to retrieve information of the docker client` y el conflicto de puertos `8080/5432`.

## Flujo

1. Abre http://localhost:3000
2. **Nueva Función** → nombre + código
3. Añade **Secrets** si los necesitas
4. **Deploy** → la API construye una imagen Docker y arranca el contenedor
5. Copia la URL pública generada, por ejemplo `http://localhost:32770`

## Estructura

```
api/      Fastify + Docker SDK + PostgreSQL
web/      Next.js UI
```

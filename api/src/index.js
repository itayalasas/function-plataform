import Fastify from "fastify";
import cors from "@fastify/cors";
import { nanoid } from "nanoid";
import { initDb, q } from "./db.js";
import { buildAndDeploy, stopAndRemove, streamLogs } from "./docker.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "fn";

app.get("/api/functions", async () => {
  const r = await q("SELECT * FROM functions ORDER BY created_at DESC");
  return r.rows;
});

app.get("/api/functions/:id", async (req, reply) => {
  const { id } = req.params;
  const fn = (await q("SELECT * FROM functions WHERE id=$1", [id])).rows[0];
  if (!fn) return reply.code(404).send({ error: "not found" });
  const secrets = (await q("SELECT id,key,value FROM secrets WHERE function_id=$1 ORDER BY key", [id])).rows;
  return { ...fn, secrets };
});

const DEFAULT_CODE = `export default async function handler(req) {
  const name = new URL(req.url).searchParams.get("name") ?? "world";
  return new Response(JSON.stringify({ hello: name, env: process.env.GREETING ?? null }), {
    headers: { "content-type": "application/json" }
  });
}
`;

app.post("/api/functions", async (req) => {
  const { name, code } = req.body ?? {};
  const id = nanoid(10);
  let slug = slugify(name || "fn");
  // ensure unique slug
  const exists = await q("SELECT 1 FROM functions WHERE slug=$1", [slug]);
  if (exists.rowCount) slug = `${slug}-${nanoid(4).toLowerCase()}`;
  await q(
    "INSERT INTO functions (id, slug, name, code, status) VALUES ($1,$2,$3,$4,'idle')",
    [id, slug, name || slug, code || DEFAULT_CODE]
  );
  return (await q("SELECT * FROM functions WHERE id=$1", [id])).rows[0];
});

app.put("/api/functions/:id", async (req) => {
  const { id } = req.params;
  const { name, code } = req.body ?? {};
  await q(
    "UPDATE functions SET name=COALESCE($2,name), code=COALESCE($3,code), updated_at=now() WHERE id=$1",
    [id, name, code]
  );
  return (await q("SELECT * FROM functions WHERE id=$1", [id])).rows[0];
});

app.delete("/api/functions/:id", async (req) => {
  const { id } = req.params;
  try { await stopAndRemove(id); } catch {}
  await q("DELETE FROM functions WHERE id=$1", [id]);
  return { ok: true };
});

// Secrets
app.post("/api/functions/:id/secrets", async (req) => {
  const { id } = req.params;
  const { key, value } = req.body ?? {};
  if (!key) return { error: "key required" };
  const sid = nanoid(10);
  await q(
    `INSERT INTO secrets (id, function_id, key, value) VALUES ($1,$2,$3,$4)
     ON CONFLICT (function_id, key) DO UPDATE SET value=EXCLUDED.value`,
    [sid, id, key, value ?? ""]
  );
  return { ok: true };
});

app.delete("/api/secrets/:sid", async (req) => {
  await q("DELETE FROM secrets WHERE id=$1", [req.params.sid]);
  return { ok: true };
});

// Deploy
app.post("/api/functions/:id/deploy", async (req, reply) => {
  const { id } = req.params;
  const fn = (await q("SELECT * FROM functions WHERE id=$1", [id])).rows[0];
  if (!fn) return reply.code(404).send({ error: "not found" });
  const secrets = (await q("SELECT key,value FROM secrets WHERE function_id=$1", [id])).rows;
  await q("UPDATE functions SET status='deploying' WHERE id=$1", [id]);
  try {
    const { containerId, url } = await buildAndDeploy(fn, secrets);
    await q("UPDATE functions SET status='running', container_id=$1, url=$2 WHERE id=$3", [containerId, url, id]);
    return { ok: true, url };
  } catch (e) {
    app.log.error(e);
    await q("UPDATE functions SET status='error' WHERE id=$1", [id]);
    return reply.code(500).send({ error: String(e?.message || e) });
  }
});

app.post("/api/functions/:id/stop", async (req) => {
  const { id } = req.params;
  await stopAndRemove(id);
  await q("UPDATE functions SET status='stopped', container_id=NULL WHERE id=$1", [id]);
  return { ok: true };
});

// Logs (SSE)
app.get("/api/functions/:id/logs", async (req, reply) => {
  const { id } = req.params;
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders?.();
  const stop = await streamLogs(id, (line) => {
    reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
  });
  req.raw.on("close", () => stop?.());
});

app.get("/health", async () => ({ ok: true }));

await initDb();
app.log.info("Database schema ready");
await app.listen({ port: 4000, host: "0.0.0.0" });

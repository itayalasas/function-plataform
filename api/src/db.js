import pg from "pg";

const { Pool } = pg;

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS functions (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  container_id TEXT,
  url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  function_id TEXT NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (function_id, key)
);
`;

function normalizeConnectionString(raw) {
  if (!raw) {
    throw new Error("DATABASE_URL is required. Copy .env.example to .env and paste your Neon PostgreSQL connection string.");
  }

  const url = new URL(raw);
  const sslMode = url.searchParams.get("sslmode");
  if (["prefer", "require", "verify-ca"].includes(sslMode || "")) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

export const pool = new Pool({ connectionString: normalizeConnectionString(process.env.DATABASE_URL) });

export async function initDb() {
  await pool.query(INIT_SQL);
}

export const q = (text, params) => pool.query(text, params);

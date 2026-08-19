// Postgres storage backend — used automatically when DATABASE_URL is set
// (see db.js). Works with any standard Postgres connection string: Neon,
// Supabase, Render Postgres, a self-hosted instance, etc.
//
// Deliberately simple: the entire app state (settings, profiles, jobs,
// uploaded CV bytes, generated document bytes — everything) lives as one
// JSONB blob in a single row. This is NOT how you'd design a multi-user
// product's schema (see README's "If you're going to sell this" section),
// but for a single-user deployment it means zero migrations to write and,
// critically, nothing depends on the host's local disk — every field survives
// restarts and redeploys, which local-file storage on most free hosts can't
// guarantee.

const { Pool } = require("pg");
const { defaultData } = require("./defaultData");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INT PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  ensured = true;
}

async function read() {
  await ensureTable();
  const { rows } = await pool.query("SELECT data FROM app_state WHERE id = 1");
  if (!rows.length) {
    const initial = defaultData();
    await pool.query("INSERT INTO app_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING", [initial]);
    return initial;
  }
  return rows[0].data;
}

async function write(data) {
  await ensureTable();
  await pool.query(
    "INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()",
    [data]
  );
  return data;
}

async function update(fn) {
  const data = await read();
  const result = (await fn(data)) || data;
  await write(result);
  return result;
}

module.exports = { read, write, update, pool };

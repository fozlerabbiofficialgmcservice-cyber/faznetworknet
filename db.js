const { Pool } = require("pg");

let pool;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("Database configuration error: DATABASE_URL is not configured.");
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
  pool.on("error", (error) => console.error("[Database] Unexpected idle client error:", error.message));
  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction };

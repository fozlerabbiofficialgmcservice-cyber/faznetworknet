const { Pool } = require("pg");

let pool;
let warnedMissingDatabaseUrl = false;

function isConfigured() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

function warnMissingDatabaseUrl() {
  if (!warnedMissingDatabaseUrl) {
    warnedMissingDatabaseUrl = true;
    console.warn("[DB WARNING] DATABASE_URL missing. Database operations will return empty sets instead of throwing fatal errors.");
  }
}

function getPool() {
  if (pool) return pool;
  if (!isConfigured()) {
    warnMissingDatabaseUrl();
    return null;
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
  const activePool = getPool();
  if (!activePool) return { rows: [], rowCount: 0, command: "NO_DATABASE" };
  return activePool.query(text, params);
}

async function withTransaction(callback) {
  const activePool = getPool();
  if (!activePool) {
    return callback({
      query: async () => ({ rows: [], rowCount: 0, command: "NO_DATABASE" })
    });
  }
  const client = await activePool.connect();
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

module.exports = { getPool, query, withTransaction, isConfigured };
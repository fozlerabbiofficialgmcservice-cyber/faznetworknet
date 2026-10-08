const { Pool } = require("pg");

const DEFAULT_DATABASE_URL = "postgresql://faznetwork_db_user:yzIAqmOwHF7iTgmgILod5BYc1PE5Qs3A@dpg-db3arnajnfac7398sp0g-a/faznetwork_db";
let pool;
let dbConnected = false;
let warnedDatabaseFailure = false;

function getDatabaseUrl() { return String(process.env.DATABASE_URL || DEFAULT_DATABASE_URL).trim(); }
function isConfigured() { return Boolean(getDatabaseUrl()); }

function getPool() {
  if (pool) return pool;
  pool = new Pool({
    connectionString: getDatabaseUrl(),
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000
  });
  pool.on("error", error => {
    dbConnected = false;
    console.error("[Database] Unexpected idle client error:", error.message);
  });
  return pool;
}

async function testConnection() {
  try {
    const client = await getPool().connect();
    try { await client.query("SELECT 1"); }
    finally { client.release(); }
    dbConnected = true;
    warnedDatabaseFailure = false;
    console.log("[Database] PostgreSQL connection established.");
    return true;
  } catch (error) {
    dbConnected = false;
    if (!warnedDatabaseFailure) {
      warnedDatabaseFailure = true;
      console.error("[Database] PostgreSQL connection failed:", error.message);
    }
    return false;
  }
}

function getStatus() {
  return { connected: dbConnected, configured: isConfigured(), source: process.env.DATABASE_URL ? "environment" : "fallback" };
}

async function query(text, params = []) {
  try {
    const result = await getPool().query(text, params);
    dbConnected = true;
    return result;
  } catch (error) {
    dbConnected = false;
    throw error;
  }
}

async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    dbConnected = true;
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    dbConnected = false;
    throw error;
  } finally { client.release(); }
}

module.exports = { getPool, query, withTransaction, isConfigured, getDatabaseUrl, testConnection, getStatus };

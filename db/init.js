const fs = require("fs");
const path = require("path");
const db = require("../db");

async function initializeDatabase() {
  const connected = await db.testConnection();
  if (!connected) {
    console.warn("[Database] Schema initialization skipped because PostgreSQL is unavailable.");
    return { skipped: true, connected: false };
  }
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(schema);
  console.log("[Database] Schema initialized.");
  return { skipped: false, connected: true };
}
module.exports = { initializeDatabase };

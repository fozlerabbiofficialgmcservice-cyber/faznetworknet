const fs = require("fs");
const path = require("path");
const db = require("../db");

async function initializeDatabase() {
  if (!db.isConfigured()) {
    console.warn("[Database] Skipping schema initialization because DATABASE_URL is not configured.");
    return { skipped: true };
  }
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(schema);
  console.log("[Database] Schema initialized.");
  return { skipped: false };
}

module.exports = { initializeDatabase };
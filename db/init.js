const fs = require("fs");
const path = require("path");
const db = require("./index");

async function initializeDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(schema);
  console.log("[Database] Schema initialized.");
}

module.exports = { initializeDatabase };

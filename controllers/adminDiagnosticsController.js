const db = require("../db");
const mikrotikService = require("../services/mikrotikService");

// Read-only diagnostics: SELECT 1 and RouterOS print commands only.
async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function mikrotikTest(req, res) {
  let dbStatus = "unhealthy";
  let router = null;
  let routerError = null;
  try {
    await withTimeout(db.query("SELECT 1"), 1500, "Database health check timed out");
    dbStatus = "healthy";
  } catch (error) {
    routerError = "Database check failed: " + String(error?.message || "unavailable");
  }
  try {
    router = await withTimeout(mikrotikService.testConnection(), 3000, "MikroTik diagnostic timed out after 3 seconds");
  } catch (error) {
    routerError = String(error?.message || "MikroTik connection failed");
  }
  const routerStatus = router ? "connected" : "unavailable";
  const success = dbStatus === "healthy" && routerStatus === "connected";
  return res.status(success ? 200 : 503).set("Cache-Control", "no-store").json({
    success,
    router: routerStatus,
    routerStatus,
    board: router?.boardName || router?.model || null,
    version: router?.version || null,
    uptime: router?.uptime || null,
    db: dbStatus,
    ...(routerError ? { error: routerError } : {})
  });
}

module.exports = { mikrotikTest };

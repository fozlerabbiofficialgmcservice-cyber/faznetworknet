const db = require("../db");
const mikrotikService = require("../services/mikrotikService");

// Read-only diagnostics: SELECT 1 and RouterOS print commands only.
async function mikrotikTest(req, res) {
  let dbStatus = "unhealthy";
  let router = null;
  let routerError = null;
  try {
    await Promise.race([
      db.query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Database health check timed out")), 1500))
    ]);
    dbStatus = "healthy";
  } catch (error) {
    routerError = "Database check failed: " + String(error?.message || "unavailable");
  }
  try {
    router = await Promise.race([
      mikrotikService.testConnection(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("MikroTik diagnostic timed out after 3 seconds")), 3000))
    ]);
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

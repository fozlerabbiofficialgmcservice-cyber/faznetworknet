const db = require("../db");
const mikrotikService = require("../services/mikrotikService");

// Read-only diagnostics: SELECT 1 and RouterOS print commands only.
async function mikrotikTest(req, res) {
  let dbStatus = "unhealthy";
  let router = null;
  let routerError = null;
  try {
    await db.query("SELECT 1");
    dbStatus = "healthy";
  } catch (error) {
    routerError = "Database check failed: " + String(error?.message || "unavailable");
  }
  if (dbStatus === "healthy") {
    try {
      router = await mikrotikService.testConnection();
    } catch (error) {
      routerError = String(error?.message || "MikroTik connection failed");
    }
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

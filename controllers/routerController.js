const mikrotikService = require("../services/mikrotikService");

const sendError = (res, error) => {
  const message = error && error.message ? error.message : "Unknown MikroTik service error";
  console.error("[Router API]", message);
  res.status(503).json({
    success: false,
    error: message
  });
};

exports.test = async (req, res) => {
  try {
    const result = await mikrotikService.testConnection();
    res.json({ success: true, routerName: result.routerName, version: result.version });
  } catch (error) {
    sendError(res, error);
  }
};

exports.resources = async (req, res) => {
  try {
    const resources = await mikrotikService.getSystemResources();
    res.json({ success: true, resources });
  } catch (error) {
    sendError(res, error);
  }
};

exports.interfaces = async (req, res) => {
  try {
    const interfaces = await mikrotikService.getInterfaces();
    res.json({ success: true, interfaces });
  } catch (error) {
    sendError(res, error);
  }
};

exports.traffic = async (req, res) => {
  try {
    const interfaceName = String(req.query.interface || "").trim();
    if (!interfaceName) {
      return res.status(400).json({
        success: false,
        error: "Query parameter 'interface' is required."
      });
    }

    const traffic = await mikrotikService.getInterfaceTraffic(interfaceName);
    res.json({ success: true, traffic });
  } catch (error) {
    sendError(res, error);
  }
};

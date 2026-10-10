const db = require("../db");
const mikrotikService = require("../services/mikrotikService");

const TYPES = new Set(["mikrotik","olt","onu","ont","access_point","cpe","other"]);
function clean(value, max = 240) { return String(value ?? "").trim().slice(0, max); }
function sendError(res, error) {
  console.error("[Devices API]", error?.message || error);
  return res.status(error?.statusCode || 500).json({ success: false, message: error?.message || "Device operation failed." });
}
exports.list = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, device_type AS "deviceType", name, vendor, model,
             host(management_ip) AS "managementIp", mac_address::text AS "macAddress",
             serial_number AS "serialNumber", location, parent_device_id AS "parentDeviceId",
             notes, last_seen_at AS "lastSeenAt", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM network_devices ORDER BY device_type, lower(name), id
    `);
    res.json({ success: true, devices: result.rows });
  } catch (error) { sendError(res, error); }
};
exports.create = async (req, res) => {
  try {
    const body = req.body || {};
    const deviceType = clean(body.deviceType, 24).toLowerCase();
    const name = clean(body.name, 120);
    if (!TYPES.has(deviceType)) return res.status(400).json({ success: false, message: "Select a supported device type." });
    if (!name) return res.status(400).json({ success: false, message: "Device name is required." });
    const ip = clean(body.managementIp, 64);
    const mac = clean(body.macAddress, 32).replace(/-/g, ":");
    if (ip && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && !ip.includes(":")) return res.status(400).json({ success: false, message: "Enter a valid IPv4 or IPv6 management address." });
    if (mac && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) return res.status(400).json({ success: false, message: "Enter a valid MAC address." });
    const parentId = body.parentDeviceId ? Number(body.parentDeviceId) : null;
    const result = await db.query(`
      INSERT INTO network_devices
        (device_type, name, vendor, model, management_ip, mac_address, serial_number, location, parent_device_id, notes)
      VALUES ($1,$2,$3,$4,$5::inet,$6::macaddr,$7,$8,$9,$10)
      RETURNING id, device_type AS "deviceType", name, vendor, model,
                host(management_ip) AS "managementIp", mac_address::text AS "macAddress",
                serial_number AS "serialNumber", location, parent_device_id AS "parentDeviceId",
                notes, last_seen_at AS "lastSeenAt", created_at AS "createdAt"
    `, [deviceType,name,clean(body.vendor,120)||null,clean(body.model,120)||null,ip||null,mac||null,clean(body.serialNumber,160)||null,clean(body.location,240)||null,Number.isSafeInteger(parentId)&&parentId>0?parentId:null,clean(body.notes,2000)||null]);
    res.status(201).json({ success: true, device: result.rows[0] });
  } catch (error) { sendError(res, error); }
};
exports.remove = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, message: "Invalid device ID." });
    const result = await db.query("DELETE FROM network_devices WHERE id=$1 RETURNING id", [id]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: "Device not found." });
    res.json({ success: true, deletedId: id });
  } catch (error) { sendError(res, error); }
};
exports.discoverMikrotik = async (req, res) => {
  try {
    // Discovery is deliberately read-only: no RouterOS configuration is changed.
    const [identity, resources, interfaces, bridgeHosts] = await Promise.all([
      mikrotikService.testConnection(),
      mikrotikService.getSystemResources(),
      mikrotikService.getInterfaces(),
      mikrotikService.getBridgeHosts().catch(() => [])
    ]);
    res.json({
      success: true,
      readOnly: true,
      checkedAt: new Date().toISOString(),
      router: identity,
      resources,
      interfaces,
      bridgeHosts,
      notes: [
        "Bridge host MACs are learned observations, not guaranteed customer identities.",
        "A port-to-customer mapping is only shown when separately matched to a panel record.",
        "OLT PON/ONU discovery requires the OLT vendor/model and a supported management protocol."
      ]
    });
  } catch (error) {
    res.status(503).json({ success: false, message: error?.message || "MikroTik discovery failed." });
  }
};

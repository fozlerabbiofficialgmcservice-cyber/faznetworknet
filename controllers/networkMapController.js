const db = require("../db");
const { getRxPowerStatus } = require("../lib/network/rxPowerStatus");

function clean(value, max = 255) {
  return String(value ?? "").trim().slice(0, max);
}

exports.getCustomerMap = async (req, res) => {
  try {
    const key = clean(req.params.id, 100);
    if (!key) return res.status(400).json({ success: false, message: "Customer ID or username is required." });

    const customerResult = await db.query(
      "SELECT c.id, c.username, c.onu_mac, c.fiber_box, c.onu_rx_power_dbm, c.onu_rx_power_observed_at, d.name AS rx_power_source FROM customers c LEFT JOIN network_devices d ON d.id=c.onu_rx_power_source_device_id WHERE c.id::text=$1 OR LOWER(c.username)=LOWER($1) LIMIT 2",
      [key]
    );
    if (customerResult.rows.length === 0) return res.status(404).json({ success: false, message: "Customer not found." });
    if (customerResult.rows.length !== 1) return res.status(409).json({ success: false, message: "Customer identity is ambiguous." });

    const customer = customerResult.rows[0];
    const observations = await db.query(
      `SELECT o.id, o.observation_type AS "observationType",
              o.identity_type AS "identityType", o.identity_value AS "identityValue",
              o.observed_value AS "observedValue", o.match_status AS "matchStatus",
              o.match_confidence AS "matchConfidence", o.evidence,
              o.observed_at AS "observedAt", d.name AS "sourceDevice"
       FROM network_observations o
       LEFT JOIN network_devices d ON d.id=o.source_device_id
       WHERE o.customer_id=$1
       ORDER BY o.observed_at DESC, o.id DESC
       LIMIT 30`,
      [customer.id]
    );
    const latest = observations.rows[0] || null;
    // Router MAC must be selected from PPPoE observations independently of
    // newer bridge-host or other observation types.
    const routerObservation = observations.rows.find(
      (item) => item.observationType === "pppoe_session"
    ) || null;
    const rxStatus = customer.onu_rx_power_dbm === null || customer.onu_rx_power_dbm === undefined
      ? "awaiting_olt_reading"
      : getRxPowerStatus(customer.onu_rx_power_observed_at);
    return res.json({
      success: true,
      customer: { id: customer.id, username: customer.username },
      provisioned: { onuMac: customer.onu_mac || null, fiberBox: customer.fiber_box || null },
      rxPower: { dbm: customer.onu_rx_power_dbm === null || customer.onu_rx_power_dbm === undefined ? null : Number(customer.onu_rx_power_dbm), observedAt: customer.onu_rx_power_observed_at || null, sourceDevice: customer.rx_power_source || null, status: rxStatus },
      routerMac: routerObservation?.observedValue?.routerMac || null,
      observations: observations.rows,
      discoveryStatus: latest ? "observations_available" : "not_yet_observed",
      lastObservedAt: latest?.observedAt || null,
      notes: [
        "ONU MAC is sourced from customer fiber inventory until an OLT/PON adapter verifies it.",
        "Router MAC is sourced from MikroTik PPPoE caller-id observations.",
        "Unknown and ambiguous identities are not automatically attached to this customer."
      ]
    });
  } catch (error) {
    console.error("[Network map customer API]", error?.message || error);
    return res.status(503).json({ success: false, message: "Customer network map is temporarily unavailable." });
  }
};

exports.getLatestSummary = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.status, r.started_at AS "startedAt", r.finished_at AS "finishedAt",
              r.discovered_count AS "discoveredCount", r.matched_count AS "matchedCount",
              r.unmatched_count AS "unmatchedCount", d.name AS "deviceName"
       FROM network_discovery_runs r
       LEFT JOIN network_devices d ON d.id=r.device_id
       ORDER BY r.started_at DESC, r.id DESC LIMIT 20`
    );
    return res.json({ success: true, runs: result.rows });
  } catch (error) {
    console.error("[Network map summary API]", error?.message || error);
    return res.status(503).json({ success: false, message: "Network discovery summary is temporarily unavailable." });
  }
};


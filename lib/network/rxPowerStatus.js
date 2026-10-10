"use strict";

/**
 * Classify cached ONU optical telemetry without changing or inventing readings.
 * A reading is stale after 30 minutes because the discovery cadence is 10 minutes.
 */
function getRxPowerStatus(observedAt, now = Date.now()) {
  if (observedAt === null || observedAt === undefined || observedAt === "") {
    return "awaiting_olt_reading";
  }
  const timestamp = new Date(observedAt).getTime();
  if (!Number.isFinite(timestamp)) return "invalid_timestamp";
  const ageMs = now - timestamp;
  if (ageMs < 0) return "invalid_timestamp";
  if (ageMs > 30 * 60 * 1000) return "stale";
  return "measured";
}

module.exports = { getRxPowerStatus };

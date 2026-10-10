"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { getRxPowerStatus } = require("../lib/network/rxPowerStatus");

const NOW = Date.parse("2026-10-11T00:00:00.000Z");

test("marks absent telemetry as awaiting an OLT reading", () => {
  assert.equal(getRxPowerStatus(null, NOW), "awaiting_olt_reading");
  assert.equal(getRxPowerStatus(undefined, NOW), "awaiting_olt_reading");
});

test("marks recent readings measured and readings older than 30 minutes stale", () => {
  assert.equal(getRxPowerStatus(new Date(NOW - 10 * 60 * 1000), NOW), "measured");
  assert.equal(getRxPowerStatus(new Date(NOW - 30 * 60 * 1000), NOW), "measured");
  assert.equal(getRxPowerStatus(new Date(NOW - 30 * 60 * 1000 - 1), NOW), "stale");
});

test("rejects invalid and future observation timestamps", () => {
  assert.equal(getRxPowerStatus("not-a-date", NOW), "invalid_timestamp");
  assert.equal(getRxPowerStatus(new Date(NOW + 1000), NOW), "invalid_timestamp");
});

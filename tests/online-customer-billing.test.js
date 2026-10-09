const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateCustomerBillingStatus, parseDateOnlyInDhaka } = require("../utils/billingStatus");

test("ISO date-only values are parsed by year-month-day, not locale", () => {
  const date = parseDateOnlyInDhaka("2026-10-09");
  assert.ok(date instanceof Date);
  assert.equal(date.toISOString(), "2026-10-09T00:00:00.000Z");
});

test("invalid ISO date-only values are rejected", () => {
  assert.equal(parseDateOnlyInDhaka("2026-02-30"), null);
});

test("a future canonical customer expiration is not marked expired", () => {
  const result = evaluateCustomerBillingStatus({ expiration_date: "2099-10-09" });
  assert.notEqual(result.status, "expired");
  assert.equal(result.badgeClass, "badge bg-success");
  assert.equal(result.label, "Paid / Active");
});

test("an old canonical customer expiration is marked expired", () => {
  const result = evaluateCustomerBillingStatus({ expiration_date: "2000-01-01" });
  assert.equal(result.status, "expired");
});

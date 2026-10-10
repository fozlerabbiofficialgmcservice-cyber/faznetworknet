const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMac, matchCustomerByOnuMac } = require("../lib/network/macMatcher");

test("normalizes common MAC formats to one canonical representation", () => {
  assert.equal(normalizeMac("a2:4f:b2:04:06:f8"), "A2:4F:B2:04:06:F8");
  assert.equal(normalizeMac("A2-4F-B2-04-06-F8"), "A2:4F:B2:04:06:F8");
  assert.equal(normalizeMac("a24f.b204.06f8"), "A2:4F:B2:04:06:F8");
  assert.equal(normalizeMac("not-a-mac"), null);
  assert.equal(normalizeMac(""), null);
});

test("matches only one exact ONU MAC regardless of formatting", () => {
  const customer = { id: 1, username: "subscriber-1", onu_mac: "a2-4f-b2-04-06-f8" };
  assert.deepEqual(matchCustomerByOnuMac("A2:4F:B2:04:06:F8", [customer]), {
    status: "matched", reason: "unique_exact_onu_mac", customer
  });
});

test("does not guess when ONU MAC is missing or unmatched", () => {
  assert.equal(matchCustomerByOnuMac(null, []).status, "unmatched");
  assert.equal(matchCustomerByOnuMac("00:11:22:33:44:55", []).reason, "no_exact_onu_mac_match");
});

test("flags duplicate customer ONU MACs as ambiguous", () => {
  const customers = [
    { id: 1, onu_mac: "00:11:22:33:44:55" },
    { id: 2, onu_mac: "00-11-22-33-44-55" }
  ];
  assert.deepEqual(matchCustomerByOnuMac("0011.2233.4455", customers), {
    status: "ambiguous", reason: "duplicate_onu_mac", customer: null
  });
});

test("does not match RouterOS caller-id or another field as ONU identity", () => {
  const customer = { id: 1, username: "subscriber-1", caller_id: "00:11:22:33:44:55" };
  assert.equal(matchCustomerByOnuMac("00:11:22:33:44:55", [customer]).status, "unmatched");
});

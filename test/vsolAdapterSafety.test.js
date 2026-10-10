const test = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../services/networkDiscoveryAdapters");

test("V-SOL adapter stays safely inactive until exact protocol support is verified", async () => {
  const result = await registry.inspectDevice({ vendor: "V-SOL", deviceType: "olt", protocol: "ssh" });
  assert.equal(result.supported, false);
  assert.equal(result.status, "not_configured");
  assert.equal(result.readOnly, true);
});

test("unknown vendor/protocol combinations are not probed with guessed commands", async () => {
  const result = await registry.inspectDevice({ vendor: "V-SOL", deviceType: "olt", protocol: "mystery-protocol" });
  assert.equal(result.supported, false);
  assert.equal(result.status, "not_configured");
});

test("adapter registry refuses to imply live ONU readings before verified access", async () => {
  const result = await registry.inspectDevice({ vendor: "V-SOL", deviceType: "olt", protocol: "https" });
  assert.equal(result.supported, false);
  assert.equal(result.status, "not_configured");
});

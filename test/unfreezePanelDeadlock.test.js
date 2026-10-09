const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("public homepage never opens a live MikroTik connection", () => {
  const server = read("server.js");
  assert.doesNotMatch(server, /publicMikrotikService\.getHotspotProfiles\s*\(/);
  assert.doesNotMatch(server, /require\(["']\.\/services\/mikrotikService["']\)/);
  assert.match(server, /Saved hotspot metadata unavailable/);
});

test("MikroTik connection and operation timeouts are three seconds", () => {
  const service = read("services/mikrotikService.js");
  assert.match(service, /const CONNECTION_TIMEOUT_MS = 3000/);
  assert.match(service, /const OPERATION_TIMEOUT_MS = 3000/);
  assert.match(service, /MikroTik connection timed out after 3 seconds/);
  assert.match(service, /this\._safeClose\(connection\);/);
  assert.doesNotMatch(service, /await this\._safeClose\(connection\)/);
});

test("admin diagnostics bound both database and router waits", () => {
  const diagnostics = read("controllers/adminDiagnosticsController.js");
  assert.match(diagnostics, /withTimeout\(db\.query\("SELECT 1"\), 1500/);
  assert.match(diagnostics, /withTimeout\(mikrotikService\.testConnection\(\), 3000/);
  assert.match(diagnostics, /clearTimeout\(timer\)/);
});

test("admin dashboard avoids duplicate RouterOS polling and pauses hidden-dashboard traffic", () => {
  const admin = read("views/admin.ejs");
  assert.match(admin, /if \(!dashboard \|\| dashboard\.style\.display === 'none'\) return;/);
  assert.match(admin, /trafficTimer = setInterval\(\(\) => \{ void pollTraffic\(\); \}, 10000\)/);
  assert.match(admin, /\}, 15000\);/);
  assert.doesNotMatch(admin, /initial dashboard refresh/);
  assert.doesNotMatch(admin, /safeAdminBootStep\('router metrics'/);
});

test("admin inline script has no accidentally escaped line break before router test handler", () => {
  const admin = read("views/admin.ejs");
  assert.doesNotMatch(
    admin,
    /Boolean\(d\.success\)\);\\n\s*document\.getElementById\('generalRouterTestBtn'\)/
  );
  assert.match(admin, /document\.getElementById\('generalRouterTestBtn'\)\?\.addEventListener/);
});

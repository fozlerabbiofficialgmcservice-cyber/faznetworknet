const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("public self-care routes expose customer check and login endpoints", () => {
  const routes = read("routes/publicRoutes.js");
  assert.match(routes, /router\.get\(["']\/customer-check["'],\s*controller\.publicCustomerCheck\)/);
  assert.match(routes, /router\.post\(["']\/customer-login["'],\s*controller\.publicCustomerLogin\)/);
});

test("public self-care controller exports the handlers used by routes", () => {
  const controller = read("controllers/customerController.js");
  assert.match(controller, /publicCustomerCheck/);
  assert.match(controller, /publicCustomerLogin/);
});

test("public homepage contains customer login and account status entry points", () => {
  const view = read("views/index.ejs");
  assert.match(view, /id="customerLoginBtn"/);
  assert.match(view, /Quick Pay \/ Check Status/);
  assert.match(view, /id="account"/);
});

test("test runner uses Node's built-in test framework", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.test, "node --test");
});

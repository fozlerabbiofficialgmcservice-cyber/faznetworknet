'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRole, currentRole, requireRole, requireStaffReadOnly } = require('./rbac');

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, redirect(url) { this.redirected = url; return this; } };
}

test('normalizes only the supported roles', () => {
  assert.equal(normalizeRole('Super_Admin'), 'super_admin');
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('owner'), null);
});

test('legacy shared admin remains super admin', () => {
  assert.equal(currentRole({ session: { isAdmin: true, legacySuperAdmin: true } }), 'super_admin');
});

test('role guard returns 403 for an authenticated insufficient role', () => {
  const req = { session: { isAdmin: true, role: 'staff' }, originalUrl: '/api/settings' };
  const res = response();
  let nextCalled = false;
  requireRole(['super_admin'])(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
  assert.equal(nextCalled, false);
});

test('staff mutation guard is read-only', () => {
  const req = { session: { role: 'staff' }, method: 'DELETE' };
  const res = response();
  let nextCalled = false;
  requireStaffReadOnly(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

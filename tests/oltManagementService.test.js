'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, validatePrivateIPv4, encrypt, decrypt } = require('../services/oltManagementService');

test('defaults a private IPv4 OLT endpoint to safe Auto Detect', () => {
  const parsed = validateConfig({name:'Main OLT',managementIp:'192.168.8.100',port:'80',username:'operator',password:'example'});
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.managementIp, '192.168.8.100');
  assert.equal(parsed.value.accessMethod, 'detect');
  assert.equal(parsed.value.port, 80);
});
test('accepts explicit HTTP and HTTPS access methods', () => {
  for (const accessMethod of ['http','https']) {
    const parsed = validateConfig({name:'Main OLT',managementIp:'192.168.8.100',accessMethod,port:'8443'});
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.value.accessMethod, accessMethod);
    assert.equal(parsed.value.protocol, accessMethod);
  }
});
test('validates both local and VPN-forwarded browser endpoints', () => {
  const parsed = validateConfig({name:'Main OLT',endpointMode:'vpn',localManagementIp:'192.168.1.20',localPort:'80',vpnForwardedIp:'203.0.113.22',vpnForwardedPort:'8080',accessMethod:'https'});
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.endpointMode, 'vpn');
  assert.equal(parsed.value.localManagementIp, '192.168.1.20');
  assert.equal(parsed.value.vpnForwardedIp, '203.0.113.22');
  assert.equal(parsed.value.port, 8080);
});
test('requires a valid local IP and a valid VPN endpoint when VPN mode is selected', () => {
  assert.ok(validateConfig({name:'Main OLT',endpointMode:'vpn',localManagementIp:'bad',vpnForwardedIp:'203.0.113.22'}).error);
  assert.ok(validateConfig({name:'Main OLT',endpointMode:'vpn',localManagementIp:'192.168.1.20',vpnForwardedIp:''}).error);
});
test('rejects public, malformed and missing management addresses', () => {
  for (const ip of ['8.8.8.8','127.0.0.1','169.254.169.254','bad-ip','']) {
    assert.ok(validatePrivateIPv4(ip), ip);
  }
});
test('rejects unsupported protocols and invalid ports', () => {
  assert.ok(validateConfig({name:'OLT',managementIp:'192.168.1.10',accessMethod:'ftp',port:21}).error);
  assert.ok(validateConfig({name:'OLT',managementIp:'192.168.1.10',protocol:'http',port:70000}).error);
});
test('encrypts and decrypts credentials with a configured 32-byte key', () => {
  const old = process.env.OLT_CREDENTIALS_ENCRYPTION_KEY;
  process.env.OLT_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('hex');
  try {
    const cipher = encrypt('non-default-secret');
    assert.notEqual(cipher, 'non-default-secret');
    assert.equal(decrypt(cipher), 'non-default-secret');
    assert.equal(encrypt(''), null);
  } finally {
    if (old === undefined) delete process.env.OLT_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.OLT_CREDENTIALS_ENCRYPTION_KEY = old;
  }
});
test('refuses to encrypt credentials without the application encryption key', () => {
  const old = process.env.OLT_CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.OLT_CREDENTIALS_ENCRYPTION_KEY;
  try { assert.throws(() => encrypt('secret'), /OLT_CREDENTIALS_ENCRYPTION_KEY/); }
  finally { if (old !== undefined) process.env.OLT_CREDENTIALS_ENCRYPTION_KEY = old; }
});

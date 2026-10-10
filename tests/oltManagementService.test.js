'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, validatePrivateIPv4, encrypt, decrypt } = require('../services/oltManagementService');

test('accepts a private IPv4 OLT web endpoint with explicit protocol and port', () => {
  const parsed = validateConfig({name:'Main OLT',managementIp:'192.168.8.100',protocol:'http',port:'80',username:'operator',password:'example'});
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.value.managementIp, '192.168.8.100');
  assert.equal(parsed.value.port, 80);
});
test('rejects public, malformed and missing management addresses', () => {
  for (const ip of ['8.8.8.8','127.0.0.1','169.254.169.254','bad-ip','']) {
    assert.ok(validatePrivateIPv4(ip), ip);
  }
});
test('rejects unsupported protocols and invalid ports', () => {
  assert.ok(validateConfig({name:'OLT',managementIp:'192.168.1.10',protocol:'ftp',port:21}).error);
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

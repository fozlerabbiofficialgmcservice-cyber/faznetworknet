'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePublicIp, validatePort, validatePortForward } = require('../services/networkAccessValidation');

test('accepts a public IPv4 and rejects private, CGNAT and malformed addresses', () => {
  assert.equal(validatePublicIp('8.8.8.8').value, '8.8.8.8');
  for (const ip of ['192.168.1.1', '10.0.0.1', '172.16.0.1', '100.64.1.1', 'not-an-ip', '2001:db8::1']) {
    assert.ok(validatePublicIp(ip).error, ip);
  }
  assert.equal(validatePublicIp('').value, null);
});

test('validates ports strictly', () => {
  assert.equal(validatePort('51820').value, 51820);
  for (const port of [0, 65536, -1, 'abc', 1.5]) assert.ok(validatePort(port).error);
});

test('validates forwarding rules and rejects unsafe destination shapes', () => {
  const valid = validatePortForward({name:'Admin VPN',protocol:'udp',externalPort:'51820',destinationIp:'192.168.88.2',internalPort:'51820'});
  assert.equal(valid.value.externalPort, 51820);
  assert.equal(valid.value.protocol, 'udp');
  assert.ok(validatePortForward({name:'x',protocol:'icmp',externalPort:53,destinationIp:'192.168.88.2',internalPort:53}).error);
  assert.ok(validatePortForward({name:'x',protocol:'tcp',externalPort:53,destinationIp:'not-ip',internalPort:53}).error);
  assert.ok(validatePortForward({name:'x',protocol:'tcp',externalPort:53,destinationIp:'192.168.88.2',internalPort:70000}).error);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePublicIp, validateEndpointHost, validatePort, validatePortForward } = require('../services/networkAccessValidation');

test('accepts public IPv4 and rejects private, CGNAT, documentation, benchmarking and malformed ranges', () => {
  assert.equal(validatePublicIp('8.8.8.8').value, '8.8.8.8');
  for (const ip of ['192.168.1.1', '10.0.0.1', '172.16.0.1', '100.64.1.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', 'not-an-ip', '2001:db8::1']) {
    assert.ok(validatePublicIp(ip).error, ip);
  }
  assert.equal(validatePublicIp('').value, null);
});

test('accepts only a hostname or public IPv4 as a VPN endpoint host', () => {
  assert.equal(validateEndpointHost('vpn.example.com').value, 'vpn.example.com');
  assert.equal(validateEndpointHost('VPN.Example.COM').value, 'vpn.example.com');
  assert.equal(validateEndpointHost('8.8.8.8').value, '8.8.8.8');
  for (const host of ['192.168.1.1', '100.64.1.1', 'http://vpn.example.com', 'vpn.example.com:51820', 'localhost', 'bad host', '-bad.example.com']) {
    assert.ok(validateEndpointHost(host).error, host);
  }
  assert.equal(validateEndpointHost('').value, null);
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

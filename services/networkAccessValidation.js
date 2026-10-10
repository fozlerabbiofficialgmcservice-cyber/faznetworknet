'use strict';

const net = require('node:net');

function validatePublicIp(value) {
  const input = String(value ?? '').trim();
  if (!input) return { value: null, error: null };
  if (net.isIP(input) !== 4) return { value: null, error: 'Enter a valid public IPv4 address.' };
  const octets = input.split('.').map(Number);
  const [a, b] = octets;
  const isPrivate = a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a >= 224) || (a === 100 && b >= 64 && b <= 127);
  if (isPrivate) return { value: null, error: 'This is not a publicly routable IPv4 address.' };
  return { value: input, error: null };
}

function validatePort(value, label = 'Port') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { value: null, error: label + ' must be an integer from 1 to 65535.' };
  return { value: port, error: null };
}

function validatePortForward(body = {}) {
  const name = String(body.name ?? '').trim().slice(0, 120);
  const protocol = String(body.protocol ?? 'tcp').trim().toLowerCase();
  const destinationIp = String(body.destinationIp ?? '').trim();
  const external = validatePort(body.externalPort, 'External port');
  const internal = validatePort(body.internalPort, 'Internal port');
  if (!name) return { error: 'Rule name is required.' };
  if (!['tcp', 'udp', 'both'].includes(protocol)) return { error: 'Protocol must be TCP, UDP, or both.' };
  if (net.isIP(destinationIp) !== 4) return { error: 'Destination must be a valid IPv4 address.' };
  if (destinationIp.startsWith('127.') || destinationIp.startsWith('169.254.') || destinationIp === '0.0.0.0' || destinationIp.startsWith('224.')) return { error: 'Destination IP is not allowed.' };
  if (external.error) return { error: external.error };
  if (internal.error) return { error: internal.error };
  const source = String(body.allowedSourceIp ?? '').trim();
  if (source && net.isIP(source) !== 4) return { error: 'Allowed source must be a valid IPv4 address or left empty.' };
  return { value: { name, protocol, destinationIp, externalPort: external.value, internalPort: internal.value, allowedSourceIp: source || null } };
}

module.exports = { validatePublicIp, validatePort, validatePortForward };

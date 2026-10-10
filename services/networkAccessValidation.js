'use strict';

const net = require('node:net');

function validatePublicIp(value) {
  const input = String(value ?? '').trim();
  if (!input) return { value: null, error: null };
  if (net.isIP(input) !== 4) return { value: null, error: 'Enter a valid public IPv4 address.' };
  const octets = input.split('.').map(Number);
  const [a, b, c] = octets;
  const blocked = a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
  if (blocked) return { value: null, error: 'This is not a publicly routable IPv4 address.' };
  return { value: input, error: null };
}

function validateEndpointHost(value) {
  const input = String(value ?? '').trim();
  if (!input) return { value: null, error: null };
  if (input.length > 253 || /[\s/:?#@]/.test(input)) {
    return { value: null, error: 'Enter a hostname or public IPv4 address only, without a URL or port.' };
  }
  if (net.isIP(input) === 4) {
    const parsed = validatePublicIp(input);
    return parsed.error ? { value: null, error: 'VPN endpoint must be a publicly reachable IPv4 address or DNS hostname.' } : parsed;
  }
  const hostname = input.endsWith('.') ? input.slice(0, -1) : input;
  const labels = hostname.split('.');
  const valid = labels.length >= 2 && labels.every(label =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
  );
  if (!valid || net.isIP(input) === 6) {
    return { value: null, error: 'Enter a valid DNS hostname or public IPv4 address.' };
  }
  return { value: hostname.toLowerCase(), error: null };
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
  const octets = destinationIp.split('.').map(Number);
  if (octets[0] === 0 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) ||
      octets[0] >= 224 || destinationIp === '255.255.255.255') {
    return { error: 'Destination IP is not allowed.' };
  }
  if (external.error) return { error: external.error };
  if (internal.error) return { error: internal.error };
  const source = String(body.allowedSourceIp ?? '').trim();
  if (source && net.isIP(source) !== 4) return { error: 'Allowed source must be a valid IPv4 address or left empty.' };
  return { value: { name, protocol, destinationIp, externalPort: external.value, internalPort: internal.value, allowedSourceIp: source || null } };
}

module.exports = { validatePublicIp, validateEndpointHost, validatePort, validatePortForward };

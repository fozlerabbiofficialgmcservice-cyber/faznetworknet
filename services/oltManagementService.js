'use strict';
const crypto = require('node:crypto');
const net = require('node:net');

function key() {
  const raw = String(process.env.OLT_CREDENTIALS_ENCRYPTION_KEY || '').trim();
  if (!raw) throw Object.assign(new Error('OLT_CREDENTIALS_ENCRYPTION_KEY must be configured before saving OLT credentials.'), { statusCode: 503 });
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch (_) {}
  throw Object.assign(new Error('OLT_CREDENTIALS_ENCRYPTION_KEY must be a 32-byte hex or base64 key.'), { statusCode: 503 });
}
function encrypt(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
function decrypt(value) {
  if (!value) return '';
  const parts = String(value).split('.');
  if (parts.length !== 3) throw new Error('Stored OLT credential has an invalid format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[0], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
}
function validatePrivateIPv4(value) {
  const host = String(value || '').trim();
  if (net.isIP(host) !== 4) return 'Enter the OLT management IPv4 address.';
  const [a,b,c] = host.split('.').map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
  return 'For safety, OLT management must use a private LAN IPv4 address (RFC1918).';
}
function validateConfig(body = {}) {
  const name = String(body.name || '').trim().slice(0,120);
  const host = String(body.managementIp || '').trim();
  const port = Number(body.port || (String(body.protocol).toLowerCase() === 'https' ? 443 : 80));
  const protocol = String(body.protocol || 'http').toLowerCase();
  if (!name) return { error: 'Device name is required.' };
  const hostError = validatePrivateIPv4(host);
  if (hostError) return { error: hostError };
  if (!['http','https'].includes(protocol)) return { error: 'Select HTTP or HTTPS based on the OLT web interface.' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Port must be an integer from 1 to 65535.' };
  const username = String(body.username || '').trim().slice(0,160);
  const password = String(body.password || '');
  if (password.length > 1024) return { error: 'Password is too long.' };
  return { value: { name, managementIp: host, protocol, port, username, password } };
}
module.exports = { encrypt, decrypt, validateConfig, validatePrivateIPv4 };

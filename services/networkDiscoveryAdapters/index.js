/**
 * Vendor-neutral discovery adapter registry.
 * Adapters must be observation-only and must not guess protocols or commands.
 */
const adapters = new Map();

function registerAdapter({ key, vendor, deviceTypes, protocols, create }) {
  if (!key || typeof create !== "function" || !Array.isArray(deviceTypes) || !Array.isArray(protocols)) {
    throw new TypeError("A discovery adapter requires key, create, deviceTypes, and protocols.");
  }
  if (adapters.has(key)) throw new Error("Duplicate network discovery adapter: " + key);
  adapters.set(key, { key, vendor: vendor || "generic", deviceTypes, protocols, create });
}

function resolveAdapter({ vendor, deviceType, protocol }) {
  const v = String(vendor || "").trim().toLowerCase();
  const t = String(deviceType || "").trim().toLowerCase();
  const p = String(protocol || "").trim().toLowerCase();
  for (const descriptor of adapters.values()) {
    if (descriptor.vendor.toLowerCase() === v &&
        descriptor.deviceTypes.includes(t) &&
        descriptor.protocols.includes(p)) return descriptor;
  }
  return null;
}

async function inspectDevice(device) {
  const descriptor = resolveAdapter(device || {});
  if (!descriptor) return {
    supported: false,
    status: "not_configured",
    message: "No verified adapter matches this device vendor, type, and protocol."
  };
  return descriptor.create().probe(device);
}

module.exports = { registerAdapter, resolveAdapter, inspectDevice };

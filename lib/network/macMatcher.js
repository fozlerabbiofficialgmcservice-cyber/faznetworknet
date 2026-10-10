/**
 * Pure, vendor-neutral ONU/customer MAC matching helpers.
 * Never infers identity from a partial MAC or from RouterOS caller-id.
 */
function normalizeMac(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const compact = raw.replace(/[:.\-\s]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(compact)) return null;
  return compact.toUpperCase().match(/.{2}/g).join(":");
}

/**
 * Match an observed ONU MAC against customer inventory.
 * Returns unmatched/ambiguous rather than guessing when identity is unsafe.
 */
function matchCustomerByOnuMac(observedMac, customers) {
  const normalized = normalizeMac(observedMac);
  if (!normalized) return { status: "unmatched", reason: "invalid_or_missing_mac", customer: null };

  const matches = (Array.isArray(customers) ? customers : []).filter((customer) =>
    normalizeMac(customer?.onu_mac ?? customer?.onuMac) === normalized
  );
  if (matches.length === 1) return { status: "matched", reason: "unique_exact_onu_mac", customer: matches[0] };
  if (matches.length > 1) return { status: "ambiguous", reason: "duplicate_onu_mac", customer: null };
  return { status: "unmatched", reason: "no_exact_onu_mac_match", customer: null };
}

module.exports = { normalizeMac, matchCustomerByOnuMac };

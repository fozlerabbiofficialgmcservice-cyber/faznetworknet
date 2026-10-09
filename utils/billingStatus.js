function parseDateOnlyInDhaka(value) {
  if (value == null || value === "") return null;
  // PostgreSQL DATE values are ISO YYYY-MM-DD; parse components explicitly
  // to avoid browser/Node locale ambiguity and UTC day shifts.
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/);
    if (match) {
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) return parsed;
      return null;
    }
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function evaluateCustomerBillingStatus(customer) {
  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const part = type => todayParts.find(item => item.type === type)?.value;
  const today = Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day")));

  if (!customer?.expiration_date) {
    return { status: "unpaid", badgeClass: "badge bg-danger", label: "Unpaid / Expired", daysLeft: 0 };
  }

  const expDate = parseDateOnlyInDhaka(customer.expiration_date);
  if (!expDate) {
    return { status: "unpaid", badgeClass: "badge bg-danger", label: "Unpaid / Expired", daysLeft: 0 };
  }

  const diffTime = expDate.getTime() - today;
  const daysLeft = Math.ceil(diffTime / 86400000);

  if (daysLeft < 0) {
    return { status: "expired", badgeClass: "badge bg-danger", label: "Unpaid / Expired", daysLeft: 0 };
  } else if (daysLeft <= 3) {
    return { status: "due", badgeClass: "badge bg-warning text-dark", label: `Expiring Soon (${daysLeft}d)`, daysLeft };
  }

  return { status: "paid", badgeClass: "badge bg-success", label: "Paid / Active", daysLeft };
}

module.exports = { evaluateCustomerBillingStatus, parseDateOnlyInDhaka };

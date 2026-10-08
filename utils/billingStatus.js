function evaluateCustomerBillingStatus(customer) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  if (!customer?.expiration_date) {
    return {
      status: "unpaid",
      badgeClass: "badge bg-danger",
      label: "Unpaid / Expired",
      daysLeft: 0
    };
  }

  const expDate = new Date(customer.expiration_date);
  expDate.setHours(0, 0, 0, 0);

  if (Number.isNaN(expDate.getTime())) {
    return {
      status: "unpaid",
      badgeClass: "badge bg-danger",
      label: "Unpaid / Expired",
      daysLeft: 0
    };
  }

  const diffTime = expDate.getTime() - now.getTime();
  const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (daysLeft < 0) {
    return {
      status: "expired",
      badgeClass: "badge bg-danger",
      label: "Unpaid / Expired",
      daysLeft: 0
    };
  } else if (daysLeft <= 3) {
    return {
      status: "due",
      badgeClass: "badge bg-warning text-dark",
      label: `Expiring Soon (${daysLeft}d)`,
      daysLeft
    };
  }

  return {
    status: "paid",
    badgeClass: "badge bg-success",
    label: "Paid / Active",
    daysLeft
  };
}

module.exports = { evaluateCustomerBillingStatus };

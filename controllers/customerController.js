const db = require("../db");

function clean(value, max = 255) {
  return String(value ?? "").trim().slice(0, max);
}

function errorResponse(res, error) {
  console.error("[CUSTOMER API]", error);
  const message = error?.message || "Customer operation failed.";
  return res.status(error?.statusCode || 503).json({
    success: false,
    message,
    error: message
  });
}

function normalizeDate(value) {
  const raw = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  const date = new Date(raw + "T00:00:00Z");
  return Number.isNaN(date.getTime()) ? "" : raw;
}

function normalizeBill(value) {
  const bill = Number(value);
  if (!Number.isFinite(bill) || bill < 0 || bill > 10000000) return null;
  return Number(bill.toFixed(2));
}

async function packages(req, res) {
  try {
    const result = await db.query(
      `SELECT name, name AS profile, COALESCE(price, 0) AS price
       FROM pppoe_profiles
       WHERE NULLIF(TRIM(name), '') IS NOT NULL
       ORDER BY name ASC`
    );
    return res.json({
      success: true,
      packages: result.rows.map(row => ({
        name: row.name,
        profile: row.profile,
        price: Number(row.price || 0)
      }))
    });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function createCustomer(req, res) {
  const body = req.body || {};
  const customer = {
    fullName: clean(body.fullName || body.name, 200),
    phone: clean(body.phone, 40),
    connectionDate: normalizeDate(body.connectionDate),
    username: clean(body.username, 100),
    password: clean(body.password, 255),
    packageName: clean(body.package || body.packageName || body.profile, 100),
    profile: clean(body.profile || body.package || body.packageName, 100),
    monthlyBill: normalizeBill(body.bill ?? body.monthlyBill),
    nid: clean(body.nid, 100),
    installationAddress: clean(body.installationAddress || body.address, 500),
    fiberBox: clean(body.fiberBox, 150),
    onuMac: clean(body.onuMac, 100),
    remarks: clean(body.remarks || body.note, 1000)
  };

  if (!customer.fullName || !customer.phone || !customer.connectionDate ||
      !customer.username || !customer.password || !customer.packageName ||
      !customer.profile || customer.monthlyBill === null) {
    return res.status(400).json({
      success: false,
      message: "Name, phone, connection date, username, password, package, and bill are required."
    });
  }

  try {
    const existing = await db.query(
      `SELECT id, username, phone FROM customers
       WHERE LOWER(username)=LOWER($1) OR phone=$2 LIMIT 1`,
      [customer.username, customer.phone]
    );
    if (existing.rows.length) {
      const match = existing.rows[0];
      return res.status(409).json({
        success: false,
        message: String(match.username).toLowerCase() === customer.username.toLowerCase()
          ? "A customer with this PPPoE username already exists."
          : "A customer with this phone number already exists."
      });
    }

    const inserted = await db.query(
      `INSERT INTO customers
       (full_name, phone, connection_date, username, password, package_name, profile,
        monthly_bill, nid, installation_address, fiber_box, onu_mac, remarks,
        provisioning_status, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending','active',NOW(),NOW())
       RETURNING id, username`,
      [
        customer.fullName, customer.phone, customer.connectionDate, customer.username,
        customer.password, customer.packageName, customer.profile, customer.monthlyBill,
        customer.nid || null, customer.installationAddress || null, customer.fiberBox || null,
        customer.onuMac || null, customer.remarks || null
      ]
    );

    const customerId = inserted.rows[0].id;
    let provisioning = "pending";

    try {
      const routerReady = await require("../services/mikrotikService").testConnection();
      if (routerReady) {
        await require("../services/mikrotikService").createSecret({
          username: customer.username,
          password: customer.password,
          profile: customer.profile,
          comment: "Customer: " + customer.fullName + " | Phone: " + customer.phone
        });
        provisioning = "provisioned";
        await db.query(
          `UPDATE customers SET provisioning_status='provisioned', router_id=$1, updated_at=NOW() WHERE id=$2`,
          [String(process.env.ROUTER_HOST || ""), customerId]
        );
      }
    } catch (routerError) {
      provisioning = "failed";
      console.warn("[CUSTOMER PROVISION] MikroTik provisioning deferred:", routerError.message);
      await db.query(
        `UPDATE customers SET provisioning_status='failed', updated_at=NOW() WHERE id=$1`,
        [customerId]
      );
    }

    return res.status(201).json({
      success: true,
      message: provisioning === "provisioned"
        ? "Customer created successfully"
        : "Customer created successfully; MikroTik provisioning is pending.",
      customer: {
        id: customerId,
        username: customer.username,
        profile: customer.profile,
        monthlyBill: customer.monthlyBill,
        provisioningStatus: provisioning
      }
    });
  } catch (error) {
    return errorResponse(res, error);
  }
}

module.exports = { packages, createCustomer };

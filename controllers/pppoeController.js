const mikrotikService = require("../services/mikrotikService");
const db = require("../db");
const {evaluateCustomerBillingStatus}=require("../utils/billingStatus");

function errorResponse(res, error) {
  console.error("[PPPoE API]", error);
  const message = error?.message || "PPPoE operation failed.";
  return res.status(error?.statusCode || 503).json({
    success: false,
    users: [],
    profiles: [],
    message,
    error: message
  });
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1" || value === "yes";
}

function clean(value, max = 255) {
  return String(value ?? "").trim().slice(0, max);
}

function extractExpiryDate(comment) {
  const match = String(comment || "").match(/(?:^|[|;\s])EXP:\s*(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/i);
  if (!match) return "";
  const value = match[1];
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [, day, month, year] = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) || [];
  if (!day) return "";
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() === Number(month) - 1 && parsed.getUTCDate() === Number(day)
    ? year + "-" + month + "-" + day
    : "";
}

function extractPhone(comment) {
  const text = String(comment || "");
  const match = text.match(/(?:phone|mobile|tel|মোবাইল|ফোন)\s*[:=-]?\s*([+\d][\d\s-]{7,})/i);
  return match ? match[1].trim() : "";
}

async function syncFromRouter() {
  const [profiles, secrets] = await Promise.all([
    mikrotikService.fetchExistingProfiles(),
    mikrotikService.fetchExistingSecrets()
  ]);
  const routerId = String(process.env.ROUTER_HOST || "");

  const result = await db.withTransaction(async (client) => {
    // Never resurrect a username explicitly deleted by an admin.
    const tombstoneResult = await client.query("SELECT LOWER(username) AS username FROM customer_deletion_tombstones");
    const deletedUsernames = new Set(tombstoneResult.rows.map(row => String(row.username || "").toLowerCase()));

    for (const profile of profiles) {
      await client.query(
        `INSERT INTO pppoe_profiles
          (name, rate_limit, local_address, remote_address, session_timeout, idle_timeout, only_one, change_tcp_mss, comment, router_id, raw_config, synced_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW(),NOW())
         ON CONFLICT (name) DO UPDATE SET
           rate_limit=EXCLUDED.rate_limit, local_address=EXCLUDED.local_address, remote_address=EXCLUDED.remote_address,
           session_timeout=EXCLUDED.session_timeout, idle_timeout=EXCLUDED.idle_timeout, only_one=EXCLUDED.only_one,
           change_tcp_mss=EXCLUDED.change_tcp_mss, comment=EXCLUDED.comment, router_id=EXCLUDED.router_id,
           raw_config=EXCLUDED.raw_config, synced_at=NOW(), updated_at=NOW()`,
        [
          profile.name, profile.rateLimit, profile.localAddress, profile.remoteAddress, profile.sessionTimeout,
          profile.idleTimeout, profile.onlyOne, profile.changeTcpMss, profile.comment, routerId, JSON.stringify(profile.raw || {})
        ]
      );
    }

    for (const user of secrets) {
      const usernameKey = String(user.name || "").trim().toLowerCase();
      if (!usernameKey || deletedUsernames.has(usernameKey)) {
        if (usernameKey) console.log("[PPPoE SYNC] Skipping admin-deleted username:", user.name);
        continue;
      }
      const comment = user.comment || "";
      await client.query(
        `INSERT INTO pppoe_users
          (username, password, profile, service, caller_id, disabled, comment, phone, local_address, remote_address, router_id, raw_config, expiry_date, status, synced_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,CASE WHEN $13 IS NOT NULL AND $13 < (NOW() AT TIME ZONE 'Asia/Dhaka')::date THEN 'expired' ELSE 'active' END,NOW(),NOW())
         ON CONFLICT (username) DO UPDATE SET
           password=COALESCE(EXCLUDED.password, pppoe_users.password), profile=EXCLUDED.profile, service=EXCLUDED.service,
           caller_id=COALESCE(NULLIF(EXCLUDED.caller_id,''),pppoe_users.caller_id), disabled=EXCLUDED.disabled, comment=EXCLUDED.comment,
           phone=COALESCE(NULLIF(EXCLUDED.phone,''), pppoe_users.phone), local_address=EXCLUDED.local_address,
           remote_address=EXCLUDED.remote_address, router_id=EXCLUDED.router_id, raw_config=EXCLUDED.raw_config, expiry_date=EXCLUDED.expiry_date,
           status=EXCLUDED.status, synced_at=NOW(), updated_at=NOW()`,
        [
          user.name, user.password, user.profile, user.service, user.callerId, user.disabled, comment,
          extractPhone(comment), user.localAddress, user.remoteAddress, routerId, JSON.stringify(user.raw || {}), extractExpiryDate(comment)
        ]
      );
    }
    return { profiles: profiles.length, users: secrets.length };
  });

  return result;
}

async function users(req, res) {
  try {
    const filter = clean(req.query.filter || "all", 40).toLowerCase();
    const allowedFilters = new Set([
      "all", "online", "offline", "active", "expire",
      "expire_today_yesterday", "expire_7_days", "new", "due"
    ]);
    if (!allowedFilters.has(filter)) {
      return res.status(400).json({
        success: false,
        error: "Invalid customer filter.",
        allowedFilters: Array.from(allowedFilters)
      });
    }

    const conditions = [];
    const params = [];

    if (filter === "active") {
      conditions.push("u.status = 'active'");
      conditions.push("(u.expiry_date IS NULL OR u.expiry_date >= (NOW() AT TIME ZONE 'Asia/Dhaka')::date)");
      conditions.push("u.disabled = FALSE");
    } else if (filter === "expire") {
      conditions.push("u.expiry_date IS NOT NULL");
      conditions.push("u.expiry_date IS NOT NULL");
      conditions.push("u.expiry_date < (NOW() AT TIME ZONE 'Asia/Dhaka')::date");
    } else if (filter === "expire_today_yesterday") {
      conditions.push("u.expiry_date IS NOT NULL");
      conditions.push("u.expiry_date BETWEEN ((NOW() AT TIME ZONE 'Asia/Dhaka')::date - INTERVAL '1 day') AND (NOW() AT TIME ZONE 'Asia/Dhaka')::date");
    } else if (filter === "expire_7_days") {
      conditions.push("u.expiry_date IS NOT NULL");
      conditions.push("u.expiry_date BETWEEN (NOW() AT TIME ZONE 'Asia/Dhaka')::date AND ((NOW() AT TIME ZONE 'Asia/Dhaka')::date + INTERVAL '7 days')");
    } else if (filter === "new") {
      conditions.push("u.created_at >= NOW() - INTERVAL '7 days'");
    } else if (filter === "due") {
      conditions.push("(u.expiry_date IS NOT NULL AND u.expiry_date < (NOW() AT TIME ZONE 'Asia/Dhaka')::date) OR LOWER(COALESCE(u.status, '')) IN ('disabled', 'left', 'terminated') OR u.disabled = TRUE");
    }

    const whereClause = conditions.length ? "WHERE " + conditions.map(c => "(" + c + ")").join(" AND ") : "";

    const result = await db.query(`
      SELECT u.*,
             c.id AS customer_id, c.created_at AS customer_created_at,
             c.expiration_date AS customer_expiration_date,
             c.package_name AS customer_package_name,
             c.profile AS customer_profile,
             c.status AS customer_billing_state
      FROM pppoe_users u
      LEFT JOIN customers c ON LOWER(c.username)=LOWER(u.username)
      ${whereClause}
      ORDER BY COALESCE(c.created_at, '1970-01-01'::timestamp) ASC, c.username ASC, c.id ASC
    `, params);

    let sessions = [];
    try {
      sessions = await mikrotikService.getActiveSessions();
    } catch (routerError) {
      if (filter === "online" || filter === "offline") throw routerError;
      console.warn("[PPPoE FILTER] MikroTik live session lookup unavailable:", routerError.message);
    }

    const sessionMap = new Map();
    for (const session of sessions) {
      const username = String(session.username || "").trim().toLowerCase();
      if (username && !sessionMap.has(username)) sessionMap.set(username, session);
    }

    let users = result.rows.map(user => {
      const session = sessionMap.get(String(user.username || "").trim().toLowerCase());
      // Billing/customer metadata must come from the same canonical row as All Customer.
      // MikroTik/pppoe_users is authoritative only for live session and router fields.
      const hasCustomerRecord = user.customer_id != null;
      const canonicalExpiry = hasCustomerRecord ? (user.customer_expiration_date || null) : (user.expiry_date || null);
      const billing=evaluateCustomerBillingStatus({expiration_date:canonicalExpiry});
      return {
        ...user,
        package_name: (hasCustomerRecord ? user.customer_package_name : null) || user.package_name || user.customer_profile || user.profile || "",
        profile: (hasCustomerRecord ? user.customer_profile : null) || user.profile || "",
        expiration_date: canonicalExpiry,
        expiry_date: canonicalExpiry,
        customer_billing_state: user.customer_billing_state || null,
        billing_status:billing.status,
        billing_badge_class:billing.badgeClass,
        badgeClass:billing.badgeClass,
        billing_label:billing.label,
        days_left:billing.daysLeft,
        active: Boolean(session),
        online: Boolean(session),
        session: session || null,
        session_ip: session?.address || null,
        session_uptime: session?.uptime || null,
        session_caller_id: session?.callerId || null,
        computed_status:billing.status
      };
    });

    if (filter === "online") users = users.filter(user => user.online);
    if (filter === "offline") users = users.filter(user => !user.online);

    return res.json({
      success: true,
      count: users.length,
      filter,
      users
    });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function profiles(req, res) {
  try {
    const result = await db.query("SELECT * FROM pppoe_profiles WHERE LOWER(name) NOT LIKE '%default%' AND LOWER(name) <> 'vpn' AND LOWER(name) NOT LIKE 'template-%' AND LOWER(name) NOT LIKE 'internal-%' AND LOWER(name) NOT LIKE 'system-%' ORDER BY name ASC");
    res.json({ success: true, profiles: result.rows });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function sync(req, res) {
  try {
    const result = await syncFromRouter();
    res.json({ success: true, ...result, message: `Imported ${result.users} users and ${result.profiles} profiles from MikroTik.` });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function active(req, res) {
  try {
    const sessions = await mikrotikService.getActiveSessions();
    res.json({ success: true, sessions });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function createUser(req, res) {
  try {
    const username = clean(req.body.username, 100);
    const password = String(req.body.password ?? "").trim();
    const profile = clean(req.body.profile, 100);
    const callerId = clean(req.body.callerId, 100);
    const comment = clean(req.body.comment, 500);
    const disabled = normalizeBoolean(req.body.disabled);
    if (!username || !password || !profile) {
      return res.status(400).json({ success: false, error: "Username, password, and profile are required." });
    }
    await mikrotikService.createSecret({ username, password, profile, callerId, comment, disabled });
    await syncFromRouter();
    res.json({ success: true, message: "PPPoE user created on MikroTik and synced to database." });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function updateUser(req, res) {
  try {
    const username = clean(req.body.username, 100);
    if (!username) return res.status(400).json({ success: false, error: "Username is required." });
    const data = {
      password: String(req.body.password ?? "").trim(),
      profile: clean(req.body.profile, 100),
      callerId: clean(req.body.callerId, 100),
      comment: clean(req.body.comment, 500),
      disabled: normalizeBoolean(req.body.disabled)
    };
    if (!data.profile) return res.status(400).json({ success: false, error: "Profile is required." });
    await mikrotikService.updateSecret(username, data);
    await syncFromRouter();
    res.json({ success: true, message: "PPPoE user updated and synchronized." });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function toggleUser(req, res) {
  try {
    const username = clean(req.body.username, 100);
    const disabled = normalizeBoolean(req.body.disabled);
    if (!username) return res.status(400).json({ success: false, error: "Username is required." });
    await mikrotikService.toggleSecret(username, disabled);
    await db.query("UPDATE pppoe_users SET disabled=$1, updated_at=NOW() WHERE username=$2", [disabled, username]);
    res.json({ success: true, username, disabled });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function kickUser(req, res) {
  try {
    const username = clean(req.body.username, 100);
    if (!username) return res.status(400).json({ success: false, error: "Username is required." });
    const result = await mikrotikService.kickActiveUser(username);
    res.json({ success: true, ...result });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function createProfile(req, res) {
  try {
    const data = {
      name: clean(req.body.name, 100),
      rateLimit: clean(req.body.rateLimit, 100),
      localAddress: clean(req.body.localAddress, 100),
      remoteAddress: clean(req.body.remoteAddress, 100),
      sessionTimeout: clean(req.body.sessionTimeout, 50),
      idleTimeout: clean(req.body.idleTimeout, 50),
      comment: clean(req.body.comment, 500),
      onlyOne: normalizeBoolean(req.body.onlyOne),
      changeTcpMss: normalizeBoolean(req.body.changeTcpMss)
    };
    if (!data.name) return res.status(400).json({ success: false, error: "Profile name is required." });
    await mikrotikService.createProfile(data);
    await syncFromRouter();
    res.json({ success: true, message: "Profile created on MikroTik and synchronized." });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function removeUser(req,res){
  // Keep PPPoE deletion on the exact same unconditional deletion path used
  // by /api/customers/:id so either endpoint handles customer IDs, PPPoE
  // usernames, router-synced users, and already-partially-deleted records.
  const customerController=require("./customerController");
  return customerController.removeCustomer(req,res);
}

module.exports = { sync, users, profiles, active, createUser, updateUser, toggleUser, kickUser, createProfile, removeUser };

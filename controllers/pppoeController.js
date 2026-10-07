const mikrotikService = require("../services/mikrotikService");
const db = require("../db");

function errorResponse(res, error) {
  console.error("[PPPoE API]", error);
  return res.status(error.statusCode || 503).json({
    success: false,
    error: error.message || "PPPoE operation failed."
  });
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1" || value === "yes";
}

function clean(value, max = 255) {
  return String(value ?? "").trim().slice(0, max);
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
      const comment = user.comment || "";
      await client.query(
        `INSERT INTO pppoe_users
          (username, password, profile, service, caller_id, disabled, comment, phone, local_address, remote_address, router_id, raw_config, synced_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW(),NOW())
         ON CONFLICT (username) DO UPDATE SET
           password=COALESCE(EXCLUDED.password, pppoe_users.password), profile=EXCLUDED.profile, service=EXCLUDED.service,
           caller_id=EXCLUDED.caller_id, disabled=EXCLUDED.disabled, comment=EXCLUDED.comment,
           phone=COALESCE(NULLIF(EXCLUDED.phone,''), pppoe_users.phone), local_address=EXCLUDED.local_address,
           remote_address=EXCLUDED.remote_address, router_id=EXCLUDED.router_id, raw_config=EXCLUDED.raw_config,
           synced_at=NOW(), updated_at=NOW()`,
        [
          user.name, user.password, user.profile, user.service, user.callerId, user.disabled, comment,
          extractPhone(comment), user.localAddress, user.remoteAddress, routerId, JSON.stringify(user.raw || {})
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
      "all", "online", "offline", "active", "left", "expire",
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
      conditions.push("(u.expiry_date IS NULL OR u.expiry_date > NOW())");
      conditions.push("u.disabled = FALSE");
    } else if (filter === "left") {
      conditions.push("(LOWER(COALESCE(u.status, '')) IN ('disabled', 'left', 'terminated') OR u.disabled = TRUE)");
    } else if (filter === "expire") {
      conditions.push("u.expiry_date IS NOT NULL");
      conditions.push("u.expiry_date <= NOW()");
    } else if (filter === "expire_today_yesterday") {
      conditions.push("u.expiry_date IS NOT NULL");
      conditions.push("u.expiry_date BETWEEN (NOW() - INTERVAL '1 day') AND (NOW() + INTERVAL '1 day')");
    } else if (filter === "expire_7_days") {
      conditions.push("u.expiry_date IS NOT NULL");
      conditions.push("u.expiry_date BETWEEN NOW() AND (NOW() + INTERVAL '7 days')");
    } else if (filter === "new") {
      conditions.push("u.created_at >= NOW() - INTERVAL '7 days'");
    } else if (filter === "due") {
      conditions.push("(u.expiry_date IS NOT NULL AND u.expiry_date <= NOW()) OR LOWER(COALESCE(u.status, '')) IN ('disabled', 'left', 'terminated') OR u.disabled = TRUE");
    }

    const whereClause = conditions.length ? "WHERE " + conditions.map(c => "(" + c + ")").join(" AND ") : "";

    const result = await db.query(`
      SELECT u.*
      FROM pppoe_users u
      ${whereClause}
      ORDER BY u.username ASC
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
      const expired = Boolean(user.expiry_date && new Date(user.expiry_date).getTime() <= Date.now());
      return {
        ...user,
        active: Boolean(session),
        online: Boolean(session),
        session: session || null,
        session_ip: session?.address || null,
        session_uptime: session?.uptime || null,
        session_caller_id: session?.callerId || null,
        computed_status: expired ? "expired" : (session ? "online" : "offline")
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
    const result = await db.query("SELECT * FROM pppoe_profiles ORDER BY name ASC");
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

async function page(req, res) {
  res.render("pppoe", { title: "PPPoE Management", page: "pppoe" });
}

module.exports = { page, sync, users, profiles, active, createUser, updateUser, toggleUser, kickUser, createProfile };

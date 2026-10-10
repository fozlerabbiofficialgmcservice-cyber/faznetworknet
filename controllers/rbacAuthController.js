'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('../db');
const { getAdminCredentials } = require('../middleware/adminAuth');
const { normalizeRole } = require('../middleware/rbac');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

function hashOtp(userId, code) {
  const secret = String(process.env.OTP_HASH_SECRET || process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET || '');
  if (!secret) throw new Error('OTP_HASH_SECRET or ADMIN_SESSION_SECRET must be configured.');
  return crypto.createHmac('sha256', secret).update(String(userId) + ':' + String(code)).digest('hex');
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left || '')) || !/^[a-f0-9]{64}$/i.test(String(right || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function createMailer() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  if (!host || !user || !pass) throw new Error('Email OTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in Render.');
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host, port, secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
}

async function sendLoginNotification(user, loginType, req) {
  const mailerUrl = String(process.env.OTP_MAILER_URL || '').trim();
  const mailerToken = String(process.env.OTP_MAILER_TOKEN || '');
  const recipient = String(process.env.ADMIN_LOGIN_NOTIFICATION_EMAIL || 'faznetwork.com@gmail.com').trim();
  if (!mailerUrl || !mailerToken) {
    throw new Error('Apps Script mailer is not configured for login notifications.');
  }

  const endpoint = new URL(mailerUrl);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'script.google.com' ||
      !/^\/macros\/s\/[^/]+\/exec\/?$/.test(endpoint.pathname)) {
    throw new Error('OTP_MAILER_URL must be a Google Apps Script Web App /exec URL.');
  }
  if (mailerToken.length < 32) throw new Error('OTP_MAILER_TOKEN must be at least 32 characters.');

  const payload = {
    type: 'login_alert',
    token: mailerToken,
    to: recipient,
    username: String(user.username || 'unknown').slice(0, 60),
    role: String(user.role || 'staff').slice(0, 30),
    loginType: loginType === 'first_login' ? 'first_login' : 'login',
    loginAt: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: false }),
    timeZone: 'Asia/Dhaka',
    ipAddress: String(req?.ip || '').slice(0, 64) || 'Unavailable',
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 240) || 'Unavailable'
  };

  const response = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
    redirect: 'follow'
  });
  const responseText = await response.text();
  let result;
  try { result = JSON.parse(responseText); }
  catch { throw new Error('Apps Script login notification returned an invalid response.'); }
  if (!response.ok || result.success !== true) {
    throw new Error('Apps Script login notification failed: ' + String(result.error || 'request rejected').slice(0, 120));
  }
}

async function sendOtpEmail(user, code) {
  const mailerUrl = String(process.env.OTP_MAILER_URL || '').trim();
  const mailerToken = String(process.env.OTP_MAILER_TOKEN || '');

  // Prefer the HTTPS Apps Script mailer when configured. SMTP remains available
  // as a backwards-compatible fallback for paid/other hosting environments.
  if (mailerUrl || mailerToken) {
    if (!mailerUrl || !mailerToken) {
      throw new Error('Apps Script OTP mailer requires both OTP_MAILER_URL and OTP_MAILER_TOKEN.');
    }

    let endpoint;
    try {
      endpoint = new URL(mailerUrl);
    } catch {
      throw new Error('OTP_MAILER_URL is invalid.');
    }
    if (endpoint.protocol !== 'https:' ||
        endpoint.hostname !== 'script.google.com' ||
        !/^\/macros\/s\/[^/]+\/exec\/?$/.test(endpoint.pathname)) {
      throw new Error('OTP_MAILER_URL must be a Google Apps Script Web App /exec URL.');
    }
    if (mailerToken.length < 32) {
      throw new Error('OTP_MAILER_TOKEN must be at least 32 characters.');
    }

    let response;
    try {
      response = await fetch(endpoint.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: mailerToken, to: user.email, code }),
        signal: AbortSignal.timeout(20000),
        redirect: 'follow'
      });
    } catch (error) {
      throw new Error('Apps Script OTP mailer request failed: ' + String(error.name || 'network error'));
    }

    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error('Apps Script OTP mailer returned an invalid response.');
    }
    if (!response.ok || result.success !== true) {
      const safeError = String(result.error || 'request rejected').slice(0, 120);
      throw new Error('Apps Script OTP mailer failed: ' + safeError);
    }
    return;
  }

  const transporter = createMailer();
  const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  await transporter.sendMail({
    from, to: user.email,
    subject: 'FAZ NETWORK sign-in verification code',
    text: 'Hello ' + user.username + ',\n\nYour FAZ NETWORK first-login verification code is ' + code + '. It expires in 5 minutes. If you did not request this, contact your system administrator.\n\nDo not share this code.',
    html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2>FAZ NETWORK</h2><p>Hello ' + escapeHtml(user.username) + ',</p><p>Your first-login verification code is:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:16px;background:#f0fdf4;border-radius:10px;text-align:center">' + code + '</div><p>This code expires in <b>5 minutes</b>. Do not share it.</p><p>If you did not request this code, contact your system administrator.</p></div>'
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function safeNext(value) {
  const target = String(value || '/admin');
  return target.startsWith('/') && !target.startsWith('//') ? target : '/admin';
}

async function writeAudit(req, action, targetUserId, details) {
  try {
    await db.query('INSERT INTO admin_audit_logs (actor_user_id,actor_username,actor_role,action,target_user_id,details,ip_address) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)', [req.session?.userId || null, String(req.session?.adminUser || 'admin'), String(req.session?.role || (req.session?.legacySuperAdmin ? 'super_admin' : 'super_admin')), action, targetUserId || null, JSON.stringify(details || {}), String(req.ip || '').slice(0,64) || null]);
  } catch (error) { console.warn('[RBAC audit] Could not write audit record:', error.message); }
}

function establishSession(req, res, user, nextTarget, loginType = 'login') {
  req.session.regenerate(err => {
    if (err) {
      console.error('[RBAC] Session regeneration failed:', err.message);
      return res.status(500).render('login', { next: safeNext(nextTarget), error: 'Could not initialize a secure session. Please retry.' });
    }
    req.session.isAdmin = true;
    req.session.adminUser = user.username;
    req.session.role = user.role;
    req.session.userId = user.id || null;
    req.session.legacySuperAdmin = user.legacy === true;
    req.session.loginAt = Date.now();
    req.session.save(async saveErr => {
      if (saveErr) {
        console.error('[RBAC] Session save failed:', saveErr.message);
        return res.status(500).render('login', { next: safeNext(nextTarget), error: 'Could not save your session. Please retry.' });
      }
      if (user.completeFirstLogin) {
        try {
          await db.query('UPDATE admin_users SET is_first_login=FALSE, otp_code_hash=NULL, otp_expires_at=NULL, otp_attempts=0, last_login_at=NOW(), updated_at=NOW() WHERE id=$1', [user.id]);
        } catch (error) {
          console.error('[RBAC OTP] Could not finalize first login:', error.message);
          return req.session.destroy(() => res.status(503).render('verify-otp', { error: 'Could not finalize verification. Please sign in and request a new code.' }));
        }
      } else if (user.id) {
        db.query('UPDATE admin_users SET last_login_at=NOW(), updated_at=NOW() WHERE id=$1', [user.id]).catch(() => {});
      }
      if (user.id && user.legacy !== true) {
        sendLoginNotification(user, loginType, req).catch(error => {
          console.error('[RBAC login alert] Email delivery failed:', error.message);
        });
      }
      return res.redirect(safeNext(nextTarget));
    });
  });
}

async function login(req, res) {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const nextTarget = safeNext(req.body?.next);
  if (!username || !password) return res.status(400).render('login', { next: nextTarget, error: 'Enter your username and password.' });

  // Preserve the configured shared credential as a permanent super-admin login,
  // even if an individual account later uses the same username.
  const { ADMIN_USER } = getAdminCredentials();
  const legacy = require('../middleware/adminAuth');
  if (username.toLowerCase() === ADMIN_USER.toLowerCase() && await legacy.adminCredentialsValid(username, password)) {
    return establishSession(req, res, { id: null, username, role: 'super_admin', legacy: true }, nextTarget);
  }

  try {
    const result = await db.query(
      'SELECT id, username, email, password_hash, role, is_first_login, status FROM admin_users WHERE lower(username)=lower($1) LIMIT 1',
      [username]
    );
    const user = result.rows?.[0];
    if (user) {
      if (String(user.status).toLowerCase() !== 'active' || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).render('login', { next: nextTarget, error: 'Invalid username or password, or account is inactive.' });
      }
      if (user.is_first_login === true) {
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        const expiresAt = new Date(Date.now() + OTP_TTL_MS);
        const codeHash = hashOtp(user.id, code);
        await db.query('UPDATE admin_users SET otp_code_hash=$1, otp_expires_at=$2, otp_attempts=0, updated_at=NOW() WHERE id=$3', [codeHash, expiresAt, user.id]);
        try {
          await sendOtpEmail(user, code);
        } catch (mailError) {
          await db.query('UPDATE admin_users SET otp_code_hash=NULL, otp_expires_at=NULL WHERE id=$1', [user.id]).catch(() => {});
          console.error('[RBAC OTP] Email delivery failed:', mailError.message);
          return res.status(503).render('login', { next: nextTarget, error: 'Verification email could not be sent. Contact the administrator; no session was created.' });
        }
        req.session.pendingOtpUserId = user.id;
        req.session.pendingOtpNext = nextTarget;
        req.session.pendingOtpIssuedAt = Date.now();
        req.session.pendingOtpAttempts = 0;
        return req.session.save(err => {
          if (err) return res.status(500).render('login', { next: nextTarget, error: 'Could not start verification. Please retry.' });
          return res.redirect('/login/verify-otp');
        });
      }
      return establishSession(req, res, { id: user.id, username: user.username, role: normalizeRole(user.role) }, nextTarget);
    }
  } catch (error) {
    // Fail closed for database-backed users; only the configured legacy shared account may use fallback.
    if (!/relation "admin_users" does not exist/i.test(String(error.message || ''))) {
      console.error('[RBAC] User lookup failed:', error.message);
      return res.status(503).render('login', { next: nextTarget, error: 'Authentication service is temporarily unavailable. Please retry.' });
    }
  }

  return res.status(401).render('login', { next: nextTarget, error: 'Invalid username or password.' });
}

function showOtp(req, res) {
  if (!req.session?.pendingOtpUserId) return res.redirect('/login');
  return res.render('verify-otp', { error: null });
}

async function verifyOtp(req, res) {
  const userId = req.session?.pendingOtpUserId;
  if (!userId) return res.redirect('/login');
  if (Number(req.session.pendingOtpAttempts || 0) >= MAX_OTP_ATTEMPTS) {
    await db.query('UPDATE admin_users SET otp_code_hash=NULL, otp_expires_at=NULL WHERE id=$1', [userId]).catch(() => {});
    return req.session.destroy(() => res.redirect('/login'));
  }
  const code = String(req.body?.otp || '').trim();
  if (!/^\d{6}$/.test(code)) {
    req.session.pendingOtpAttempts = Number(req.session.pendingOtpAttempts || 0) + 1;
    return req.session.save(() => res.status(400).render('verify-otp', { error: 'Enter the 6-digit code sent to your email.' }));
  }
  try {
    const result = await db.query('SELECT id, username, email, role, is_first_login, otp_code_hash, otp_expires_at, otp_attempts, status FROM admin_users WHERE id=$1 LIMIT 1', [userId]);
    const user = result.rows?.[0];
    if (user && Number(user.otp_attempts || 0) >= MAX_OTP_ATTEMPTS) {
      await db.query('UPDATE admin_users SET otp_code_hash=NULL, otp_expires_at=NULL WHERE id=$1', [userId]);
      return req.session.destroy(() => res.redirect('/login'));
    }
    const valid = user && user.status === 'active' && user.is_first_login === true &&
      user.otp_code_hash && user.otp_expires_at && new Date(user.otp_expires_at).getTime() > Date.now() &&
      safeEqualHex(user.otp_code_hash, hashOtp(userId, code));
    if (!valid) {
      req.session.pendingOtpAttempts = Number(req.session.pendingOtpAttempts || 0) + 1;
      await db.query('UPDATE admin_users SET otp_attempts=otp_attempts+1, otp_code_hash=CASE WHEN otp_attempts+1 >= $2 THEN NULL ELSE otp_code_hash END, otp_expires_at=CASE WHEN otp_attempts+1 >= $2 THEN NULL ELSE otp_expires_at END WHERE id=$1', [userId, MAX_OTP_ATTEMPTS]).catch(() => {});
      await req.session.save(() => {});
      return res.status(400).render('verify-otp', { error: 'Invalid or expired code. Check the email and try again.' });
    }
    const nextTarget = safeNext(req.session.pendingOtpNext);
    // Consume the OTP but keep first-login status pending until the user sets
    // a personal password. Do not grant an admin session at this stage.
    await db.query('UPDATE admin_users SET otp_code_hash=NULL, otp_expires_at=NULL, otp_attempts=0, updated_at=NOW() WHERE id=$1 AND is_first_login=TRUE', [user.id]);
    return req.session.regenerate(err => {
      if (err) {
        console.error('[RBAC] Password-setup session regeneration failed:', err.message);
        return res.status(500).render('verify-otp', { error: 'Verification succeeded, but secure setup could not start. Please sign in again.' });
      }
      req.session.pendingPasswordUserId = user.id;
      req.session.pendingPasswordNext = nextTarget;
      req.session.passwordOtpVerifiedAt = Date.now();
      return req.session.save(saveErr => {
        if (saveErr) {
          console.error('[RBAC] Password-setup session save failed:', saveErr.message);
          return res.status(500).render('verify-otp', { error: 'Could not start password setup. Please sign in again.' });
        }
        return res.redirect('/login/set-password');
      });
    });
  } catch (error) {
    console.error('[RBAC OTP] Verification failed:', error.message);
    return res.status(503).render('verify-otp', { error: 'Verification service is unavailable. Please retry.' });
  }
}

function showSetPassword(req, res) {
  const verifiedAt = Number(req.session?.passwordOtpVerifiedAt || 0);
  if (!req.session?.pendingPasswordUserId || !verifiedAt) return res.redirect('/login');
  if (Date.now() - verifiedAt > 10 * 60 * 1000) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  return res.set('Cache-Control', 'no-store').render('set-first-password', { error: null });
}

async function setFirstPassword(req, res) {
  const userId = req.session?.pendingPasswordUserId;
  const verifiedAt = Number(req.session?.passwordOtpVerifiedAt || 0);
  if (!userId || !verifiedAt) return res.redirect('/login');
  if (Date.now() - verifiedAt > 10 * 60 * 1000) {
    return req.session.destroy(() => res.redirect('/login'));
  }

  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');
  if (password.length < 12 || password.length > 128) {
    return res.status(400).render('set-first-password', { error: 'Use a new password between 12 and 128 characters.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).render('set-first-password', { error: 'The new password and confirmation do not match.' });
  }

  try {
    const result = await db.query(
      "SELECT id, username, email, password_hash, role, is_first_login, status FROM admin_users WHERE id=$1 LIMIT 1",
      [userId]
    );
    const user = result.rows?.[0];
    if (!user || user.status !== 'active' || user.is_first_login !== true) {
      return req.session.destroy(() => res.redirect('/login'));
    }
    if (await bcrypt.compare(password, user.password_hash)) {
      return res.status(400).render('set-first-password', { error: 'Choose a password different from the temporary password provided by the administrator.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const updated = await db.query(
      "UPDATE admin_users SET password_hash=$1, is_first_login=FALSE, otp_code_hash=NULL, otp_expires_at=NULL, otp_attempts=0, last_login_at=NOW(), updated_at=NOW() WHERE id=$2 AND is_first_login=TRUE AND status='active' RETURNING id",
      [passwordHash, userId]
    );
    if (!updated.rows.length) {
      return res.status(409).render('set-first-password', { error: 'This account has already been updated. Please sign in with your new password.' });
    }
    const nextTarget = safeNext(req.session.pendingPasswordNext);
    return establishSession(req, res, { id: user.id, username: user.username, role: normalizeRole(user.role) }, nextTarget, 'first_login');
  } catch (error) {
    console.error('[RBAC] First-login password change failed:', error.message);
    return res.status(503).render('set-first-password', { error: 'Could not save your new password. Please retry.' });
  }
}

async function listUsers(req, res) {
  try {
    const role = req.auth?.role;
    const result = role === 'super_admin'
      ? await db.query('SELECT id, username, email, role, is_first_login, status, last_login_at, created_at FROM admin_users ORDER BY created_at ASC, id ASC')
      : await db.query("SELECT id, username, email, role, is_first_login, status, last_login_at, created_at FROM admin_users WHERE role='staff' ORDER BY created_at ASC, id ASC");
    return res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('[RBAC] Listing users failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load user list.' });
  }
}

async function createUser(req, res) {
  const username = String(req.body?.username || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const role = normalizeRole(req.body?.role);
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(username)) return res.status(400).json({ success: false, message: 'Username must be 3-60 characters (letters, numbers, dot, underscore or hyphen).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  if (password.length < 12 || password.length > 128) return res.status(400).json({ success: false, message: 'Use a password between 12 and 128 characters.' });
  if (!role) return res.status(400).json({ success: false, message: 'Select a valid role.' });
  if (req.auth?.role === 'admin' && role !== 'staff') return res.status(403).json({ success: false, message: 'Admins may create staff accounts only.' });
  if (req.auth?.role !== 'super_admin' && role === 'super_admin') return res.status(403).json({ success: false, message: 'Only a super admin may create a super admin account.' });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query(
      "INSERT INTO admin_users (username,email,password_hash,role,is_first_login,status,created_by) VALUES ($1,$2,$3,$4,TRUE,'active',$5) RETURNING id,username,email,role,is_first_login,status,created_at",
      [username, email, passwordHash, role, req.session.adminUser || 'admin']
    );
    await writeAudit(req, 'admin_user_created', result.rows[0].id, { username, email, role });
    return res.status(201).json({ success: true, user: result.rows[0], message: 'Account created. The user must verify the emailed OTP on first login.' });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Username or email is already registered.' });
    console.error('[RBAC] User creation failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to create account.' });
  }
}

async function updateUserStatus(req, res) {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '').toLowerCase();
  if (!Number.isSafeInteger(id) || id < 1 || !['active', 'disabled'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid user or status.' });
  try {
    const target = await db.query('SELECT id, role FROM admin_users WHERE id=$1 LIMIT 1', [id]);
    if (!target.rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    if (req.auth?.role !== 'super_admin' && req.auth?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'You do not have permission to change account status.' });
    }
    if (req.auth?.role === 'admin' && target.rows[0].role !== 'staff') {
      return res.status(403).json({ success: false, message: 'Admins may manage staff accounts only.' });
    }
    if (req.session.userId && Number(req.session.userId) === id && status === 'disabled') return res.status(400).json({ success: false, message: 'You cannot disable your own account.' });
    const result = await db.query('UPDATE admin_users SET status=$1, updated_at=NOW(), otp_code_hash=NULL, otp_expires_at=NULL WHERE id=$2 RETURNING id,username,email,role,status', [status, id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    await writeAudit(req, 'admin_user_status_changed', id, { status });
    return res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('[RBAC] Status update failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update account status.' });
  }
}


async function deleteUser(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ success: false, message: 'Invalid user ID.' });
  }
  if (req.session.userId && Number(req.session.userId) === id) {
    return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
  }
  try {
    const targetResult = await db.query('SELECT id, username, role FROM admin_users WHERE id=$1 LIMIT 1', [id]);
    const target = targetResult.rows?.[0];
    if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    // The legacy owner session is the only super-admin identity that is
    // not stored in admin_users. Owner can remove stale DB-backed super_admin
    // rows; ordinary Admin accounts remain restricted to Staff.
    if (req.auth?.role === 'admin' && target.role !== 'staff') {
      return res.status(403).json({ success: false, message: 'Admins may delete staff accounts only.' });
    }
    if (req.auth?.role !== 'super_admin' && req.auth?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'You do not have permission to delete accounts.' });
    }
    const result = req.auth?.role === 'super_admin'
      ? await db.query('DELETE FROM admin_users WHERE id=$1 RETURNING id, username, role', [id])
      : await db.query("DELETE FROM admin_users WHERE id=$1 AND role='staff' RETURNING id, username, role", [id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'User was not found or has already been deleted.' });
    await writeAudit(req, 'admin_user_deleted', id, { username: target.username, role: target.role });
    return res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({ success: false, message: 'This account is still referenced by support or audit records and cannot be deleted safely. Disable the account instead.' });
    }
    console.error('[RBAC] User deletion failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to delete account.' });
  }
}

module.exports = { login, showOtp, verifyOtp, showSetPassword, setFirstPassword, listUsers, createUser, updateUserStatus, deleteUser };

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

async function sendOtpEmail(user, code) {
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

function establishSession(req, res, user, nextTarget) {
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
      return res.redirect(safeNext(nextTarget));
    });
  });
}

async function login(req, res) {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const nextTarget = safeNext(req.body?.next);
  if (!username || !password) return res.status(400).render('login', { next: nextTarget, error: 'Enter your username and password.' });

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

  const { ADMIN_USER } = getAdminCredentials();
  const legacy = require('../middleware/adminAuth');
  if (username.toLowerCase() === ADMIN_USER.toLowerCase() && await legacy.adminCredentialsValid(username, password)) {
    return establishSession(req, res, { id: null, username, role: 'super_admin', legacy: true }, nextTarget);
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
    return establishSession(req, res, { id: user.id, username: user.username, role: normalizeRole(user.role), completeFirstLogin: true }, nextTarget);
  } catch (error) {
    console.error('[RBAC OTP] Verification failed:', error.message);
    return res.status(503).render('verify-otp', { error: 'Verification service is unavailable. Please retry.' });
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
    await writeAudit(req, 'admin_user_created', result.rows[0].id, { username, email, role });\n    return res.status(201).json({ success: true, user: result.rows[0], message: 'Account created. The user must verify the emailed OTP on first login.' });
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
    if (req.auth?.role === 'admin') {
      const owned = await db.query("SELECT id FROM admin_users WHERE id=$1 AND role='staff'", [id]);
      if (!owned.rows.length) return res.status(403).json({ success: false, message: 'Admins may manage staff accounts only.' });
    }
    if (req.session.userId && Number(req.session.userId) === id && status === 'disabled') return res.status(400).json({ success: false, message: 'You cannot disable your own account.' });
    const result = await db.query('UPDATE admin_users SET status=$1, updated_at=NOW(), otp_code_hash=NULL, otp_expires_at=NULL WHERE id=$2 RETURNING id,username,email,role,status', [status, id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('[RBAC] Status update failed:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update account status.' });
  }
}

module.exports = { login, showOtp, verifyOtp, listUsers, createUser, updateUserStatus };

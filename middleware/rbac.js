'use strict';

const ROLES = Object.freeze(['super_admin', 'admin', 'staff']);

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return ROLES.includes(value) ? value : null;
}

function currentRole(req) {
  // The legacy shared credential intentionally remains a super-admin session.
  if (req.session?.legacySuperAdmin === true) return 'super_admin';
  if (req.session?.isAdmin === true && !req.session?.role && !req.session?.userId) return 'super_admin';
  return normalizeRole(req.session?.role);
}

function requireRole(allowedRoles) {
  const allowed = (Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles])
    .map(normalizeRole).filter(Boolean);
  return function roleGuard(req, res, next) {
    if (!req.session?.isAdmin) {
      const api = String(req.originalUrl || '').startsWith('/api/');
      return api
        ? res.status(401).json({ success: false, message: 'Authentication required' })
        : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || '/admin'));
    }
    const role = currentRole(req);
    if (!role || !allowed.includes(role)) {
      return res.status(403).json({ success: false, message: 'Forbidden: insufficient role permissions' });
    }
    req.auth = { ...(req.auth || {}), role, userId: req.session.userId || null, username: req.session.adminUser || '' };
    return next();
  };
}

function requireStaffReadOnly(req, res, next) {
  const role = currentRole(req);
  if (role === 'staff' && !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase())) {
    return res.status(403).json({ success: false, message: 'Staff accounts are read-only for this resource' });
  }
  return next();
}

module.exports = { ROLES, normalizeRole, currentRole, requireRole, requireStaffReadOnly };

'use strict';

const db = require('../db');
const { validatePublicIp, validateEndpointHost, validatePortForward } = require('../services/networkAccessValidation');

function fail(res, error, status = 500) {
  console.error('[Network Access]', error?.message || error);
  return res.status(status).json({ success: false, message: error?.message || 'Network access operation failed.' });
}

async function audit(req, action, details) {
  try {
    await db.query(
      'INSERT INTO admin_audit_logs(actor_user_id,actor_username,actor_role,action,details,ip_address) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
      [req.auth?.userId || null, String(req.auth?.username || req.session?.adminUser || 'admin').slice(0,100), String(req.auth?.role || req.session?.role || 'super_admin'), action, JSON.stringify(details || {}), String(req.ip || '').slice(0,64) || null]
    );
  } catch (error) {
    throw new Error('Configuration was not saved because the audit log could not be written.');
  }
}

exports.getOverview = async (req, res) => {
  try {
    const [publicIp, rules, vpn] = await Promise.all([
      db.query('SELECT id,label,public_ip::text AS "publicIp",assignment_method AS "assignmentMethod",wan_interface AS "wanInterface",enabled,updated_at AS "updatedAt" FROM public_ip_configs ORDER BY id DESC LIMIT 1'),
      db.query('SELECT id,name,protocol,external_port AS "externalPort",destination_ip::text AS "destinationIp",internal_port AS "internalPort",allowed_source_ip::text AS "allowedSourceIp",enabled,status,last_error AS "lastError",created_at AS "createdAt" FROM port_forward_rules ORDER BY id DESC'),
      db.query('SELECT id,name,provider,role,status,endpoint_host AS "endpointHost",endpoint_port AS "endpointPort",updated_at AS "updatedAt" FROM vpn_profiles ORDER BY id DESC')
    ]);
    const ip = publicIp.rows[0] || null;
    const hasPublicIp = Boolean(ip?.publicIp && ip.enabled);
    res.json({
      success: true,
      publicIp: ip,
      portForwardRules: rules.rows,
      vpnProfiles: vpn.rows,
      readiness: {
        publicIpConfigured: hasPublicIp,
        portForwardingReady: hasPublicIp ? 'needs_router_validation' : 'waiting_for_public_ip',
        wireguard: 'pending_endpoint',
        message: hasPublicIp ? 'Public IP saved. Router WAN ownership, routing, firewall and upstream NAT still need verification.' : 'No public IP is configured. Add one later; no live VPN or port-forwarding changes have been applied.'
      }
    });
  } catch (error) { return fail(res, error); }
};

exports.savePublicIp = async (req, res) => {
  try {
    const body = req.body || {};
    const label = String(body.label ?? 'Primary public IP').trim().slice(0, 120) || 'Primary public IP';
    const assignmentMethod = String(body.assignmentMethod ?? 'static').trim().toLowerCase();
    const wanInterface = String(body.wanInterface ?? '').trim().slice(0, 120);
    const parsed = validatePublicIp(body.publicIp);
    if (parsed.error) return fail(res, new Error(parsed.error), 400);
    if (!['static','dynamic','upstream_forwarded','tunnel'].includes(assignmentMethod)) return fail(res, new Error('Select a supported IP assignment method.'), 400);
    if (assignmentMethod !== 'tunnel' && !parsed.value) return fail(res, new Error('Public IP is required for this assignment method.'), 400);
    const enabled = body.enabled !== false;
    const existing = await db.query('SELECT id FROM public_ip_configs ORDER BY id DESC LIMIT 1');
    let result;
    if (existing.rowCount) {
      result = await db.query(
        'UPDATE public_ip_configs SET label=$1,public_ip=$2::inet,assignment_method=$3,wan_interface=$4,enabled=$5,updated_at=NOW() WHERE id=$6 RETURNING id,label,public_ip::text AS "publicIp",assignment_method AS "assignmentMethod",wan_interface AS "wanInterface",enabled,updated_at AS "updatedAt"',
        [label, parsed.value, assignmentMethod, wanInterface || null, enabled, existing.rows[0].id]
      );
    } else {
      result = await db.query(
        'INSERT INTO public_ip_configs(label,public_ip,assignment_method,wan_interface,enabled) VALUES($1,$2::inet,$3,$4,$5) RETURNING id,label,public_ip::text AS "publicIp",assignment_method AS "assignmentMethod",wan_interface AS "wanInterface",enabled,updated_at AS "updatedAt"',
        [label, parsed.value, assignmentMethod, wanInterface || null, enabled]
      );
    }
    await audit(req, 'network_access.public_ip_saved', { assignmentMethod, publicIpConfigured: Boolean(parsed.value), wanInterface: wanInterface || null });
    return res.json({ success: true, publicIp: result.rows[0], message: 'Public IP settings saved. Router reachability and upstream NAT are not yet verified.' });
  } catch (error) { return fail(res, error); }
};

exports.createPortForward = async (req, res) => {
  try {
    const parsed = validatePortForward(req.body || {});
    if (parsed.error) return fail(res, new Error(parsed.error), 400);
    const publicIp = await db.query('SELECT id,enabled FROM public_ip_configs ORDER BY id DESC LIMIT 1');
    const data = parsed.value;
    const status = publicIp.rows[0]?.enabled ? 'pending_validation' : 'waiting_for_public_ip';
    const result = await db.query(
      'INSERT INTO port_forward_rules(name,protocol,external_port,destination_ip,internal_port,allowed_source_ip,enabled,status) VALUES($1,$2,$3,$4::inet,$5,$6::inet,FALSE,$7) RETURNING id,name,protocol,external_port AS "externalPort",destination_ip::text AS "destinationIp",internal_port AS "internalPort",allowed_source_ip::text AS "allowedSourceIp",enabled,status',
      [data.name,data.protocol,data.externalPort,data.destinationIp,data.internalPort,data.allowedSourceIp,status]
    );
    await audit(req, 'network_access.port_forward_rule_created', { id: result.rows[0].id, protocol: data.protocol, externalPort: data.externalPort, destinationIp: data.destinationIp, internalPort: data.internalPort });
    return res.status(201).json({ success: true, rule: result.rows[0], message: 'Rule saved as disabled. It will not change MikroTik firewall/NAT until validation and explicit apply are implemented.' });
  } catch (error) {
    if (error?.code === '23505') return fail(res, new Error('This external port/protocol already has a rule.'), 409);
    return fail(res, error);
  }
};

exports.deletePortForward = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return fail(res, new Error('Invalid rule ID.'), 400);
    const result = await db.query('DELETE FROM port_forward_rules WHERE id=$1 RETURNING id,name', [id]);
    if (!result.rowCount) return fail(res, new Error('Port-forward rule not found.'), 404);
    await audit(req, 'network_access.port_forward_rule_deleted', { id, name: result.rows[0].name });
    return res.json({ success: true, deletedId: id, message: 'Saved rule deleted. No RouterOS configuration was changed.' });
  } catch (error) { return fail(res, error); }
};

exports.createVpnProfile = async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name ?? '').trim().slice(0, 120);
    const provider = String(body.provider ?? 'wireguard').trim().toLowerCase();
    const role = String(body.role ?? 'management_access').trim().toLowerCase();
    if (!name) return fail(res, new Error('VPN profile name is required.'), 400);
    if (!['wireguard'].includes(provider)) return fail(res, new Error('The first test phase supports WireGuard profile planning only.'), 400);
    if (!['management_access'].includes(role)) return fail(res, new Error('Only management-access split-tunnel profiles are allowed in this phase.'), 400);
    const parsedHost = validateEndpointHost(body.endpointHost);
    if (parsedHost.error) return fail(res, new Error(parsedHost.error), 400);
    const endpointHost = parsedHost.value;
    const endpointPort = body.endpointPort === '' || body.endpointPort == null ? null : Number(body.endpointPort);
    if (endpointPort != null && (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535)) return fail(res, new Error('VPN endpoint port must be from 1 to 65535.'), 400);
    const result = await db.query(
      'INSERT INTO vpn_profiles(name,provider,role,status,endpoint_host,endpoint_port) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,provider,role,status,endpoint_host AS "endpointHost",endpoint_port AS "endpointPort",updated_at AS "updatedAt"',
      [name,provider,role,'pending_endpoint',endpointHost,endpointPort]
    );
    await audit(req, 'network_access.vpn_profile_created', { id: result.rows[0].id, provider, role });
    return res.status(201).json({ success: true, profile: result.rows[0], message: 'Profile saved. A reachable WireGuard endpoint and peer keys are required before a live tunnel can be tested.' });
  } catch (error) {
    if (error?.code === '23505') return fail(res, new Error('A VPN profile with this name already exists.'), 409);
    return fail(res, error);
  }
};

exports.deleteVpnProfile = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return fail(res, new Error('Invalid VPN profile ID.'), 400);
    const result = await db.query('DELETE FROM vpn_profiles WHERE id=$1 RETURNING id,name', [id]);
    if (!result.rowCount) return fail(res, new Error('VPN profile not found.'), 404);
    await audit(req, 'network_access.vpn_profile_deleted', { id, name: result.rows[0].name });
    return res.json({ success: true, deletedId: id });
  } catch (error) { return fail(res, error); }
};

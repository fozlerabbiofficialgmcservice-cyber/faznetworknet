'use strict';
const http = require('node:http');
const https = require('node:https');
const db = require('../db');
const olt = require('../services/oltManagementService');

function sendError(res, error) {
  console.error('[OLT Management]', error?.message || error);
  return res.status(error?.statusCode || 500).json({ success:false, message:error?.message || 'OLT operation failed.' });
}
async function audit(req, action, details) {
  await db.query(
    'INSERT INTO admin_audit_logs(actor_user_id,actor_username,actor_role,action,details,ip_address) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
    [req.auth?.userId || null, String(req.auth?.username || req.session?.adminUser || 'admin').slice(0,100), String(req.auth?.role || req.session?.role || 'admin'), action, JSON.stringify(details || {}), String(req.ip || '').slice(0,64) || null]
  );
}
async function currentConfig() {
  const result = await db.query('SELECT id,name,management_ip::text AS "managementIp",protocol,access_method AS "accessMethod",port,username,encrypted_password IS NOT NULL AS "hasPassword",CASE WHEN connection_status='connected' THEN 'not_tested' ELSE connection_status END AS "connectionStatus",last_test_at AS "lastTestAt",last_http_status AS "lastHttpStatus",last_error AS "lastError",updated_at AS "updatedAt" FROM olt_connections WHERE id=1');
  return result.rows[0] || null;
}
exports.getConfig = async (req,res) => {
  try { return res.json({success:true, config:await currentConfig()}); }
  catch(error) { return sendError(res,error); }
};
exports.saveConfig = async (req,res) => {
  try {
    const parsed = olt.validateConfig(req.body || {});
    if (parsed.error) return res.status(400).json({success:false,message:parsed.error});
    const c = parsed.value;
    const current = await db.query('SELECT encrypted_password FROM olt_connections WHERE id=1');
    const passwordCipher = c.password ? olt.encrypt(c.password) : (current.rows[0]?.encrypted_password || null);
    if (c.username && !passwordCipher) return res.status(400).json({success:false,message:'Enter the OLT password before saving credentials.'});
    await db.withTransaction(async client => {
      await client.query(
        `INSERT INTO olt_connections(id,name,management_ip,protocol,access_method,port,username,encrypted_password,connection_status,last_test_at,last_http_status,last_error,updated_at)
         VALUES(1,$1,$2::inet,$3,$4,$5,$6,$7,'not_tested',NULL,NULL,NULL,NOW())
         ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,management_ip=EXCLUDED.management_ip,protocol=EXCLUDED.protocol,access_method=EXCLUDED.access_method,port=EXCLUDED.port,username=EXCLUDED.username,encrypted_password=EXCLUDED.encrypted_password,connection_status='not_tested',last_test_at=NULL,last_http_status=NULL,last_error=NULL,updated_at=NOW()`,
        [c.name,c.managementIp,c.protocol,c.accessMethod,c.port,c.username || null,passwordCipher]
      );
      await client.query(
        'INSERT INTO admin_audit_logs(actor_user_id,actor_username,actor_role,action,details,ip_address) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
        [req.auth?.userId || null,String(req.auth?.username || req.session?.adminUser || 'admin').slice(0,100),String(req.auth?.role || req.session?.role || 'admin'),'olt.connection_settings_saved',JSON.stringify({managementIp:c.managementIp,protocol:c.protocol,port:c.port,credentialsConfigured:Boolean(passwordCipher)}),String(req.ip || '').slice(0,64)||null]
      );
    });
    return res.json({success:true,message:'OLT settings saved securely. Run Test Connection to verify reachability; credentials have not been authenticated yet.',config:await currentConfig()});
  } catch(error) { return sendError(res,error); }
};
function probe(url) {
  return new Promise((resolve,reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {method:'GET',timeout:4500,headers:{'User-Agent':'FAZ-NETWORK-OLT-HealthCheck/1.0','Accept':'text/html,application/xhtml+xml,*/*'},rejectUnauthorized:true}, response => {
      const statusCode = response.statusCode || 0;
      response.destroy();
      if (statusCode >= 300 && statusCode < 400) return reject(new Error('OLT web interface redirected the test request. Configure the correct HTTP/HTTPS scheme and port.'));
      if (statusCode >= 200 && statusCode < 500) return resolve(statusCode);
      reject(new Error('OLT web interface returned HTTP ' + statusCode + '.'));
    });
    req.on('timeout',()=>req.destroy(new Error('Connection timed out. The OLT may be unreachable from the Render server or the port/protocol may be incorrect.')));
    req.on('error',reject);
    req.end();
  });
}
exports.testConnection = async (req,res) => {
  try {
    const config = await currentConfig();
    if (!config) return res.status(400).json({success:false,message:'Save OLT management settings first.'});
    const checkedAt = new Date();
    let status = 'unreachable', httpStatus = null, errorMessage = null, detectedProtocol = null;
    const methods = config.accessMethod === 'detect' ? ['https','http'] : [config.accessMethod || config.protocol];
    let lastProbeError = null;
    for (const method of methods) {
      try {
        const url = new URL(method + '://' + config.managementIp + ':' + config.port + '/');
        httpStatus = await probe(url);
        detectedProtocol = method;
        break;
      } catch(error) { lastProbeError = error; }
    }
    if (detectedProtocol) {
      status = 'reachable_unverified';
      errorMessage = 'Web endpoint responded over ' + detectedProtocol.toUpperCase() + ', but OLT login credentials and the V-SOL authentication/API handshake are not verified. This is not Connected.';
    } else {
      errorMessage = String(lastProbeError?.message || 'No supported web protocol responded.').slice(0,500);
    }
    await db.withTransaction(async client => {
      await client.query('UPDATE olt_connections SET connection_status=$1,protocol=COALESCE($5,protocol),last_test_at=$2,last_http_status=$3,last_error=$4,updated_at=NOW() WHERE id=1',[status,checkedAt,httpStatus,errorMessage,detectedProtocol]);
      await client.query(
        'INSERT INTO admin_audit_logs(actor_user_id,actor_username,actor_role,action,details,ip_address) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
        [req.auth?.userId || null,String(req.auth?.username || req.session?.adminUser || 'admin').slice(0,100),String(req.auth?.role || req.session?.role || 'admin'),'olt.connection_tested',JSON.stringify({status,httpStatus,detectedProtocol,error:errorMessage}),String(req.ip || '').slice(0,64)||null]
      );
    });
    return res.json({success:true,status,httpStatus,detectedProtocol,checkedAt:checkedAt.toISOString(),message:errorMessage});
  } catch(error) { return sendError(res,error); }
};

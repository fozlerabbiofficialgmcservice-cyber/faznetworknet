const db = require("../db");
const mikrotikService = require("../services/mikrotikService");

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

function bangladeshToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Dhaka", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
}
function addBangladeshCalendarMonth(dateString) {
  const raw=normalizeDate(dateString)||bangladeshToday();
  const [year,month,day]=raw.split("-").map(Number);
  const targetYear=year+Math.floor(month/12), targetMonth=month%12;
  const lastDay=new Date(Date.UTC(targetYear,targetMonth+1,0)).getUTCDate();
  return [targetYear,String(targetMonth+1).padStart(2,"0"),String(Math.min(day,lastDay)).padStart(2,"0")].join("-");
}
function dateStatus(expirationDate) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const expDate = new Date(String(expirationDate || "") + "T00:00:00Z");
  expDate.setUTCHours(0, 0, 0, 0);
  return expDate.getTime() < today.getTime() ? "expired" : "active";
}

function effectiveProfile(profile, expirationDate) {
  return dateStatus(expirationDate) === "expired" ? clean(process.env.EXPIRED_PROFILE_NAME || "EXPIRED", 100) : clean(profile, 100);
}

function buildExpirationComment(fullName, phone, expirationDate, remarks) {
  const parts = [];
  if (fullName) parts.push("Customer: " + fullName);
  if (phone) parts.push("Phone: " + phone);
  parts.push("EXP: " + expirationDate);
  if (remarks) parts.push("Note: " + remarks);
  return parts.join(" | ").slice(0, 500);
}

function extractExpirationDate(comment) {
  const match = String(comment || "").match(/(?:^|[|;\\s])EXP:\\s*(\\d{4}-\\d{2}-\\d{2})/i);
  return match ? normalizeDate(match[1]) : "";
}

async function resolvePackageDefinition(profile, packageName = "") {
  const selectedProfile=clean(profile,100),selectedPackage=clean(packageName,100);
  if(!selectedProfile&&!selectedPackage)return null;
  const r=await db.query("SELECT id,plan_name,pool_name,rate_limit,price,duration_months,profile_name FROM packages WHERE LOWER(plan_name)=LOWER($1) OR LOWER(profile_name)=LOWER($1) OR LOWER(plan_name)=LOWER($2) OR LOWER(profile_name)=LOWER($2) LIMIT 1",[selectedPackage,selectedProfile]);
  if(!r.rows.length)return null;const x=r.rows[0];return {id:x.id,name:clean(x.plan_name,100),profileName:clean(x.profile_name,100),price:Number(x.price||0),durationMonths:Math.max(1,Number(x.duration_months||1)),poolName:clean(x.pool_name,100),rateLimit:clean(x.rate_limit,100)};
}
async function packages(req,res){try{const r=await db.query("SELECT plan_name AS name,plan_name AS profile,price,pool_name,rate_limit,duration_months,profile_name FROM packages ORDER BY plan_name ASC");let pools=[];try{pools=await mikrotikService.getIpPools();}catch(e){}const map=new Map((Array.isArray(pools)?pools:[]).map(x=>[String(x.name||"").toLowerCase(),x]));return res.json({success:true,packages:r.rows.map(x=>{const pool=map.get(String(x.pool_name||"").toLowerCase());return {name:x.name,profile:x.profile,profileName:x.profile_name,price:Number(x.price||0),poolName:x.pool_name||"",poolRanges:pool?.ranges||"",rateLimit:x.rate_limit||"",durationMonths:Number(x.duration_months||1)};})});}catch(error){return errorResponse(res,error);}}
async function createCustomer(req, res) {
  const body = req.body || {};
  const customer = {
    fullName: clean(body.fullName || body.name, 200),
    phone: clean(body.phone, 40),
    connectionDate: normalizeDate(body.connectionDate),
    username: clean(body.username, 100),
    password: clean(body.password, 255),
    packageName: clean(body.package || body.packageName || body.profile, 100),
    profile: clean(body.packageProfile || body.profile || body.package || body.packageName, 100),
    activationDate: normalizeDate(body.activationDate || body.connectionDate),
    expirationDate: normalizeDate(body.expirationDate),
    nid: clean(body.nid, 100),
    installationAddress: clean(body.installationAddress || body.address, 500),
    fiberBox: clean(body.fiberBox, 150),
    onuMac: clean(body.onuMac, 100),
    remarks: clean(body.remarks || body.note, 1000)
  };
  customer.effectiveProfile = effectiveProfile(customer.profile, customer.expirationDate);

  if (!customer.fullName || !customer.phone || !customer.connectionDate || !customer.activationDate || !customer.expirationDate ||
      !customer.username || !customer.password || !customer.packageName || !customer.profile) {
    return res.status(400).json({
      success: false,
      message: "Name, phone, connection date, username, password, and package/profile are required."
    });
  }

  try {
    const packageDefinition = await resolvePackageDefinition(customer.profile, customer.packageName);
    if (!packageDefinition) return res.status(400).json({ success: false, message: "Selected package/profile is not configured in the billing package table." });
    customer.monthlyBill = packageDefinition.price;
    customer.packageName=packageDefinition.name;customer.profile=packageDefinition.profileName||customer.profile;customer.poolName=packageDefinition.poolName||"";

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
        monthly_bill, nid, installation_address, fiber_box, onu_mac, remarks, expiration_date,
        provisioning_status, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,NOW(),NOW())
       RETURNING id, username`,
      [
        customer.fullName, customer.phone, customer.connectionDate, customer.username,
        customer.password, customer.packageName, customer.profile, customer.monthlyBill,
        customer.nid || null, customer.installationAddress || null, customer.fiberBox || null,
        customer.onuMac || null, customer.remarks || null, customer.expirationDate, dateStatus(customer.expirationDate)
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
          profile: customer.effectiveProfile,
          comment: buildExpirationComment(customer.fullName, customer.phone, customer.expirationDate, customer.remarks),
          disabled: dateStatus(customer.expirationDate) === "expired"
        });
        provisioning = "provisioned";
        await db.query(
          `UPDATE customers SET provisioning_status='provisioned', router_id=$1, status=$2, updated_at=NOW() WHERE id=$3`,
          [String(process.env.ROUTER_HOST || ""), dateStatus(customer.expirationDate), customerId]
        );
        await db.query(
          `INSERT INTO pppoe_users
           (username,password,profile,service,disabled,comment,phone,router_id,expiry_date,status,synced_at,updated_at)
           VALUES ($1,$2,$3,'pppoe',$4,$5,$6,$7,$8,$9,NOW(),NOW())
           ON CONFLICT (username) DO UPDATE SET
             password=EXCLUDED.password, profile=EXCLUDED.profile, disabled=EXCLUDED.disabled,
             comment=EXCLUDED.comment, phone=EXCLUDED.phone, router_id=EXCLUDED.router_id,
             expiry_date=EXCLUDED.expiry_date, status=EXCLUDED.status, synced_at=NOW(), updated_at=NOW()`,
          [
            customer.username,
            customer.password,
            customer.effectiveProfile,
            dateStatus(customer.expirationDate) === "expired",
            buildExpirationComment(customer.fullName, customer.phone, customer.expirationDate, customer.remarks),
            customer.phone,
            String(process.env.ROUTER_HOST || ""),
            customer.expirationDate,
            dateStatus(customer.expirationDate)
          ]
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
        provisioningStatus: provisioning,
        expirationDate: customer.expirationDate,
        status: dateStatus(customer.expirationDate),
        effectiveProfile: customer.effectiveProfile
      }
    });
  } catch (error) {
    return errorResponse(res, error);
  }
}

async function getCustomer(req, res) {
  try {
    const id = clean(req.params.id, 50);
    const result = await db.query("SELECT * FROM customers WHERE id::text=$1 OR LOWER(username)=LOWER($1) LIMIT 1", [id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "Customer not found." });
    return res.json({ success: true, customer: result.rows[0] });
  } catch (error) { return errorResponse(res, error); }
}

async function profile(req,res){
  try{
    const username=clean(req.query.username,100);
    if(!username)return res.status(400).json({success:false,message:"Username is required."});
    const result=await db.query("SELECT * FROM customers WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);
    if(!result.rows.length)return res.status(404).json({success:false,message:"Customer profile not found."});
    const pppoe=await db.query("SELECT * FROM pppoe_users WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);
    return res.json({success:true,customer:result.rows[0],pppoe:pppoe.rows[0]||null});
  }catch(error){return errorResponse(res,error);}
}
async function markPaid(req,res){
  const username=clean(req.body?.username,100);
  if(!username)return res.status(400).json({success:false,message:"Username is required."});
  try{
    const customer=await db.query("SELECT expiration_date FROM customers WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);
    const pppoe=await db.query("SELECT expiry_date FROM pppoe_users WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);
    if(!customer.rows.length&&!pppoe.rows.length)return res.status(404).json({success:false,message:"Customer not found."});
    const paidUntil=normalizeDate(customer.rows[0]?.expiration_date||pppoe.rows[0]?.expiry_date)||bangladeshToday();
    await db.query("UPDATE customers SET billing_status='paid',last_paid_at=NOW(),paid_until=$1,updated_at=NOW() WHERE LOWER(username)=LOWER($2)",[paidUntil,username]);
    await db.query("UPDATE pppoe_users SET billing_status='paid',last_paid_at=NOW(),paid_until=$1,updated_at=NOW() WHERE LOWER(username)=LOWER($2)",[paidUntil,username]);
    return res.json({success:true,username,paidUntil,message:`Bill marked as paid for the current cycle until ${paidUntil}.`});
  }catch(error){return errorResponse(res,error);}
}
async function renew(req,res){
  const username=clean(req.body?.username,100);
  if(!username)return res.status(400).json({success:false,message:"Username is required."});
  try{
    const customerResult=await db.query("SELECT * FROM customers WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);
    const pppoeResult=await db.query("SELECT * FROM pppoe_users WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);
    const customer=customerResult.rows[0]||null, routerUser=pppoeResult.rows[0]||null;
    if(!customer&&!routerUser)return res.status(404).json({success:false,message:"Customer not found."});
    const currentExp=normalizeDate(customer?.expiration_date||routerUser?.expiry_date);
    const today=bangladeshToday(), base=currentExp&&currentExp>=today?currentExp:today;
    const newExpDate=addBangladeshCalendarMonth(base);
    const phone=clean(customer?.phone||routerUser?.phone||"","");
    const comment=phone ? "EXP: "+newExpDate+" | "+phone : "EXP: "+newExpDate;
    await mikrotikService.renewSecret(username,{comment,disabled:false});
    await db.query("UPDATE customers SET expiration_date=$1,status='active',billing_status='paid',last_paid_at=NOW(),paid_until=$1,provisioning_status='provisioned',updated_at=NOW() WHERE LOWER(username)=LOWER($2)",[newExpDate,username]);
    await db.query("UPDATE pppoe_users SET expiry_date=$1,status='active',disabled=FALSE,comment=$2,billing_status='paid',last_paid_at=NOW(),paid_until=$1,synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($3)",[newExpDate,comment,username]);
    return res.json({success:true,username,newExpDate,message:`User ${username} renewed until ${newExpDate}`});
  }catch(error){return errorResponse(res,error);}
}
async function removeCustomer(req,res){
  const username=clean(req.body?.username,100), id=clean(req.body?.id,50);
  if(!username&&!id)return res.status(400).json({success:false,message:"Username or customer ID is required."});
  try{
    const current=await db.query(id?"SELECT id,username FROM customers WHERE id::text=$1 LIMIT 1":"SELECT id,username FROM customers WHERE LOWER(username)=LOWER($1) LIMIT 1",[id||username]);
    const resolvedUsername=clean(current.rows[0]?.username||username,100);
    if(!resolvedUsername)return res.status(404).json({success:false,message:"Customer not found."});
    const result=await mikrotikService.removeCustomer(resolvedUsername);
    await db.query("DELETE FROM customers WHERE LOWER(username)=LOWER($1)",[resolvedUsername]);
    await db.query("DELETE FROM pppoe_users WHERE LOWER(username)=LOWER($1)",[resolvedUsername]);
    return res.json({success:true,username:resolvedUsername,terminatedSessions:result.terminatedSessions,message:`Customer ${resolvedUsername} deleted from MikroTik and Database`});
  }catch(error){return errorResponse(res,error);}
}
async function updateCustomer(req,res){
  const body=req.body||{}, id=clean(req.params.id,50);
  const customer={
    fullName:clean(body.fullName||body.name,200),phone:clean(body.phone,40),
    connectionDate:normalizeDate(body.connectionDate||body.activationDate),
    activationDate:normalizeDate(body.activationDate||body.connectionDate),
    expirationDate:normalizeDate(body.expirationDate),username:clean(body.username,100),
    password:clean(body.password,255),packageName:clean(body.package||body.packageName||body.profile,100),
    profile:clean(body.packageProfile||body.profile||body.package||body.packageName,100),
    nid:clean(body.nid,100),installationAddress:clean(body.installationAddress||body.address,500),
    fiberBox:clean(body.fiberBox,150),onuMac:clean(body.onuMac,100),remarks:clean(body.remarks||body.note,1000)
  };
  customer.effectiveProfile=effectiveProfile(customer.profile,customer.expirationDate);
  if(!id||!customer.fullName||!customer.phone||!customer.activationDate||!customer.expirationDate||!customer.username||!customer.password||!customer.packageName||!customer.profile)
    return res.status(400).json({success:false,message:"Name, phone, activation date, expiration date, username, password, and package/profile are required."});
  try{
    const packageDefinition=await resolvePackageDefinition(customer.profile,customer.packageName);
    if(!packageDefinition)return res.status(400).json({success:false,message:"Selected package/profile is not configured in the billing package table."});
    customer.monthlyBill=packageDefinition.price;customer.packageName=packageDefinition.name;customer.profile=packageDefinition.profileName||customer.profile;
    const current=await db.query("SELECT * FROM customers WHERE id::text=$1 OR LOWER(username)=LOWER($1) LIMIT 1",[id]);
    if(!current.rows.length)return res.status(404).json({success:false,message:"Customer not found."});
    const currentRow=current.rows[0], customerId=currentRow.id, previousUsername=clean(currentRow.username,100);
    const usernameChanged=previousUsername.toLowerCase()!==customer.username.toLowerCase();
    const duplicate=await db.query("SELECT id FROM customers WHERE id<>$1 AND (LOWER(username)=LOWER($2) OR phone=$3) LIMIT 1",[customerId,customer.username,customer.phone]);
    if(duplicate.rows.length)return res.status(409).json({success:false,message:"Another customer already uses this username or phone number."});
    const result=await db.query("UPDATE customers SET full_name=$1,phone=$2,connection_date=$3,username=$4,password=$5,package_name=$6,profile=$7,monthly_bill=$8,nid=$9,installation_address=$10,fiber_box=$11,onu_mac=$12,remarks=$13,expiration_date=$14,updated_at=NOW() WHERE id=$15 RETURNING *",[customer.fullName,customer.phone,customer.connectionDate,customer.username,customer.password,customer.packageName,customer.profile,customer.monthlyBill,customer.nid||null,customer.installationAddress||null,customer.fiberBox||null,customer.onuMac||null,customer.remarks||null,customer.expirationDate,customerId]);
    const comment=buildExpirationComment(customer.fullName,customer.phone,customer.expirationDate,customer.remarks), expired=dateStatus(customer.expirationDate)==="expired";
    let provisioning="pending";
    try{
      if(await mikrotikService.testConnection()){
        if(usernameChanged)await mikrotikService.updateSecretIdentity(previousUsername,{username:customer.username,password:customer.password,profile:customer.effectiveProfile,comment,disabled:expired});
        else await mikrotikService.updateSecret(customer.username,{password:customer.password,profile:customer.effectiveProfile,callerId:"",comment,disabled:expired});
        provisioning="provisioned";
        if(usernameChanged)await db.query("DELETE FROM pppoe_users WHERE LOWER(username)=LOWER($1)",[previousUsername]);
        await db.query("UPDATE customers SET provisioning_status='provisioned',router_id=$1,status=$2,updated_at=NOW() WHERE id=$3",[String(process.env.ROUTER_HOST||""),dateStatus(customer.expirationDate),customerId]);
        await db.query("INSERT INTO pppoe_users (username,password,profile,service,disabled,comment,phone,router_id,expiry_date,status,synced_at,updated_at) VALUES ($1,$2,$3,'pppoe',$4,$5,$6,$7,$8,$9,NOW(),NOW()) ON CONFLICT (username) DO UPDATE SET password=EXCLUDED.password,profile=EXCLUDED.profile,disabled=EXCLUDED.disabled,comment=EXCLUDED.comment,phone=EXCLUDED.phone,router_id=EXCLUDED.router_id,expiry_date=EXCLUDED.expiry_date,status=EXCLUDED.status,synced_at=NOW(),updated_at=NOW()",[customer.username,customer.password,customer.effectiveProfile,expired,comment,customer.phone,String(process.env.ROUTER_HOST||""),customer.expirationDate,dateStatus(customer.expirationDate)]);
      }
    }catch(routerError){console.warn("[CUSTOMER UPDATE] MikroTik provisioning deferred:",routerError.message);provisioning="failed";}
    return res.json({success:true,message:provisioning==="provisioned"?"Customer updated successfully":"Customer updated successfully; MikroTik update is pending.",customer:{...result.rows[0],effective_profile:customer.effectiveProfile,status:dateStatus(customer.expirationDate),provisioningStatus:provisioning}});
  }catch(error){return errorResponse(res,error);}
}

module.exports = { packages, createCustomer, getCustomer, updateCustomer, profile, markPaid, renew, removeCustomer };

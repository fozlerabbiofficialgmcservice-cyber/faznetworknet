const db = require("../db");
const mikrotikService = require("../services/mikrotikService");
const {logAuditAction,getAdminId,getIpAddress}=require("../utils/auditLogger");
const {evaluateCustomerBillingStatus}=require("../utils/billingStatus");

async function safePasswordMatch(password, plainPassword, passwordHash) {
  const input = String(password ?? "");
  const plain = String(plainPassword ?? "");
  if (plain && plain === input) return true;
  const hash = String(passwordHash ?? "");
  if (!hash) return false;
  try {
    const bcrypt = require("bcryptjs");
    return await bcrypt.compare(input, hash);
  } catch (error) {
    console.warn("[CUSTOMER AUTH] bcrypt comparison unavailable:", error.message);
    return false;
  }
}

async function withTimeout(task, timeoutMs = 2500) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Operation timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clean(value, max = 255) {
  return String(value ?? "").trim().slice(0, max);
}

function formatBdPhoneNumber(phone) {
  if (!phone) return "—";
  let cleanPhone = String(phone).replace(/[^0-9]/g, "");
  if (cleanPhone.startsWith("880")) cleanPhone = cleanPhone.substring(2);
  else if (cleanPhone.startsWith("00880")) cleanPhone = cleanPhone.substring(4);
  else if (cleanPhone.startsWith("00")) cleanPhone = cleanPhone.substring(1);
  if (!cleanPhone.startsWith("0") && cleanPhone.length === 10) cleanPhone = "0" + cleanPhone;
  return cleanPhone || "—";
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
function nextBillingExpiryDate(currentExpiry,cycleValue,durationDaysValue) {
  const parsed=normalizeDate(currentExpiry),today=bangladeshToday(),base=parsed&&parsed>=today?parsed:today;
  if(String(cycleValue||"monthly").trim().toLowerCase()==="custom_days"){
    const days=Number.parseInt(durationDaysValue,10);
    if(!Number.isInteger(days)||days<1||days>3650)throw new Error("Custom billing duration must be between 1 and 3650 days.");
    const [year,month,day]=base.split("-").map(Number),next=new Date(Date.UTC(year,month-1,day+days));
    return [next.getUTCFullYear(),String(next.getUTCMonth()+1).padStart(2,"0"),String(next.getUTCDate()).padStart(2,"0")].join("-");
  }
  return addBangladeshCalendarMonth(base);
}
function validDateOnly(value) {
  const raw=clean(value,20);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return false;
  const [year,month,day]=raw.split("-").map(Number),date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
}
function expirationEndOfDay(expirationDate) {
  const raw = normalizeDate(expirationDate);
  if (!raw) return null;
  const expDateObj = new Date(raw + "T23:59:59.999+06:00");
  return Number.isNaN(expDateObj.getTime()) ? null : expDateObj;
}
function dateStatus(expirationDate) {
  const expDateObj = expirationEndOfDay(expirationDate);
  if (!expDateObj) return "active";
  return new Date().getTime() > expDateObj.getTime() ? "expired" : "active";
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
    phone: formatBdPhoneNumber(body.phone),
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
    areaZone: clean(body.areaZone || body.area_zone, 150),
    onuMac: clean(body.onuMac, 100),
    remarks: clean(body.remarks || body.note, 1000)
  };
  customer.effectiveProfile = effectiveProfile(customer.profile, customer.expirationDate);

  if (!customer.fullName || !customer.phone || customer.phone === '—' || !customer.connectionDate || !customer.activationDate || !customer.expirationDate ||
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
        monthly_bill, nid, installation_address, area_zone, fiber_box, onu_mac, remarks, expiration_date,
        provisioning_status, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16,NOW(),NOW())
       RETURNING id, username`,
      [
        customer.fullName, customer.phone, customer.connectionDate, customer.username,
        customer.password, customer.packageName, customer.profile, customer.monthlyBill,
        customer.nid || null, customer.installationAddress || null, customer.areaZone || null, customer.fiberBox || null,
        customer.onuMac || null, customer.remarks || null, customer.expirationDate, dateStatus(customer.expirationDate)
      ]
    );

    const customerId = inserted.rows[0].id;
    // A new admin-created customer explicitly revives its username, so clear
    // any previous deletion tombstone before router synchronization.
    await db.query("DELETE FROM customer_deletion_tombstones WHERE LOWER(username)=LOWER($1)",[customer.username]);
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
        ? "Customer provisioned successfully"
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

async function listCustomers(req,res){
  try{
    const requestedStatus=clean(req.query?.status||"all",20).toLowerCase();
    const allowed=new Set(["all","paid","due","unpaid"]);
    if(!allowed.has(requestedStatus))return res.status(400).json({success:false,message:"Invalid billing status filter.",allowedStatuses:Array.from(allowed)});

    const result=await db.query(`
      SELECT c.*,u.disabled AS pppoe_disabled,u.remote_address AS pppoe_remote_address,
             u.caller_id AS pppoe_caller_id,u.comment AS pppoe_comment,u.expiry_date AS pppoe_expiry_date,
             u.profile AS pppoe_profile
      FROM customers c
      LEFT JOIN pppoe_users u ON LOWER(u.username)=LOWER(c.username)
      ORDER BY COALESCE(c.created_at, '1970-01-01'::timestamp) ASC, c.username ASC, c.id ASC
    `);

    let sessions=[];
    try{
      sessions=await withTimeout(()=>mikrotikService.getActiveSessions(),2500);
    }catch(error){
      console.warn("[CUSTOMER LIST] MikroTik live session lookup unavailable:",error.message);
    }
    const sessionMap=new Map();
    for(const session of Array.isArray(sessions)?sessions:[]){
      const key=String(session.username||"").trim().toLowerCase();
      if(key&&!sessionMap.has(key))sessionMap.set(key,session);
    }

    const mapped=result.rows.map(row=>{
      const billing=evaluateCustomerBillingStatus(row);
      const session=sessionMap.get(String(row.username||"").trim().toLowerCase());
      const expiration=row.expiration_date||row.pppoe_expiry_date||null;
      return {
        ...row,
        phone:formatBdPhoneNumber(row.phone),
        alternative_phone:formatBdPhoneNumber(row.alternative_phone),
        expiration_date:expiration,
        expiry_date:expiration,
        billing_status:billing.status,
        billing_badge_class:billing.badgeClass,
        billing_label:billing.label,
        days_left:billing.daysLeft,
        badgeClass:billing.badgeClass,
        active:Boolean(session),
        online:Boolean(session),
        session:session||null,
        session_ip:session?.address||null,
        session_uptime:session?.uptime||null,
        session_caller_id:session?.callerId||null,
        remote_address:row.pppoe_remote_address||row.remote_address||null,
        caller_id:row.pppoe_caller_id||row.caller_id||null,
        comment:row.pppoe_comment||row.remarks||"",
        profile:row.profile||row.pppoe_profile||"",
        computed_status:billing.status
      };
    }).filter(row=>requestedStatus==="all"||(requestedStatus==="unpaid"?["unpaid","expired"].includes(row.billing_status):row.billing_status===requestedStatus));

    const allMapped=result.rows.map(row=>evaluateCustomerBillingStatus(row).status);
    const counts={
      all:result.rows.length,
      paid:allMapped.filter(s=>s==="paid").length,
      due:allMapped.filter(s=>s==="due").length,
      unpaid:allMapped.filter(s=>s==="unpaid"||s==="expired").length
    };

    return res.json({success:true,count:mapped.length,total:result.rows.length,status:requestedStatus,counts,users:mapped,customers:mapped});
  }catch(error){return errorResponse(res,error);}
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
    let dbUser=null,mtSecret=null,session=null;
    try{const q=await db.query("SELECT * FROM customers WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);dbUser=q.rows[0]||null;}catch(error){console.warn("[DB Lookup warning]:",error.message);}
    try{mtSecret=await mikrotikService.getPppoeSecret(username);}catch(error){if(!dbUser)throw error;console.warn("[MikroTik secret warning]:",error.message);}
    try{const sessions=await mikrotikService.getActiveSessions();session=(Array.isArray(sessions)?sessions:[]).find(x=>String(x.username||"").toLowerCase()===username.toLowerCase())||null;}catch(error){console.warn("[MikroTik session warning]:",error.message);}
    if(!dbUser&&!mtSecret)return res.status(404).json({success:false,message:`Customer "${username}" not found in database or MikroTik`});
    const comment=String(mtSecret?.comment||"");
    const nameMatch=comment.match(/Customer:\s*([^|]+)/i),phoneMatch=comment.match(/Phone:\s*([^|]+)/i),expMatch=comment.match(/EXP:\s*([^|]+)/i);
    const expiration=normalizeDate(dbUser?.expiration_date)||(expMatch?normalizeDate(expMatch[1].trim()):"");
    const profileName=clean(mtSecret?.profile||dbUser?.profile||"",100),today=bangladeshToday();
    const paidUntil=normalizeDate(dbUser?.paid_until);
    const expired=Boolean(expiration&&dateStatus(expiration)==="expired");
    const billing=evaluateCustomerBillingStatus({expiration_date:expiration});
    const billingStatus=billing.status;
    const remainingDays=expiration?Math.ceil((Date.parse(expiration+"T00:00:00Z")-Date.parse(today+"T00:00:00Z"))/86400000):null;
    let plans=[],payments=[];
    try{const q=await db.query("SELECT id,plan_name,profile_name,price,duration_months,rate_limit,remote_address FROM packages ORDER BY price ASC,plan_name ASC");plans=q.rows.map(x=>({id:x.id,name:clean(x.plan_name,120),profileName:clean(x.profile_name,120),price:Number(x.price||0),durationMonths:Number(x.duration_months||1),rateLimit:clean(x.rate_limit,100),remoteAddress:clean(x.remote_address,100)}));}catch(error){console.warn("[Customer plans warning]:",error.message);}
    try{const q=await db.query(`SELECT trx_id,amount,channel AS gateway,created_at,status FROM transactions WHERE LOWER(COALESCE(matched_username,''))=LOWER($1) OR COALESCE(sender_phone,'')=$2 ORDER BY created_at DESC LIMIT 3`,[username,clean(dbUser?.phone,40)]);payments=q.rows.map(x=>({trxId:clean(x.trx_id,100),amount:Number(x.amount||0),gateway:clean(x.gateway,30),date:x.created_at,status:clean(x.status,30)}));}catch(error){console.warn("[Customer payments warning]:",error.message);}
    const customer={
      id:dbUser?.id||null,username:clean(mtSecret?.name||dbUser?.username||username,100),
      full_name:clean(dbUser?.full_name||(nameMatch?nameMatch[1].trim():"")||username,200),
      fullName:clean(dbUser?.full_name||(nameMatch?nameMatch[1].trim():"")||username,200),
      phone:clean(dbUser?.phone||(phoneMatch?phoneMatch[1].trim():""),40),alternative_phone:clean(dbUser?.alternative_phone,40),
      profile:profileName||"—",package_name:clean(dbUser?.package_name||profileName||"—",120),password:clean(mtSecret?.password||dbUser?.password||"",255),
      expiration_date:expiration||null,expirationDate:expiration||null,billing_cycle:clean(dbUser?.billing_cycle||"monthly",30),billing_duration_days:dbUser?.billing_duration_days==null?null:Number(dbUser.billing_duration_days),billing_expiry_override:Boolean(dbUser?.billing_expiry_override),remainingDays,billing_status:billing.status,billing_badge_class:billing.badgeClass,badgeClass:billing.badgeClass,billing_label:billing.label,days_left:billing.daysLeft,paid_until:paidUntil||null,
      disabled:Boolean(mtSecret?.disabled),remote_address:clean(mtSecret?.remoteAddress||dbUser?.remote_address,100),caller_id:clean(mtSecret?.callerId||dbUser?.caller_id,100),
      service:clean(mtSecret?.service||"pppoe",30),installation_address:dbUser?.installation_address||"",olt_pon_port:dbUser?.olt_pon_port||"",
      distribution_box:dbUser?.distribution_box||dbUser?.fiber_box||"",onu_mac:dbUser?.onu_mac||"",onu_serial:dbUser?.onu_serial||"",
      fiber_drop_core:dbUser?.fiber_drop_core||"",remarks:dbUser?.remarks||"",connection_date:dbUser?.connection_date||null
    };
    return res.json({success:true,customer,live:{online:Boolean(session),ip:session?.address||customer.remote_address||"",mac:session?.callerId||customer.caller_id||"",uptime:session?.uptime||"",bytesIn:session?.bytesIn||"0",bytesOut:session?.bytesOut||""},plans,payments,source:dbUser&&mtSecret?"database+mikrotik":mtSecret?"mikrotik":"database"});
  }catch(error){return errorResponse(res,error);}
}

async function publicCustomerCheck(req,res){
  try{
    const query=clean(req.query.query,120);
    if(!query)return res.status(400).json({success:false,message:"Username, phone number, or customer ID is required."});

    let dbUser=null;
    try{
      const q=await db.query(
        "SELECT c.*,p.plan_name AS linked_plan_name,p.profile_name AS linked_profile_name FROM customers c LEFT JOIN packages p ON LOWER(p.profile_name)=LOWER(c.profile) OR LOWER(p.plan_name)=LOWER(c.package_name) WHERE LOWER(c.username)=LOWER($1) OR c.phone=$1 OR c.id::text=$1 LIMIT 1",
        [query]
      );
      dbUser=q.rows[0]||null;
    }catch(error){console.warn("[Public Customer DB warning]:",error.message);}

    let mtSecret=null;
    const lookupUsername=dbUser?.username||query;
    try{
      mtSecret=await mikrotikService.getPppoeSecret(lookupUsername);
    }catch(error){console.warn("[Public Customer MikroTik warning]:",error.message);}

    if(!dbUser&&!mtSecret)return res.status(404).json({success:false,message:"Customer account was not found."});

    const comment=String(mtSecret?.comment||"");
    const nameMatch=comment.match(/Customer:\s*([^|]+)/i);
    const phoneMatch=comment.match(/Phone:\s*([^|]+)/i);
    const expMatch=comment.match(/EXP:\s*([^|]+)/i);
    const expiration=normalizeDate(dbUser?.expiration_date)||(expMatch?normalizeDate(expMatch[1].trim()):"");
    const today=bangladeshToday();
    let remainingDays=null;
    if(expiration){
      remainingDays=Math.max(0,Math.ceil((Date.parse(expiration+"T00:00:00Z")-Date.parse(today+"T00:00:00Z"))/86400000));
    }

    let online=false,liveIp="";
    try{
      const sessions=await mikrotikService.getActiveSessions();
      const target=String(mtSecret?.name||dbUser?.username||query).toLowerCase();
      const session=(Array.isArray(sessions)?sessions:[]).find(x=>String(x.username||"").toLowerCase()===target);
      online=Boolean(session);liveIp=session?.address||"";
    }catch(error){console.warn("[Public Customer session warning]:",error.message);}

    const paidUntil=normalizeDate(dbUser?.paid_until);
    const accountState=String(dbUser?.status||"").trim().toLowerCase();
    const suspended=Boolean(mtSecret?.disabled)||["expired","suspended","disabled","left","terminated","due"].includes(accountState);
    const paidCurrentCycle=String(dbUser?.billing_status||"").toLowerCase()==="paid" && Boolean(paidUntil && paidUntil>=today) && !suspended && dateStatus(expiration)==="active";
    const billing=paidCurrentCycle?"Paid":"Unpaid";
    const profile=clean(mtSecret?.profile||dbUser?.profile||dbUser?.linked_profile_name||dbUser?.package_name||"-",100);
    const packageName=clean(dbUser?.linked_plan_name||dbUser?.package_name||profile,100);
    const supportPhone=clean(process.env.SUPPORT_PHONE||process.env.CONTACT_PHONE||"",40);

    return res.json({
      success:true,
      customer:{
        username:clean(mtSecret?.name||dbUser?.username||query,100),
        customerId:dbUser?.id||null,
        name:clean(dbUser?.full_name||(nameMatch?nameMatch[1].trim():"")||dbUser?.username||mtSecret?.name||query,200),
        phone:clean(dbUser?.phone||(phoneMatch?phoneMatch[1].trim():""),40),
        package:packageName,
        profile,
        expirationDate:expiration||null,
        remainingDays,
        connectionStatus:online?"Online":"Offline",
        liveIp:liveIp||null,
        billingStatus:billing,
        paidUntil:paidUntil||null,
        supportPhone:supportPhone||null,
        rechargeUrl:process.env.RECHARGE_URL||"/",
        disabled:Boolean(mtSecret?.disabled),
        service:clean(mtSecret?.service||"pppoe",30)
      }
    });
  }catch(error){console.error("[Public Customer Check Error]:",error);return res.status(503).json({success:false,message:"Customer account lookup is temporarily unavailable."});}
}

async function publicCustomerLogin(req,res){
  try{
    const identifier=clean(req.body?.identifier,120);
    const password=String(req.body?.password??"").trim();
    if(!identifier||!password){
      return res.status(400).json({success:false,message:"Username/Phone and password are required."});
    }

    let dbUser=null;
    try{
      const q=await db.query(
        "SELECT c.*,p.plan_name AS linked_plan_name,p.profile_name AS linked_profile_name FROM customers c LEFT JOIN packages p ON LOWER(p.profile_name)=LOWER(c.profile) OR LOWER(p.plan_name)=LOWER(c.package_name) WHERE LOWER(c.username)=LOWER($1) OR c.phone=$1 LIMIT 1",
        [identifier]
      );
      dbUser=q.rows[0]||null;
    }catch(error){
      console.warn("[Public Customer Login DB warning]:",error.message);
    }

    // Authenticate against PostgreSQL first. Support both existing plaintext passwords
    // and bcrypt hashes without making MikroTik availability a prerequisite.
    let authenticated=await safePasswordMatch(password,dbUser?.password,dbUser?.password_hash);

    // If DB authentication did not succeed, fall back to the RouterOS PPP secret.
    // This is also isolated from the request so a slow router cannot crash the login.
    let mtSecret=null;
    const candidateUsername=dbUser?.username||identifier;
    if(!authenticated){
      try{
        mtSecret=await withTimeout(
          ()=>mikrotikService.getPppoeSecret(candidateUsername),
          2500
        );
        authenticated=await safePasswordMatch(password,mtSecret?.password,mtSecret?.password_hash);
      }catch(error){
        console.warn("[Public Customer Login MikroTik auth warning]:",error.message);
      }
    }

    if(!authenticated){
      return res.status(401).json({
        success:false,
        message:dbUser||mtSecret ? "Incorrect password" : "User not found"
      });
    }

    // Profile enrichment is best-effort. Authentication has already succeeded.
    if(!mtSecret){
      try{
        mtSecret=await withTimeout(
          ()=>mikrotikService.getPppoeSecret(candidateUsername),
          2500
        );
      }catch(error){
        console.warn("[Public Customer Login MikroTik profile warning]:",error.message);
      }
    }

    const comment=String(mtSecret?.comment||"");
    const nameMatch=comment.match(/Customer:\s*([^|]+)/i);
    const phoneMatch=comment.match(/Phone:\s*([^|]+)/i);
    const expMatch=comment.match(/EXP:\s*(\d{4}-\d{2}-\d{2})/i);
    const expiration=normalizeDate(dbUser?.expiration_date)||(expMatch?normalizeDate(expMatch[1]):"");
    const today=bangladeshToday();
    const remainingDays=expiration?Math.max(0,Math.ceil((Date.parse(expiration+"T00:00:00Z")-Date.parse(today+"T00:00:00Z"))/86400000)):null;

    // Live-session data is explicitly non-critical. A slow/unavailable router
    // simply leaves the customer as Offline instead of failing the login.
    let online=false,liveIp="",uptime="";
    try{
      const sessions=await withTimeout(
        ()=>mikrotikService.getActiveSessions(),
        2000
      );
      const target=String(mtSecret?.name||dbUser?.username||candidateUsername).toLowerCase();
      const session=(Array.isArray(sessions)?sessions:[]).find(x=>String(x.username||"").toLowerCase()===target);
      online=Boolean(session);
      liveIp=String(session?.address||"");
      uptime=String(session?.uptime||"");
    }catch(error){
      console.warn("[Public Customer Login session warning]:",error.message);
    }

    const paidUntil=normalizeDate(dbUser?.paid_until);
    const accountState=String(dbUser?.status||"").trim().toLowerCase();
    const suspended=Boolean(mtSecret?.disabled)||["expired","suspended","disabled","left","terminated","due"].includes(accountState);
    const billingStatus=String(dbUser?.billing_status||"").toLowerCase()==="paid" &&
      Boolean(paidUntil&&paidUntil>=today) && !suspended && dateStatus(expiration)==="active" ? "Paid" : "Unpaid";

    const profile=clean(mtSecret?.profile||dbUser?.profile||dbUser?.linked_profile_name||dbUser?.package_name||"-",100);
    const packageName=clean(dbUser?.linked_plan_name||dbUser?.package_name||profile,100);
    const supportPhone=clean(process.env.SUPPORT_PHONE||process.env.CONTACT_PHONE||"01339932887",40);
    const officeAddress=clean(process.env.OFFICE_ADDRESS||"FAZ NETWORK Office — Please contact support for the current office address.",300);
    const whatsappNumber=clean(process.env.SUPPORT_WHATSAPP||supportPhone,40).replace(/\D/g,"");
    const rechargeUrl=String(process.env.RECHARGE_URL||"").trim();

    req.session.customerUser={
      id:dbUser?.id||null,
      username:clean(mtSecret?.name||dbUser?.username||candidateUsername,100)
    };
    req.session.isCustomer=true;
    req.session.customerLoginAt=Date.now();
    return req.session.save(err=>{
      if(err){
        console.error("[Customer Session Save Error]:",err);
        return res.status(500).json({success:false,message:"Failed to initialize customer session."});
      }
      return res.json({
      success:true,
      customer:{
        customerId:dbUser?.id||null,
        name:clean(dbUser?.full_name||(nameMatch?nameMatch[1].trim():"")||dbUser?.username||mtSecret?.name||candidateUsername,200),
        username:clean(mtSecret?.name||dbUser?.username||candidateUsername,100),
        phone:clean(dbUser?.phone||(phoneMatch?phoneMatch[1].trim():""),40),
        package:packageName,
        profile,
        expirationDate:expiration||null,
        remainingDays,
        connectionStatus:online?"Online":"Offline",
        liveIp:liveIp||null,
        uptime:uptime||null,
        billingStatus,
        paidUntil:paidUntil||null,
        disabled:Boolean(mtSecret?.disabled),
        supportPhone,
        whatsappUrl:whatsappNumber?"https://wa.me/"+(whatsappNumber.startsWith("88")?whatsappNumber:"88"+whatsappNumber.replace(/^0/,"")):"",
        officeAddress,
        rechargeUrl:rechargeUrl||null
      }
      });
    });
  }catch(error){
    console.error("[Public Customer Login Error]:",error);
    return res.status(503).json({success:false,message:"Customer login is temporarily unavailable."});
  }
}

async function getAuditLogs(req,res){
  try{
    const id=clean(req.params.id,50);
    const result=await db.query(`SELECT id,customer_id,admin_id,action,details,ip_address,created_at FROM audit_logs WHERE customer_id::text=$1 ORDER BY created_at DESC LIMIT 30`,[id]);
    return res.json({success:true,logs:result.rows});
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
    const paidCustomer=(await db.query("SELECT id,package_name FROM customers WHERE LOWER(username)=LOWER($1) LIMIT 1",[username])).rows[0];
    if(paidCustomer) await logAuditAction({customerId:paidCustomer.id,adminId:getAdminId(req),action:"RENEW",details:{message:"Bill marked as paid for current cycle",paidUntil,package:paidCustomer.package_name},ipAddress:getIpAddress(req)});
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
    const newExpDate=nextBillingExpiryDate(currentExp,customer?.billing_cycle,customer?.billing_duration_days);
    const phone=clean(customer?.phone||routerUser?.phone||"",40),fullName=clean(customer?.full_name||"",200);
    const comment=buildExpirationComment(fullName,phone,newExpDate,clean(customer?.remarks||"",1000));
    const packageProfileResult=customer?.package_name
      ? await db.query("SELECT profile_name FROM packages WHERE LOWER(plan_name)=LOWER($1) LIMIT 1",[customer.package_name])
      : {rows:[]};
    const activeProfile=clean(packageProfileResult.rows[0]?.profile_name||customer?.profile||routerUser?.profile||"",100);
    if(!activeProfile||activeProfile.toUpperCase()==="EXPIRED")throw new Error("Customer package profile is missing or invalid.");
    await mikrotikService.updateSecret(username,{password:customer?.password||routerUser?.password||"",profile:activeProfile,comment,disabled:false});
    await mikrotikService.kickActiveUser(username);
    await db.query("UPDATE customers SET expiration_date=$1,status='active',billing_status='paid',last_paid_at=NOW(),paid_until=$1,provisioning_status='provisioned',updated_at=NOW() WHERE LOWER(username)=LOWER($2)",[newExpDate,username]);
    await db.query("UPDATE pppoe_users SET expiry_date=$1,status='active',disabled=FALSE,comment=$2,billing_status='paid',last_paid_at=NOW(),paid_until=$1,synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($3)",[newExpDate,comment,username]);
    const paidAmount=Number(customer?.monthly_bill||routerUser?.price||0);
    const trxId="CASH-"+Date.now()+"-"+(customer?.id||username);
    await db.query("INSERT INTO transactions(channel,trx_id,amount,status,matched_username,sender_phone,used) VALUES('cash',$1,$2,'PAID',$3,$4,TRUE)",[trxId,paidAmount,username,phone]);
    await logAuditAction({customerId:customer?.id,adminId:getAdminId(req),action:"RENEW",details:{message:`Received ৳${paidAmount.toFixed(2)} via cash (TrxID: ${trxId}). Extended validity to ${newExpDate}`,amount:paidAmount,method:"cash",trxId,newExpiration:newExpDate},ipAddress:getIpAddress(req)});
    return res.json({success:true,username,newExpDate,message:`User ${username} renewed until ${newExpDate}`});
  }catch(error){return errorResponse(res,error);}
}
async function removeCustomer(req,res){
  const target=clean(req.params?.id||req.body?.id||req.body?.username,100);
  if(!target)return res.status(400).json({success:false,message:"Customer identifier is required"});

  let username=null;
  let customerId=null;
  let routerCleanup={terminatedSessions:0,removed:false};

  try{
    // Resolve the target from either customers or pppoe_users. pppoe_users
    // does not rely on a customer_id column, so username is the durable join key.
    const customerResult=await db.query(
      "SELECT id,username FROM customers WHERE id::text=$1 OR LOWER(username)=LOWER($1) LIMIT 1",
      [target]
    );
    if(customerResult.rows.length){
      customerId=customerResult.rows[0].id;
      username=clean(customerResult.rows[0].username,100)||null;
    }else{
      const pppoeResult=await db.query(
        "SELECT id,username FROM pppoe_users WHERE id::text=$1 OR LOWER(username)=LOWER($1) LIMIT 1",
        [target]
      );
      if(pppoeResult.rows.length){
        username=clean(pppoeResult.rows[0].username,100)||null;
        const linkedCustomer=await db.query(
          "SELECT id,username FROM customers WHERE LOWER(username)=LOWER($1) LIMIT 1",
          [username]
        );
        if(linkedCustomer.rows.length){
          customerId=linkedCustomer.rows[0].id;
          username=clean(linkedCustomer.rows[0].username,100)||username;
        }
      }else{
        // Last-resort username fallback: deletion must not be blocked merely
        // because the identifier exists in neither lookup table.
        username=target;
      }
    }

    if(!username)username=target;

    // MikroTik is best-effort only. Missing secrets/sessions, router errors,
    // or an unavailable router must NEVER block local database deletion.
    try{
      routerCleanup=await mikrotikService.removeCustomer(username);
    }catch(routerErr){
      console.warn("[MikroTik Safe Delete] Cleanup skipped:",routerErr?.message||routerErr);
    }

    await db.withTransaction(async(client)=>{
      await client.query(
        "DELETE FROM transactions WHERE LOWER(COALESCE(matched_username,''))=LOWER($1)",
        [username]
      );

      if(customerId){
        await client.query("DELETE FROM audit_logs WHERE customer_id=$1",[customerId]);
      }else{
        // No customer row is required for deletion, but remove any orphaned
        // audit rows that can be associated by username when that schema exists.
        const auditUsernameColumn=await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='audit_logs' AND column_name='username' LIMIT 1"
        );
        if(auditUsernameColumn.rows.length){
          await client.query("DELETE FROM audit_logs WHERE LOWER(username)=LOWER($1)",[username]);
        }
      }

      const invoiceTable=await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='invoices' LIMIT 1"
      );
      if(invoiceTable.rows.length&&customerId){
        const invoiceCustomerColumn=await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='invoices' AND column_name='customer_id' LIMIT 1"
        );
        if(invoiceCustomerColumn.rows.length){
          await client.query("DELETE FROM invoices WHERE customer_id=$1",[customerId]);
        }
      }

      await client.query("DELETE FROM pppoe_users WHERE LOWER(username)=LOWER($1)",[username]);
      await client.query("DELETE FROM customers WHERE LOWER(username)=LOWER($1)",[username]);

      await client.query(
        "INSERT INTO customer_deletion_tombstones(username,customer_id,deleted_at) VALUES(LOWER($1),$2,NOW()) ON CONFLICT(username) DO UPDATE SET customer_id=EXCLUDED.customer_id,deleted_at=NOW()",
        [username,customerId]
      );
    });

    return res.json({
      success:true,
      message:"Customer completely removed from system",
      username,
      customerId:customerId||null,
      terminatedSessions:routerCleanup?.terminatedSessions||0
    });
  }catch(error){
    console.error("[CUSTOMER DELETE] Unconditional deletion failed:",error);
    return errorResponse(res,error);
  }
}
async function updateCustomer(req,res){
  const body=req.body||{},id=clean(req.params.id||body.id||body.username,100);
  if(!id)return res.status(400).json({success:false,message:"Customer ID or username is required."});
  try{
    const current=await db.query("SELECT * FROM customers WHERE id::text=$1 OR LOWER(username)=LOWER($1) LIMIT 1",[id]);
    if(!current.rows.length)return res.status(404).json({success:false,message:"Customer not found."});
    const row=current.rows[0],username=clean(body.username||row.username,100),fullName=clean(body.fullName||body.name||row.full_name,200),phone=clean(body.phone||row.phone,40);
    const alternativePhone=clean(body.alternativePhone||body.alternative_phone||row.alternative_phone,40);
    const hasOwn=(key)=>Object.prototype.hasOwnProperty.call(body,key);
    const billingDateKey=["billing_expiry_date","next_billing_date","expirationDate","expiration_date"].find(hasOwn);
    const rawBillingDate=billingDateKey?body[billingDateKey]:row.expiration_date;
    if(["billing_expiry_date","next_billing_date"].includes(billingDateKey)&&!String(rawBillingDate||"").trim())return res.status(400).json({success:false,message:"Billing expiry date is required."});
    if(billingDateKey&&String(rawBillingDate||"").trim()&&!validDateOnly(rawBillingDate))return res.status(400).json({success:false,message:"Billing expiry date must be a valid YYYY-MM-DD calendar date."});
    const expirationDate=normalizeDate(rawBillingDate)||normalizeDate(row.expiration_date)||bangladeshToday();
    const cycleRaw=body.billing_cycle??body.billingCycle??row.billing_cycle??"monthly";
    const billingCycle=String(cycleRaw||"monthly").trim().toLowerCase().replace(/[ -]+/g,"_");
    if(!["monthly","custom_days"].includes(billingCycle))return res.status(400).json({success:false,message:"Billing cycle must be Monthly or Custom Days."});
    const durationRaw=body.billing_duration_days??body.billingDurationDays??row.billing_duration_days;
    const billingDurationDays=billingCycle==="custom_days"?Number.parseInt(durationRaw,10):null;
    if(billingCycle==="custom_days"&&(!Number.isInteger(billingDurationDays)||billingDurationDays<1||billingDurationDays>3650))return res.status(400).json({success:false,message:"Custom billing duration must be between 1 and 3650 days."});
    const manualBillingOverride=["billing_expiry_date","next_billing_date","billing_cycle","billingCycle","billing_duration_days","billingDurationDays","billing_expiry_override"].some(hasOwn);
    const billingExpiryOverride=hasOwn("billing_expiry_override")?["true","1","yes","on"].includes(String(body.billing_expiry_override).toLowerCase()):manualBillingOverride?true:Boolean(row.billing_expiry_override);
    const requestedProfile=clean(body.profile||body.packageProfile||row.profile,120),packageName=clean(body.package||body.packageName||row.package_name||requestedProfile,120);
    const packageDefinition=await resolvePackageDefinition(requestedProfile,packageName);
    if(!packageDefinition)return res.status(400).json({success:false,message:"Selected package/profile is not configured in the billing package table."});
    const profileName=packageDefinition.profileName||requestedProfile,password=clean(body.password||row.password,255);
    const disabled=body.disabled===undefined?["inactive","suspended"].includes(String(row.status||"").toLowerCase()):["true","yes","1"].includes(String(body.disabled).toLowerCase());
    const billingStatus=String(body.billingStatus||body.billing_status||row.billing_status||"unpaid").toLowerCase()==="paid"?"paid":"unpaid";
    const address=clean(body.installationAddress||body.address||row.installation_address,1000),areaZone=clean(body.areaZone||body.area_zone||row.area_zone,150),oltPonPort=clean(body.oltPonPort||body.olt_pon_port||row.olt_pon_port,120);
    const distributionBox=clean(body.distributionBox||body.distribution_box||body.fiberBox||row.distribution_box||row.fiber_box,150),onuMac=clean(body.onuMac||body.onu_mac||row.onu_mac,100);
    const onuSerial=clean(body.onuSerial||body.onu_serial||row.onu_serial,150),fiberDropCore=clean(body.fiberDropCore||body.fiber_drop_core||row.fiber_drop_core,80),remarks=clean(body.remarks||body.note||row.remarks,1000);
    const usernameChanged=String(row.username).toLowerCase()!==username.toLowerCase(),packageChanged=String(row.profile||"").toLowerCase()!==profileName.toLowerCase();
    const duplicate=await db.query("SELECT id FROM customers WHERE id<>$1 AND (LOWER(username)=LOWER($2) OR phone=$3) LIMIT 1",[row.id,username,phone]);
    if(duplicate.rows.length)return res.status(409).json({success:false,message:"Another customer already uses this username or phone number."});
    const comment=buildExpirationComment(fullName,phone,expirationDate,remarks),expired=dateStatus(expirationDate)==="expired",previousUsername=clean(row.username,100);
    const nextBillingStatus=expired?"unpaid":billingStatus;
    // Migration overrides preserve the chosen date without automatically moving a
    // previously enabled subscriber to the EXPIRED profile or disabling their line.
    const preservePastDueConnection=manualBillingOverride&&billingExpiryOverride;
    const effectiveDisabled=preservePastDueConnection?disabled:(expired||disabled);
    const routerProfile=preservePastDueConnection?profileName:effectiveProfile(profileName,expirationDate);
    if(await mikrotikService.testConnection()){
      if(usernameChanged)await mikrotikService.updateSecretIdentity(previousUsername,{username,password,profile:routerProfile,comment,disabled:effectiveDisabled});
      else await mikrotikService.updateSecret(username,{password,profile:routerProfile,comment,disabled:effectiveDisabled});
      if(packageChanged){try{await mikrotikService.kickActiveUser(username);}catch(error){console.warn("[CUSTOMER UPDATE] Package change kick warning:",error.message);}}
    }
    const nextStatus=expired?"expired":effectiveDisabled?"inactive":"active";
    const result=await db.query(`UPDATE customers SET full_name=$1,phone=$2,username=$3,password=$4,package_name=$5,profile=$6,monthly_bill=$7,installation_address=$8,area_zone=$9,fiber_box=$10,onu_mac=$11,remarks=$12,expiration_date=$13,alternative_phone=$14,olt_pon_port=$15,distribution_box=$16,onu_serial=$17,fiber_drop_core=$18,billing_status=$19,paid_until=CASE WHEN $19='paid' THEN $13 ELSE paid_until END,billing_cycle=$20,billing_duration_days=$21,billing_expiry_override=$22,provisioning_status='provisioned',status=$23,updated_at=NOW() WHERE id=$24 RETURNING *`,[fullName,phone,username,password,packageDefinition.name,profileName,packageDefinition.price,address,areaZone,distributionBox,onuMac,remarks,expirationDate,alternativePhone,oltPonPort,distributionBox,onuSerial,fiberDropCore,nextBillingStatus,billingCycle,billingDurationDays,billingExpiryOverride,nextStatus,row.id]);
    if(usernameChanged)await db.query("DELETE FROM pppoe_users WHERE LOWER(username)=LOWER($1)",[previousUsername]);
    await db.query(`INSERT INTO pppoe_users (username,password,profile,service,disabled,comment,phone,router_id,expiry_date,status,billing_status,paid_until,synced_at,updated_at)
      VALUES ($1,$2,$3,'pppoe',$4,$5,$6,$7,$8::date,$9,$10,CASE WHEN $10::text='paid' THEN $8::date ELSE NULL::date END,NOW(),NOW())
      ON CONFLICT(username) DO UPDATE SET password=EXCLUDED.password,profile=EXCLUDED.profile,disabled=EXCLUDED.disabled,comment=EXCLUDED.comment,phone=EXCLUDED.phone,expiry_date=EXCLUDED.expiry_date,status=EXCLUDED.status,billing_status=EXCLUDED.billing_status,paid_until=EXCLUDED.paid_until,synced_at=NOW(),updated_at=NOW()`,
      [username,password,routerProfile,effectiveDisabled,comment,phone,String(process.env.ROUTER_HOST||""),expirationDate,nextStatus,nextBillingStatus]);
    await logAuditAction({customerId:row.id,adminId:getAdminId(req),action:"UPDATE_INFO",details:{message:"Updated customer profile details",previous:{name:row.full_name,phone:row.phone,username:row.username,package:row.package_name,profile:row.profile,area:row.area_zone,expirationDate:row.expiration_date,billingCycle:row.billing_cycle,billingDurationDays:row.billing_duration_days,billingExpiryOverride:row.billing_expiry_override},next:{name:fullName,phone,username,package:packageDefinition.name,profile:profileName,area:areaZone,expirationDate,billingCycle,billingDurationDays,billingExpiryOverride,billingStatus:nextBillingStatus}},ipAddress:getIpAddress(req)});
    if(packageChanged) await logAuditAction({customerId:row.id,adminId:getAdminId(req),action:"CHANGE_PACKAGE",details:{message:`Package changed from ${row.package_name||row.profile} to ${packageDefinition.name}`,previousPackage:row.package_name,previousProfile:row.profile,newPackage:packageDefinition.name,newProfile:profileName},ipAddress:getIpAddress(req)});
    return res.json({success:true,message:"Customer profile saved and synchronized with MikroTik.",customer:result.rows[0],kicked:packageChanged});
  }catch(error){return errorResponse(res,error);}
}


async function resolveCustomer360(idValue){
  const key=clean(idValue,100);
  const customerResult=await db.query("SELECT * FROM customers WHERE id::text=$1 OR LOWER(username)=LOWER($1) LIMIT 1",[key]);
  const customer=customerResult.rows[0]||null;
  if(!customer)return null;
  const username=clean(customer.username,100);
  const [routerResult,sessionResult,packageResult,paymentResult,callerIdResult]=await Promise.allSettled([
    mikrotikService.getPppoeSecret(username),
    mikrotikService.getActiveSessions(),
    db.query("SELECT id,plan_name AS name,profile_name AS profileName,pool_name AS poolName,price,duration_months AS durationMonths,rate_limit AS rateLimit,remote_address AS remoteAddress FROM packages ORDER BY price ASC,plan_name ASC"),
    db.query("SELECT trx_id,amount,channel AS method,created_at,status FROM transactions WHERE LOWER(COALESCE(matched_username,''))=LOWER($1) OR COALESCE(sender_phone,'')=$2 ORDER BY created_at DESC LIMIT 50",[username,clean(customer.phone,40)]),
    db.query("SELECT caller_id FROM pppoe_users WHERE LOWER(username)=LOWER($1) LIMIT 1",[username])
  ]);
  const secret=routerResult.status==="fulfilled"?routerResult.value:null;
  const sessions=sessionResult.status==="fulfilled"&&Array.isArray(sessionResult.value)?sessionResult.value:[];
  const session=sessions.find(x=>String(x.username||"").toLowerCase()===username.toLowerCase())||null;
  const plans=packageResult.status==="fulfilled"?packageResult.value.rows:[];
  const payments=paymentResult.status==="fulfilled"?paymentResult.value.rows:[];
  const storedMac=callerIdResult.status==="fulfilled"?clean(callerIdResult.value.rows[0]?.caller_id,100):"";
  const packageDef=plans.find(x=>String(x.profileName||"").toLowerCase()===String(customer.profile||"").toLowerCase())||plans.find(x=>String(x.name||"").toLowerCase()===String(customer.package_name||"").toLowerCase());
  const expiration=normalizeDate(customer.expiration_date)||normalizeDate(secret?.comment?.match(/EXP:\s*(\d{4}-\d{2}-\d{2})/i)?.[1]);
  const today=bangladeshToday();
  const billing=evaluateCustomerBillingStatus({expiration_date:expiration});
  const remainingDays=billing.daysLeft;
  const disabled=Boolean(secret?.disabled)||String(customer.status||"").toLowerCase()==="inactive"||String(customer.status||"").toLowerCase()==="suspended";
   const formattedPhone=formatBdPhoneNumber(customer.phone);
  const status=disabled?(String(customer.status||"").toLowerCase()==="suspended"?"suspended":"inactive"):(expiration&&dateStatus(expiration)==="expired"?"expired":"active");
  return {
    customer:{id:customer.id,name:clean(customer.full_name,200),fullName:clean(customer.full_name,200),phone:formattedPhone,rawPhone:clean(customer.phone,40),alternativePhone:formatBdPhoneNumber(customer.alternative_phone),nid:clean(customer.nid,100),installationAddress:clean(customer.installation_address,1000),areaZone:clean(customer.area_zone,150),connectionDate:customer.connection_date,username,packageName:clean(customer.package_name||secret?.profile,120),profile:clean(customer.profile||secret?.profile,120),expirationDate:expiration||null,status,disabled,splitterBox:clean(customer.distribution_box||customer.fiber_box,150),onuMac:clean(customer.onu_mac,100),fiberCore:clean(customer.fiber_drop_core,80),oltPonPort:clean(customer.olt_pon_port,120),onuSerial:clean(customer.onu_serial,150),password:clean(secret?.password||customer.password,255),remoteAddress:clean(secret?.remoteAddress||customer.remote_address,100),poolName:clean(packageDef?.poolName,100),billingCycle:clean(customer.billing_cycle||"monthly",30),billingDurationDays:customer.billing_duration_days==null?null:Number(customer.billing_duration_days),billingExpiryOverride:Boolean(customer.billing_expiry_override),lastDisconnectReason:clean(customer.last_disconnect_reason,255),remainingDays,billing_status:billing.status,billing_badge_class:billing.badgeClass,badgeClass:billing.badgeClass,billing_label:billing.label,days_left:billing.daysLeft},
    live:{isLive:Boolean(session),online:Boolean(session),ip:clean(session?.address||"",100),mac:clean(session?.callerId||storedMac,100),uptime:clean(session?.uptime||"",100),bytesIn:session?.bytesIn||"0",bytesOut:session?.bytesOut||"0",lastDisconnectReason:clean(customer.last_disconnect_reason,255)},
    package:packageDef?{...packageDef,price:Number(packageDef.price||0),durationMonths:Number(packageDef.durationMonths||1),rateLimit:clean(packageDef.rateLimit,100)}:{name:clean(customer.package_name,120),profileName:clean(customer.profile,120),price:Number(customer.monthly_bill||0),durationMonths:1,rateLimit:"",poolName:""},
    plans:plans.map(x=>({...x,price:Number(x.price||0),durationMonths:Number(x.durationMonths||1),rateLimit:clean(x.rateLimit,100)})),
    payments:payments.map(x=>({trxId:clean(x.trx_id,100),amount:Number(x.amount||0),method:clean(x.method,30),date:x.created_at,status:clean(x.status,30),packageName:clean(customer.package_name||customer.profile,120)}))
  };
}
async function getCustomerProfileById(req,res){try{const payload=await resolveCustomer360(req.params.id);if(!payload)return res.status(404).json({success:false,message:"Customer not found."});return res.json({success:true,...payload});}catch(error){return errorResponse(res,error);}}
async function getCustomerLiveSession(req,res){
  try{
    const key=clean(req.params.id,100);
    const result=await db.query("SELECT id,username FROM customers WHERE id::text=$1 OR LOWER(username)=LOWER($1) LIMIT 1",[key]);
    const customer=result.rows[0];
    if(!customer)return res.status(404).json({success:false,message:"Customer not found."});
    const live=await mikrotikService.getPppoeLiveTraffic(customer.username);
    const storedResult=await db.query("SELECT caller_id FROM pppoe_users WHERE LOWER(username)=LOWER($1) LIMIT 1",[customer.username]);
    const storedMac=clean(storedResult.rows[0]?.caller_id,100);
    if(live.online&&live.mac){
      await db.query("UPDATE pppoe_users SET caller_id=$1,synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($2)",[live.mac,customer.username]);
    }else{
      live.mac=storedMac;
    }
    return res.json({success:true,live});
  }catch(error){
    console.warn("[Customer live session] Traffic lookup failed:",error.message);
    return res.status(503).json({success:false,message:"Live MikroTik traffic is temporarily unavailable."});
  }
}

function usageDate(value){return value instanceof Date?value.toISOString().slice(0,10):String(value||"").slice(0,10);}
function shiftUsageDate(value,days){
  const d=new Date(String(value).slice(0,10)+"T00:00:00Z");
  if(!Number.isFinite(d.getTime()))return usageDate(new Date());
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}
function previousCycleStart(expiryDate,cycle,durationDays){
  if(cycle==="custom_days"&&Number(durationDays)>0)return shiftUsageDate(expiryDate,-Number(durationDays));
  const d=new Date(String(expiryDate).slice(0,10)+"T00:00:00Z");
  if(!Number.isFinite(d.getTime()))return shiftUsageDate(usageDate(new Date()),-30);
  const day=d.getUTCDate();
  d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-1);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(day,last));
  return d.toISOString().slice(0,10);
}
async function getCustomerUsageRecords(req,res){
  try{
    const key=clean(req.params.id,100);
    const result=await db.query("SELECT id,username,expiration_date,billing_cycle,billing_duration_days,connection_date FROM customers WHERE id::text=$1 OR LOWER(username)=LOWER($1) LIMIT 1",[key]);
    const customer=result.rows[0];
    if(!customer)return res.status(404).json({success:false,message:"Customer not found."});
    const todayParts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Dhaka",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
    const today=todayParts.find(p=>p.type==="year").value+"-"+todayParts.find(p=>p.type==="month").value+"-"+todayParts.find(p=>p.type==="day").value;
    const expiry=usageDate(customer.expiration_date)||today;
    const cycle=String(customer.billing_cycle||"monthly");
    const cycleStart=previousCycleStart(expiry,cycle,customer.billing_duration_days);
    const ninetyDaysAgo=shiftUsageDate(today,-90);
    const fromDate=cycleStart<ninetyDaysAgo?cycleStart:ninetyDaysAgo;
    const q=await db.query(
      "SELECT usage_date,download_bytes,upload_bytes FROM customer_usage_daily WHERE customer_id=$1 AND usage_date >= $2::date AND usage_date <= $3::date ORDER BY usage_date DESC",
      [customer.id,fromDate,today]
    );
    const rows=q.rows.map(row=>({date:usageDate(row.usage_date),downloadBytes:String(row.download_bytes||0),uploadBytes:String(row.upload_bytes||0),totalBytes:(BigInt(row.download_bytes||0)+BigInt(row.upload_bytes||0)).toString()}));
    const cycleThrough=expiry<today?expiry:today;
    const current=rows.filter(row=>row.date>=cycleStart&&row.date<=cycleThrough);
    const sum=(arr,key)=>arr.reduce((total,row)=>total+BigInt(row[key]||0),0n).toString();
    return res.json({success:true,customer:{id:customer.id,username:customer.username},cycle:{type:cycle,durationDays:customer.billing_duration_days||null,startDate:cycleStart,endDate:expiry,throughDate:today},summary:{downloadBytes:sum(current,"downloadBytes"),uploadBytes:sum(current,"uploadBytes"),totalBytes:(BigInt(sum(current,"downloadBytes"))+BigInt(sum(current,"uploadBytes"))).toString(),recordedDays:current.length},daily:rows});
  }catch(error){console.warn("[Customer usage records] Failed:",error.message);return res.status(500).json({success:false,message:"Unable to load usage records."});}
}

async function kickCustomerById(req,res){try{const payload=await resolveCustomer360(req.params.id);if(!payload)return res.status(404).json({success:false,message:"Customer not found."});const result=await mikrotikService.kickActiveUser(payload.customer.username);if(result.kicked){await db.query("UPDATE customers SET last_disconnect_reason=$1,updated_at=NOW() WHERE id=$2",["Manual kick by admin",payload.customer.id]);await logAuditAction({customerId:payload.customer.id,adminId:getAdminId(req),action:"KICK",details:{message:"Customer PPPoE session force-disconnected from MikroTik",username:payload.customer.username,sessions:result.count||0},ipAddress:getIpAddress(req)});}return res.json({success:true,...result});}catch(error){return errorResponse(res,error);}}
async function toggleCustomerStatus(req,res){try{const payload=await resolveCustomer360(req.params.id);if(!payload)return res.status(404).json({success:false,message:"Customer not found."});const suspend=Boolean(req.body?.suspend);if(!suspend&&payload.customer.expirationDate&&dateStatus(payload.customer.expirationDate)==="expired")return res.status(409).json({success:false,message:"Customer is expired. Renew the package before reactivating the line."});const row=(await db.query("SELECT * FROM customers WHERE id=$1 LIMIT 1",[payload.customer.id])).rows[0];const targetProfile=suspend?clean(process.env.EXPIRED_PROFILE_NAME||"EXPIRED",100):clean(row.profile,100);const comment=buildExpirationComment(row.full_name,row.phone,normalizeDate(row.expiration_date)||bangladeshToday(),row.remarks);await mikrotikService.updateSecret(row.username,{password:row.password,profile:targetProfile,remoteAddress:row.remote_address,comment,disabled:suspend});await db.query("UPDATE customers SET status=$1,updated_at=NOW() WHERE id=$2",[suspend?"suspended":"active",row.id]);await db.query("UPDATE pppoe_users SET profile=$1,disabled=$2,status=$3,updated_at=NOW(),synced_at=NOW() WHERE LOWER(username)=LOWER($4)",[targetProfile,suspend,suspend?"suspended":"active",row.username]);if(suspend)await mikrotikService.kickActiveUser(row.username);await logAuditAction({customerId:row.id,adminId:getAdminId(req),action:suspend?"SUSPEND":"REACTIVATE",details:{message:suspend?"Account suspended. Moved to EXPIRED profile in MikroTik":`Account reactivated. Restored to ${row.profile} profile`,previousStatus:row.status,newStatus:suspend?"suspended":"active",previousProfile:row.profile,newProfile:targetProfile},ipAddress:getIpAddress(req)});return res.json({success:true,suspended,profile:targetProfile,message:suspend?"Customer line suspended.":"Customer line reactivated."});}catch(error){return errorResponse(res,error);}}
async function renewCustomerById(req,res){try{const payload=await resolveCustomer360(req.params.id);if(!payload)return res.status(404).json({success:false,message:"Customer not found."});const amount=Number(req.body?.amount),method=clean(req.body?.paymentMethod||req.body?.method||"cash",20).toLowerCase();let trxId=clean(req.body?.trxId,100);const price=Number(payload.package?.price||0);if(!Number.isFinite(amount)||Math.abs(amount-price)>0.009)return res.status(400).json({success:false,message:"Payment amount must exactly match the current package price of ৳"+price.toFixed(2)+"."});if(!["cash","bkash","nagad","rocket"].includes(method))return res.status(400).json({success:false,message:"Unsupported payment method."});if(method!=="cash"&&!trxId)return res.status(400).json({success:false,message:"Trx ID is required for mobile banking payments."});if(!trxId)trxId="CASH-"+Date.now()+"-"+payload.customer.id;const currentExp=normalizeDate(payload.customer.expirationDate),newExpDate=nextBillingExpiryDate(currentExp,payload.customer.billingCycle,payload.customer.billingDurationDays);
    // Always restore the configured package profile, never EXPIRED.
    const activeProfile=clean(payload.package?.profileName||payload.customer.profile,100);
    if(!activeProfile||activeProfile.toUpperCase()==="EXPIRED")throw new Error("Customer package profile is missing or invalid.");
    const comment=buildExpirationComment(payload.customer.name,payload.customer.phone,newExpDate,"Renewed via "+method);
    await mikrotikService.updateSecret(payload.customer.username,{password:payload.customer.password,profile:activeProfile,comment,disabled:false});
    await mikrotikService.kickActiveUser(payload.customer.username);await db.query("UPDATE customers SET expiration_date=$1,status='active',billing_status='paid',last_paid_at=NOW(),paid_until=$1,provisioning_status='provisioned',updated_at=NOW() WHERE id=$2",[newExpDate,payload.customer.id]);await db.query("UPDATE pppoe_users SET expiry_date=$1,status='active',disabled=FALSE,comment=$2,billing_status='paid',last_paid_at=NOW(),paid_until=$1,synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($3)",[newExpDate,comment,payload.customer.username]);await db.query("INSERT INTO transactions(channel,trx_id,amount,status,matched_username,sender_phone,used) VALUES($1,$2,$3,'PAID',$4,$5,TRUE)",[method,trxId,amount,payload.customer.username,payload.customer.phone]);await logAuditAction({customerId:payload.customer.id,adminId:getAdminId(req),action:"RENEW",details:{message:`Received ৳${amount.toFixed(2)} via ${method} (TrxID: ${trxId}). Extended validity to ${newExpDate}`,amount,method,trxId,newExpiration:newExpDate},ipAddress:getIpAddress(req)});return res.json({success:true,newExpDate,trxId,amount,method,message:"Payment recorded and customer renewed for 1 month."});}catch(error){return errorResponse(res,error);}}
async function changeCustomerPackage(req,res){
  try{
    const payload=await resolveCustomer360(req.params.id);
    if(!payload)return res.status(404).json({success:false,message:"Customer not found."});
    const packageId=clean(req.body?.packageId,50);
    const p=await db.query("SELECT id,plan_name,profile_name,pool_name,price,duration_months,rate_limit,remote_address FROM packages WHERE id::text=$1 LIMIT 1",[packageId]);
    if(!p.rows.length)return res.status(404).json({success:false,message:"Package not found."});

    const plan=p.rows[0];
    const expired=payload.customer.expirationDate&&dateStatus(payload.customer.expirationDate)==="expired";
    const effective=expired?clean(process.env.EXPIRED_PROFILE_NAME||"EXPIRED",100):clean(plan.profile_name||plan.plan_name,120);

    // Standard package changes MUST update only the PPP profile.
    // MikroTik assigns the IP from the selected /ppp/profile pool.
    // Never send remote-address from this endpoint.
    await mikrotikService.changeSecretProfile(payload.customer.username,effective);

    // Force an immediate PPPoE reconnect so the new profile/pool takes effect.
    let disconnected=false;
    try{
      const kickResult=await mikrotikService.kickActiveUser(payload.customer.username);
      disconnected=Boolean(kickResult?.kicked);
    }catch(kickError){
      console.warn("[CUSTOMER PACKAGE] Active session disconnect warning:",kickError.message);
    }

    // Package changes do not modify the customer's explicit static IP.
    await db.query(
      "UPDATE customers SET package_name=$1,profile=$2,monthly_bill=$3,status=$4,updated_at=NOW() WHERE id=$5",
      [plan.plan_name,plan.profile_name,plan.price,expired?"expired":"active",payload.customer.id]
    );
    await db.query(
      "UPDATE pppoe_users SET profile=$1,status=$2,disabled=$3,synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($4)",
      [effective,expired?"expired":"active",expired,payload.customer.username]
    );

    await logAuditAction({
      customerId:payload.customer.id,
      adminId:getAdminId(req),
      action:"CHANGE_PACKAGE",
      details:{
        message:`Package changed to ${plan.plan_name}`,
        previousPackage:payload.customer.packageName,
        previousProfile:payload.customer.profile,
        newPackage:plan.plan_name,
        newProfile:plan.profile_name,
        newPool:plan.pool_name,
        newRateLimit:plan.rate_limit,
        sessionDisconnected:disconnected
      },
      ipAddress:getIpAddress(req)
    });

    return res.json({
      success:true,
      package:{
        id:plan.id,
        name:plan.plan_name,
        profileName:plan.profile_name,
        price:Number(plan.price||0),
        rateLimit:plan.rate_limit,
        poolName:plan.pool_name
      },
      sessionDisconnected:disconnected,
      message:"Customer package changed successfully."
    });
  }catch(error){return errorResponse(res,error);}
}

module.exports = { evaluateCustomerBillingStatus, listCustomers, packages, createCustomer, getCustomer, updateCustomer, profile, publicCustomerCheck, publicCustomerLogin, markPaid, renew, removeCustomer, getCustomerProfileById, getCustomerLiveSession, getCustomerUsageRecords, getAuditLogs, kickCustomerById, toggleCustomerStatus, renewCustomerById, changeCustomerPackage };

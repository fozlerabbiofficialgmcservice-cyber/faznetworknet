const db=require("../db");
const mikrotikService=require("../services/mikrotikService");

const {parseSms}=require("../services/paymentWebhookParser");
function errorResponse(res,error,code=400){console.error("[Payment API]",error);const message=error?.message||"Payment operation failed.";return res.status(code).json({success:false,users:[],profiles:[],transactions:[],message,error:message});}

function normalizePhone(value){const bangla="০১২৩৪৫৬৭৮৯";let digits=String(value||"").replace(/[০-৯]/g,ch=>String(bangla.indexOf(ch))).replace(/\D/g,"");if(digits.startsWith("880")&&digits.length===13)digits="0"+digits.slice(3);return digits;}
function moneyCents(v){const n=Number(v);return Number.isFinite(n)?Math.round(n*100):NaN;}
function addCalendarMonths(v,months){const d=new Date(String(v||"")+"T00:00:00Z");if(Number.isNaN(d.getTime()))return null;const day=d.getUTCDate(),t=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+Number(months),1)),last=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,0)).getUTCDate();t.setUTCDate(Math.min(day,last));return t.toISOString().slice(0,10);}
async function getCustomerPackage(username){const r=await db.query("SELECT c.*,p.plan_name,p.pool_name,p.price,p.duration_months,p.profile_name FROM customers c LEFT JOIN packages p ON LOWER(p.plan_name)=LOWER(c.package_name) WHERE LOWER(c.username)=LOWER($1) LIMIT 1",[username]);return r.rows[0]||null;}
async function renewCustomer(c){const expiration=addCalendarMonths(new Date().toISOString().slice(0,10),Math.max(1,Number(c.duration_months||1))),profile=c.profile_name||c.profile,pool=c.pool_name||"",comment="Customer: "+c.full_name+" | Phone: "+c.phone+" | EXP: "+expiration;await mikrotikService.updateSecret(c.username,{password:c.password,profile,comment,disabled:false});await mikrotikService.kickActiveUser(c.username);await db.query("UPDATE customers SET package_name=$1,profile=$2,monthly_bill=$3,expiration_date=$4,status='active',updated_at=NOW() WHERE id=$5",[c.plan_name,profile,c.price,expiration,c.id]);await db.query("UPDATE pppoe_users SET profile=$1,remote_address=$2,disabled=false,status='active',expiry_date=$3,comment=$4,updated_at=NOW() WHERE username=$5",[profile,pool,expiration,comment,c.username]);return expiration;}
async function webhook(req,res){
 try{
  const configured=await db.query("SELECT key,value FROM app_settings WHERE key IN ('personal_payment_webhook_enabled','personal_payment_webhook_secret')");
  const settings=Object.fromEntries((configured.rows||[]).map(row=>[row.key,row.value]));
  if(String(settings.personal_payment_webhook_enabled||"").toLowerCase()!=="true")return res.status(403).json({success:false,error:"Automation disabled",message:"Personal payment webhook automation is disabled in Hotspot Webhook Settings."});
  const expected=String(settings.personal_payment_webhook_secret||"").trim();
  const provided=String((req.get("x-webhook-token")||req.get("x-macrodroid-token")||req.body?.token||req.body?.secret||req.query?.token)||"").trim();
  if(!expected||provided!==expected)return res.status(401).json({success:false,error:"Unauthorized webhook."});
  const payment=parseSms(req.body,req.query,req.headers);
  payment.trxId=String(payment.trxId||"").trim().toUpperCase();
  if(!payment.trxId)return res.status(400).json({success:false,error:"A valid TrxID is required."});
  const existing=await db.query("SELECT id,status,used FROM transactions WHERE UPPER(TRIM(trx_id))=$1 LIMIT 1",[payment.trxId]);
  // Never mutate the original transaction when MacroDroid retries delivery.
  if(existing.rows.length)return res.json({success:true,status:"duplicate",trx_id:payment.trxId,alreadyUsed:Boolean(existing.rows[0].used)});
  let user=null;
  if(payment.customerRef){
   const found=await db.query("SELECT username FROM pppoe_users WHERE LOWER(username)=LOWER($1) OR id::text=$1 LIMIT 1",[payment.customerRef]);
   user=found.rows[0]||null;
  }
  if(!user&&payment.senderPhone){
   const found=await db.query("SELECT username FROM pppoe_users WHERE phone=$1 LIMIT 1",[payment.senderPhone]);
   user=found.rows[0]||null;
  }
  let status="unmatched";
  if(user){
   const customer=await getCustomerPackage(user.username);
   if(customer&&customer.plan_name){
    const expectedAmount=Number(customer.price||0);
    if(moneyCents(payment.amount)!==moneyCents(expectedAmount)){
     await db.query("INSERT INTO transactions(channel,trx_id,sender_phone,amount,status,matched_username,raw_sms,used) VALUES($1,$2,$3,$4,'unmatched',$5,$6,false)",[payment.channel,payment.trxId,payment.senderPhone,payment.amount,user.username,payment.rawSms]);
     return res.status(400).json({success:false,message:`Payment rejected. Exact bill amount of ৳${expectedAmount.toFixed(2)} is required to activate or renew service.`,expectedAmount,paidAmount:payment.amount});
    }
    await renewCustomer(customer);status="PAID";
   }
  }
  await db.query("INSERT INTO transactions(channel,trx_id,sender_phone,amount,status,matched_username,raw_sms,used) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[payment.channel,payment.trxId,payment.senderPhone,payment.amount,status,user?user.username:null,payment.rawSms,Boolean(user)]);
  return res.json({success:true,status,trx_id:payment.trxId,customerRef:payment.customerRef,matched_username:user?user.username:null,amount:payment.amount,channel:payment.channel});
 }catch(error){return errorResponse(res,error,400);}
}
async function dynamicWebhook(req,res,next){
 try{
  const configured=await db.query("SELECT key,value FROM app_settings WHERE key IN ('personal_payment_webhook_url')");
  const url=String(configured.rows.find(row=>row.key==="personal_payment_webhook_url")?.value||"").trim();
  if(!url)return next();
  let configuredPath=url;
  try{configuredPath=new URL(url, "http://faznetwork.local").pathname;}catch(_){return next();}
  if(!configuredPath.startsWith("/"))configuredPath="/"+configuredPath;
  if(req.path!==configuredPath)return next();
  return webhook(req,res);
 }catch(error){return errorResponse(res,error,503);}
}
async function list(req,res){
 try{
  const gateway=String(req.query.gateway||req.query.channel||"all").trim().toLowerCase();
  const allowed=["all","bkash","nagad","rocket","upay","pending","requests"];
  if(!allowed.includes(gateway)) return res.status(400).json({success:false,error:"Invalid payment gateway filter."});
  const page=Math.max(1,Number.parseInt(req.query.page||"1",10)||1);
  const limit=Math.min(200,Math.max(1,Number.parseInt(req.query.limit||"50",10)||50));
  const offset=(page-1)*limit;
  const params=[];
  let where="";
  if(["bkash","nagad","rocket","upay"].includes(gateway)){params.push(gateway);where="WHERE channel=$1";}
  else if(gateway==="pending"){where="WHERE status='unmatched' OR (status IN ('processed','PAID') AND used=false)";}
  else if(gateway==="requests"){where="WHERE status='unmatched' AND used=false";}
  const countQuery=await db.query("SELECT COUNT(*)::int AS count FROM transactions "+where,params);
  const total=Number(countQuery.rows[0]?.count||0);
  params.push(limit,offset);
  const r=await db.query("SELECT * FROM transactions "+where+" ORDER BY created_at DESC, id DESC LIMIT $"+(params.length-1)+" OFFSET $"+params.length,params);
  const summaryParams=where ? params.slice(0,-2) : [];
  const summary=await db.query("SELECT COALESCE(SUM(amount),0)::numeric AS total_received, COUNT(*)::int AS total_transactions, COUNT(*) FILTER (WHERE status='unmatched')::int AS unmatched_count FROM transactions "+where,summaryParams);
  return res.json({success:true,gateway,page,limit,total,total_pages:Math.max(1,Math.ceil(total/limit)),transactions:r.rows,summary:summary.rows[0]});
 }catch(e){return errorResponse(res,e,503);}
}
async function manualMatch(req,res){
 try{
  const trxId=String(req.body.trxId||req.body.trxid||req.body.txnId||"").trim().toUpperCase();
  const username=String(req.body.username||"").trim();
  if(!trxId||!username)return res.status(400).json({success:false,error:"trxId and username are required."});

  const t=await db.query("SELECT * FROM transactions WHERE LOWER(trx_id)=LOWER($1) LIMIT 1",[trxId]);
  if(!t.rows.length)return res.status(404).json({success:false,error:"Transaction not found."});
  const tx=t.rows[0];
  if(tx.status==="duplicate")return res.status(409).json({success:false,error:"Duplicate transaction cannot be manually matched."});

  const user=await db.query("SELECT username FROM pppoe_users WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);
  if(!user.rows.length)return res.status(404).json({success:false,error:"PPPoE customer not found."});

  const customer=await getCustomerPackage(user.rows[0].username);if(!customer||!customer.plan_name)return res.status(400).json({success:false,error:"Customer has no linked billing package."});const expected=Number(customer.price||0);if(moneyCents(tx.amount)!==moneyCents(expected))return res.status(400).json({success:false,message:`Payment rejected. Exact bill amount of ৳${expected.toFixed(2)} is required to activate or renew service.`,expectedAmount:expected,paidAmount:Number(tx.amount)});const expiration=await renewCustomer(customer);await db.query("UPDATE transactions SET status='PAID',matched_username=$1,used=true WHERE id=$2",[user.rows[0].username,tx.id]);return res.json({success:true,trxId:tx.trx_id,username:user.rows[0].username,expiration,message:"Exact payment accepted; customer renewed and MikroTik service activated."});
 }catch(e){return errorResponse(res,e,503);}
}
async function summary(req,res){try{const r=await db.query("SELECT COALESCE(SUM(amount),0) AS today_collection,COUNT(*) FILTER(WHERE status IN ('processed','PAID')) AS processed_today FROM transactions WHERE created_at::date=CURRENT_DATE");const recent=await db.query("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 8");res.json({success:true,summary:r.rows[0],recent:r.rows});}catch(e){return errorResponse(res,e,503);}}

const verifyBuckets=new Map();
function rateLimit(key){const now=Date.now();const bucket=verifyBuckets.get(key)||{start:now,count:0};if(now-bucket.start>60000){bucket.start=now;bucket.count=0;}bucket.count++;verifyBuckets.set(key,bucket);return bucket.count<=10;}
async function verifyTrx(req,res){
 console.log('[VERIFY-TRX HIT]', req.body, req.query);
 const body=req.body&&typeof req.body==="object"?req.body:{};
 const query=req.query&&typeof req.query==="object"?req.query:{};
 const key=String(req.ip||"unknown");if(!rateLimit(key))return res.status(429).json({success:false,error:"Too many verification attempts. Try again later."});
 let claimedTransactionId=null;
 try{
  const phone=normalizePhone(body.username||body.phone||body.customer_phone||body.user||"");
  if(!/^01\d{9}$/.test(phone))return res.status(400).json({success:false,error:"A valid 11-digit Bangladeshi phone number is required."});
  const rawTrx = body.trxId || body.trx_id || body.transaction_id || body.trx || body.txnid || query.trxId || '';
  const cleanTrx = String(rawTrx).trim().toUpperCase();
  if(!cleanTrx)return res.status(400).json({success:false,error:"TrxID/TxnID is required."});
  console.log('[VERIFY-TRX QUERY PARAM]:', cleanTrx);
  const q=await db.query(`SELECT * FROM transactions
     WHERE UPPER(TRIM(trx_id)) = UPPER(TRIM($1))
       AND (used = false OR used IS NULL)
       AND LOWER(TRIM(status)) IN ('unmatched', 'pending', 'received', 'paid')
     LIMIT 1;`,[cleanTrx]);
  console.log('[VERIFY-TRX ROWS FOUND]:', q.rows.length);
  if(!q.rows.length){
   const existing=await db.query("SELECT status,used FROM transactions WHERE UPPER(TRIM(trx_id))=$1 LIMIT 1",[cleanTrx]);
   if(existing.rows.length&&(existing.rows[0].used||["processing","processed","PAID","duplicate"].includes(String(existing.rows[0].status||""))))return res.status(409).json({success:false,error:"This transaction has already been used or is being processed."});
   return res.status(404).json({success:false,error:"Transaction not found. Please wait for SMS verification."});
  }
  const tx=q.rows[0];
  const amount=Number(tx.amount),requestedAmount=Number(body.amount||0);
  if(requestedAmount&&Math.round(requestedAmount*100)!==Math.round(amount*100))return res.status(400).json({success:false,error:"Payment amount does not match the selected package."});
  const metadataResult=await db.query("SELECT value FROM app_settings WHERE key='hotspot_profile_metadata' LIMIT 1");
  let profileMetadata={};try{profileMetadata=JSON.parse(metadataResult.rows[0]?.value||"{}");}catch(_){}
  if(!profileMetadata||typeof profileMetadata!=="object"||Array.isArray(profileMetadata))profileMetadata={};
  const hotspotProfiles=await mikrotikService.getHotspotProfiles();
  const matchingProfiles=hotspotProfiles.filter(item=>{
   const metadata=profileMetadata[String(item.name||"")]||{};
   return Number.isFinite(Number(metadata.price))&&moneyCents(metadata.price)===moneyCents(amount);
  });
  if(!matchingProfiles.length)return res.status(400).json({success:false,error:"No active Hotspot profile currently has a price of ৳"+amount.toFixed(2)+". Update the price in Profile and retry.",expectedAmount:amount});
  const hotspotProfile=matchingProfiles[0];
  const metadata=profileMetadata[String(hotspotProfile.name||"")]||{};
  const {normalizeProfileValidity,parseStoredValidity}=require("../services/hotspotProfileConfig");
  let validityConfig;
  try{validityConfig=metadata.validityValue?normalizeProfileValidity(metadata.validityValue,metadata.validityUnit):parseStoredValidity(hotspotProfile);}catch(_){validityConfig=parseStoredValidity(hotspotProfile);}
  const validity=String(validityConfig.validity||"").trim();
  if(!validity&&!Number(metadata.limitBytesTotal||validityConfig.limitBytesTotal||0))return res.status(400).json({success:false,error:"The selected Hotspot profile has no usable validity or data quota configured."});
  // Atomic compare-and-set: only one concurrent request can claim this payment.
  // Mark it used before touching RouterOS so a parallel request cannot reset the
  // user's quota/counters by invoking rechargeHotspotUser a second time.
  const claim=await db.query(`UPDATE transactions
     SET used=true,status='processing',matched_username=$1
     WHERE id=$2 AND (used=false OR used IS NULL)
       AND LOWER(TRIM(status)) IN ('unmatched','pending','received','paid')
     RETURNING id;`,[phone,tx.id]);
  if(!claim.rows.length)return res.status(409).json({success:false,error:"This transaction has already been claimed by another verification request."});
  claimedTransactionId=tx.id;
  await mikrotikService.rechargeHotspotUser({username:phone,password:phone,profile:hotspotProfile.name,validity,limitBytesTotal:Number(metadata.limitBytesTotal||validityConfig.limitBytesTotal||0),comment:"FAZ PORTAL | TrxID: "+cleanTrx+" | Paid: ৳"+amount});
  await db.query("UPDATE transactions SET status='processed',used=true,matched_username=$1 WHERE id=$2 AND status='processing'",[phone,tx.id]);
  claimedTransactionId=null;
  return res.json({success:true,message:'সফল হয়েছে!',username:phone,password:phone,profile:hotspotProfile.name,validity,amount,loginUrl:body.loginUrl||body.linkLoginOnly||null});
 }catch(e){
  if(claimedTransactionId!==null){
   // Keep the claim locked on an ambiguous RouterOS/database failure. Automatically
   // releasing it could allow a retry to reset an already-created user's quota.
   console.error("[VERIFY-TRX] Transaction "+claimedTransactionId+" remains processing for reconciliation:",e?.message||e);
  }
  return errorResponse(res,e,503);
 }
}

module.exports={webhook,dynamicWebhook,list,manualMatch,summary,verifyTrx};

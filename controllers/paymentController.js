const db=require("../db");
const mikrotikService=require("../services/mikrotikService");

function normalizePhone(value){let p=String(value||"").replace(/[^\d+]/g,"");if(p.startsWith("+880"))p="0"+p.slice(4);if(p.startsWith("880"))p="0"+p.slice(3);return p;}
function channelFrom(text){const t=String(text||"").toLowerCase();if(/bkash|b-kash|বিকাশ/.test(t))return"bkash";if(/nagad|নগদ/.test(t))return"nagad";if(/rocket|রকেট|dutch.?bangla/.test(t))return"rocket";return null;}
function parseSms(body,headers){
 const raw=typeof body==="string"?body:JSON.stringify(body||{});
 const sender=String(headers["x-sms-sender"]||headers["x-sender"]||"");
 const text=raw+" "+sender;
 const channel=channelFrom(text);
 if(!channel)throw new Error("Unsupported payment channel.");
 const trx=(text.match(/(?:trx(?:id)?|transaction(?:\\s*id)?|txn(?:id)?)[\\s:#=-]*([A-Z0-9]{6,30})/i)||[])[1]||(text.match(/\\b([A-Z]{2,5}\\d{6,20})\\b/)||[])[1];
 const amountMatch=text.match(/(?:amount|received|payment|tk|taka|৳)[\\s:=\\-]*([0-9]{2,8}(?:[,.][0-9]{1,2})?)/i);
 const amount=amountMatch?Number(String(amountMatch[1]).replace(/,/g,"")):NaN;
 const phones=text.match(/(?:01\\d{9}|(?:\\+?88)?01\\d{9})/g)||[];
 const senderPhone=normalizePhone(phones[0]||"");
 const refMatch=text.match(/(?:Ref|Reference)\\s*[:]?[\\s]*([A-Za-z0-9_-]+)/i);
 const customerRef=refMatch?String(refMatch[1]).trim().replace(/[^A-Za-z0-9_-]/g,""):"";
 if(!trx||!Number.isFinite(amount)||amount<=0)throw new Error("Could not parse transaction ID or amount from SMS.");
 return{channel,trxId:trx.toUpperCase(),amount,senderPhone,customerRef,rawSms:raw};
}
function errorResponse(res,error,code=400){console.error("[Payment API]",error);const message=error?.message||"Payment operation failed.";return res.status(code).json({success:false,users:[],profiles:[],transactions:[],message,error:message});}

function moneyCents(v){const n=Number(v);return Number.isFinite(n)?Math.round(n*100):NaN;}
function addCalendarMonths(v,months){const d=new Date(String(v||"")+"T00:00:00Z");if(Number.isNaN(d.getTime()))return null;const day=d.getUTCDate(),t=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+Number(months),1)),last=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,0)).getUTCDate();t.setUTCDate(Math.min(day,last));return t.toISOString().slice(0,10);}
async function getCustomerPackage(username){const r=await db.query("SELECT c.*,p.plan_name,p.pool_name,p.price,p.duration_months,p.profile_name FROM customers c LEFT JOIN packages p ON LOWER(p.plan_name)=LOWER(c.package_name) WHERE LOWER(c.username)=LOWER($1) LIMIT 1",[username]);return r.rows[0]||null;}
async function renewCustomer(c){const expiration=addCalendarMonths(new Date().toISOString().slice(0,10),Math.max(1,Number(c.duration_months||1))),profile=c.profile_name||c.profile,pool=c.pool_name||"",comment="Customer: "+c.full_name+" | Phone: "+c.phone+" | EXP: "+expiration;await mikrotikService.updateSecret(c.username,{password:c.password,profile,remoteAddress:pool,comment,disabled:false});await mikrotikService.kickActiveUser(c.username);await db.query("UPDATE customers SET package_name=$1,profile=$2,monthly_bill=$3,expiration_date=$4,status='active',updated_at=NOW() WHERE id=$5",[c.plan_name,profile,c.price,expiration,c.id]);await db.query("UPDATE pppoe_users SET profile=$1,remote_address=$2,disabled=false,status='active',expiry_date=$3,comment=$4,updated_at=NOW() WHERE username=$5",[profile,pool,expiration,comment,c.username]);return expiration;}
async function webhook(req,res){
 const expected=String(process.env.MACRODROID_WEBHOOK_KEY||"");
 const provided=String(req.get("x-webhook-token")||req.get("x-macrodroid-token")||"");
 if(!expected||provided!==expected)return res.status(401).json({success:false,error:"Unauthorized webhook."});
 try{
  const payment=parseSms(req.body,req.headers);
  const existing=await db.query("SELECT id FROM transactions WHERE trx_id=$1",[payment.trxId]);
  if(existing.rows.length){await db.query("UPDATE transactions SET status='duplicate' WHERE id=$1",[existing.rows[0].id]);return res.json({success:true,status:"duplicate",trx_id:payment.trxId});}
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
  if(user){const customer=await getCustomerPackage(user.username);if(customer&&customer.plan_name){const expected=Number(customer.price||0);if(moneyCents(payment.amount)!==moneyCents(expected)){await db.query("INSERT INTO transactions(channel,trx_id,sender_phone,amount,status,matched_username,raw_sms,used) VALUES($1,$2,$3,$4,'unmatched',$5,$6,false)",[payment.channel,payment.trxId,payment.senderPhone,payment.amount,user.username,payment.rawSms]);return res.status(400).json({success:false,message:`Payment rejected. Exact bill amount of ৳${expected.toFixed(2)} is required to activate or renew service.`,expectedAmount:expected,paidAmount:payment.amount});}await renewCustomer(customer);status="processed";} }
  await db.query("INSERT INTO transactions(channel,trx_id,sender_phone,amount,status,matched_username,raw_sms,used) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[payment.channel,payment.trxId,payment.senderPhone,payment.amount,status,user?user.username:null,payment.rawSms,Boolean(user)]);
  return res.json({success:true,status,trx_id:payment.trxId,customerRef:payment.customerRef,matched_username:user?user.username:null,amount:payment.amount});
 }catch(error){return errorResponse(res,error,400);}
}
async function list(req,res){
 try{
  const gateway=String(req.query.gateway||req.query.channel||"all").trim().toLowerCase();
  const allowed=["all","bkash","nagad","rocket","pending","requests"];
  if(!allowed.includes(gateway)) return res.status(400).json({success:false,error:"Invalid payment gateway filter."});
  const page=Math.max(1,Number.parseInt(req.query.page||"1",10)||1);
  const limit=Math.min(200,Math.max(1,Number.parseInt(req.query.limit||"50",10)||50));
  const offset=(page-1)*limit;
  const params=[];
  let where="";
  if(["bkash","nagad","rocket"].includes(gateway)){params.push(gateway);where="WHERE channel=$1";}
  else if(gateway==="pending"){where="WHERE status='unmatched' OR (status='processed' AND used=false)";}
  else if(gateway==="requests"){where="WHERE status='unmatched' AND used=false";}

  const countQuery=await db.query("SELECT COUNT(*)::int AS count FROM transactions "+where,params);
  const total=Number(countQuery.rows[0]?.count||0);
  params.push(limit,offset);
  const r=await db.query("SELECT * FROM transactions "+where+" ORDER BY created_at DESC, id DESC LIMIT $"+(params.length-1)+" OFFSET $"+params.length,params);

  const summaryParams=where ? params.slice(0,-2) : [];
  const summary=await db.query(
    "SELECT COALESCE(SUM(amount),0)::numeric AS total_received, COUNT(*)::int AS total_transactions, COUNT(*) FILTER (WHERE status='unmatched')::int AS unmatched_count FROM transactions "+where,
    summaryParams
  );
  return res.json({
    success:true,gateway,page,limit,total,total_pages:Math.max(1,Math.ceil(total/limit)),
    transactions:r.rows,summary:summary.rows[0]
  });
 }catch(e){return errorResponse(res,e,503);}
}
async function manualMatch(req,res){
 try{
  const trxId=String(req.body.trxId||req.body.trxid||req.body.txnId||"").trim().toUpperCase();
  const username=String(req.body.username||"").trim();
  if(!trxId||!username)return res.status(400).json({success:false,error:"trxId and username are required."});

  const t=await db.query("SELECT * FROM transactions WHERE UPPER(trx_id)=UPPER($1) LIMIT 1",[trxId]);
  if(!t.rows.length)return res.status(404).json({success:false,error:"Transaction not found."});
  const tx=t.rows[0];
  if(tx.status==="duplicate")return res.status(409).json({success:false,error:"Duplicate transaction cannot be manually matched."});

  const user=await db.query("SELECT username FROM pppoe_users WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);
  if(!user.rows.length)return res.status(404).json({success:false,error:"PPPoE customer not found."});

  const customer=await getCustomerPackage(user.rows[0].username);if(!customer||!customer.plan_name)return res.status(400).json({success:false,error:"Customer has no linked billing package."});const expected=Number(customer.price||0);if(moneyCents(tx.amount)!==moneyCents(expected))return res.status(400).json({success:false,message:`Payment rejected. Exact bill amount of ৳${expected.toFixed(2)} is required to activate or renew service.`,expectedAmount:expected,paidAmount:Number(tx.amount)});const expiration=await renewCustomer(customer);await db.query("UPDATE transactions SET status='processed',matched_username=$1,used=true WHERE id=$2",[user.rows[0].username,tx.id]);return res.json({success:true,trxId:tx.trx_id,username:user.rows[0].username,expiration,message:"Exact payment accepted; customer renewed and MikroTik service activated."});
 }catch(e){return errorResponse(res,e,503);}
}
async function summary(req,res){try{const r=await db.query("SELECT COALESCE(SUM(amount),0) AS today_collection,COUNT(*) FILTER(WHERE status='processed') AS processed_today FROM transactions WHERE created_at::date=CURRENT_DATE");const recent=await db.query("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 8");res.json({success:true,summary:r.rows[0],recent:recent.rows});}catch(e){return errorResponse(res,e,503);}}

const verifyBuckets=new Map();
function rateLimit(key){const now=Date.now();const bucket=verifyBuckets.get(key)||{start:now,count:0};if(now-bucket.start>60000){bucket.start=now;bucket.count=0;}bucket.count++;verifyBuckets.set(key,bucket);return bucket.count<=10;}
async function verifyTrx(req,res){const key=String(req.ip||"unknown");if(!rateLimit(key))return res.status(429).json({success:false,error:"Too many verification attempts. Try again later."});try{const trx=String(req.body.trxId||req.body.trxid||req.body.txnId||req.body.txnid||"").trim().toUpperCase();if(!trx)return res.status(400).json({success:false,error:"TrxID/TxnID is required."});const q=await db.query("SELECT * FROM transactions WHERE trx_id=$1 LIMIT 1",[trx]);if(!q.rows.length)return res.status(404).json({success:false,error:"Transaction not found. Please wait for SMS verification."});const tx=q.rows[0];if(tx.used)return res.status(409).json({success:false,error:"This transaction has already been used."});if(tx.status==="duplicate")return res.status(409).json({success:false,error:"Duplicate transaction cannot be used."});const amount=Number(tx.amount);const requestedAmount=Number(req.body.amount||0);if(requestedAmount&&requestedAmount!==amount)return res.status(400).json({success:false,error:"Payment amount does not match the selected package."});const profile=PACKAGE_PROFILES[amount];if(!profile)return res.status(400).json({success:false,error:"No hotspot package is mapped to this payment amount."});const username=credential(),password=credential().slice(-8);await mikrotikService.createHotspotUser({username,password,profile,comment:"FAZ PORTAL | TrxID: "+trx+" | Package: "+PACKAGE_VALIDITY[amount]});await db.query("UPDATE transactions SET used=true,status='processed',matched_username=$1 WHERE id=$2",[username,tx.id]);return res.json({success:true,username,password,profile,package:PACKAGE_VALIDITY[amount],amount,loginUrl:req.body.loginUrl||req.body.linkLoginOnly||null});}catch(e){return errorResponse(res,e,503);}}

module.exports={webhook,list,manualMatch,summary,verifyTrx};
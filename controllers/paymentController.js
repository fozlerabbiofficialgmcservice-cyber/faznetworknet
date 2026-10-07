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
function errorResponse(res,error,code=400){console.error("[Payment API]",error);return res.status(code).json({success:false,error:error.message||"Payment operation failed."});}

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
  if(user){
   await db.query("UPDATE pppoe_users SET status='active',disabled=false,expiry_date=CASE WHEN expiry_date>NOW() THEN expiry_date+INTERVAL '30 days' ELSE NOW()+INTERVAL '30 days' END,updated_at=NOW() WHERE username=$1",[user.username]);
   await mikrotikService.toggleSecret(user.username,false);
   await mikrotikService.kickActiveUser(user.username);
   status="processed";
   console.log(`[PPPoE AUTO-RENEW] User: ${user.username} renewed for 30 days. TrxID: ${payment.trxId} | Amount: ${payment.amount}`);
  }
  await db.query("INSERT INTO transactions(channel,trx_id,sender_phone,amount,status,matched_username,raw_sms,used) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[payment.channel,payment.trxId,payment.senderPhone,payment.amount,status,user?user.username:null,payment.rawSms,Boolean(user)]);
  return res.json({success:true,status,trx_id:payment.trxId,customerRef:payment.customerRef,matched_username:user?user.username:null,amount:payment.amount});
 }catch(error){return errorResponse(res,error,400);}
}
async function list(req,res){try{const params=[];let where="";if(req.query.channel&&["bkash","nagad","rocket"].includes(String(req.query.channel))){params.push(String(req.query.channel));where="WHERE channel=$1";}const r=await db.query("SELECT * FROM transactions "+where+" ORDER BY created_at DESC LIMIT 500",params);res.json({success:true,transactions:r.rows});}catch(e){return errorResponse(res,e,503);}}
async function manualMatch(req,res){try{const id=Number(req.body.id),username=String(req.body.username||"").trim();if(!Number.isInteger(id)||!username)return res.status(400).json({success:false,error:"Transaction ID and username are required."});const t=await db.query("SELECT * FROM transactions WHERE id=$1",[id]);if(!t.rows.length)return res.status(404).json({success:false,error:"Transaction not found."});await db.query("UPDATE pppoe_users SET status='active',disabled=false,expiry_date=GREATEST(COALESCE(expiry_date,NOW()),NOW())+INTERVAL '30 days',updated_at=NOW() WHERE username=$1",[username]);await mikrotikService.toggleSecret(username,false);await mikrotikService.kickActiveUser(username);await db.query("UPDATE transactions SET status='processed',matched_username=$1 WHERE id=$2",[username,id]);res.json({success:true,message:"Payment matched and user activated."});}catch(e){return errorResponse(res,e,503);}}
async function summary(req,res){try{const r=await db.query("SELECT COALESCE(SUM(amount),0) AS today_collection,COUNT(*) FILTER(WHERE status='processed') AS processed_today FROM transactions WHERE created_at::date=CURRENT_DATE");const recent=await db.query("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 8");res.json({success:true,summary:r.rows[0],recent:recent.rows});}catch(e){return errorResponse(res,e,503);}}

const verifyBuckets=new Map();
function rateLimit(key){const now=Date.now();const bucket=verifyBuckets.get(key)||{start:now,count:0};if(now-bucket.start>60000){bucket.start=now;bucket.count=0;}bucket.count++;verifyBuckets.set(key,bucket);return bucket.count<=10;}
const PACKAGE_PROFILES={10:"Profile-1Hour",15:"Profile-12Hour",20:"Profile-1Day",40:"Profile-3Day",60:"Profile-7Day",90:"Profile-15Day",150:"Profile-30Day",200:"Profile-100GB",350:"Profile-300GB"};
const PACKAGE_VALIDITY={10:"1h",15:"12h",20:"1d",40:"3d",60:"7d",90:"15d",150:"30d",200:"100GB",350:"300GB"};
function credential(){return"FAZ"+Date.now().toString(36).slice(-6).toUpperCase()+Math.random().toString(36).slice(2,6).toUpperCase();}
async function verifyTrx(req,res){const key=String(req.ip||"unknown");if(!rateLimit(key))return res.status(429).json({success:false,error:"Too many verification attempts. Try again later."});try{const trx=String(req.body.trxId||req.body.trxid||req.body.txnId||req.body.txnid||"").trim().toUpperCase();if(!trx)return res.status(400).json({success:false,error:"TrxID/TxnID is required."});const q=await db.query("SELECT * FROM transactions WHERE trx_id=$1 LIMIT 1",[trx]);if(!q.rows.length)return res.status(404).json({success:false,error:"Transaction not found. Please wait for SMS verification."});const tx=q.rows[0];if(tx.used)return res.status(409).json({success:false,error:"This transaction has already been used."});if(tx.status==="duplicate")return res.status(409).json({success:false,error:"Duplicate transaction cannot be used."});const amount=Number(tx.amount);const requestedAmount=Number(req.body.amount||0);if(requestedAmount&&requestedAmount!==amount)return res.status(400).json({success:false,error:"Payment amount does not match the selected package."});const profile=PACKAGE_PROFILES[amount];if(!profile)return res.status(400).json({success:false,error:"No hotspot package is mapped to this payment amount."});const username=credential(),password=credential().slice(-8);await mikrotikService.createHotspotUser({username,password,profile,comment:"FAZ PORTAL | TrxID: "+trx+" | Package: "+PACKAGE_VALIDITY[amount]});await db.query("UPDATE transactions SET used=true,status='processed',matched_username=$1 WHERE id=$2",[username,tx.id]);return res.json({success:true,username,password,profile,package:PACKAGE_VALIDITY[amount],amount,loginUrl:req.body.loginUrl||req.body.linkLoginOnly||null});}catch(e){return errorResponse(res,e,503);}}

module.exports={webhook,list,manualMatch,summary,verifyTrx};
const db=require("../db");
const mikrotikService=require("../services/mikrotikService");

function normalizePhone(value){let p=String(value||"").replace(/[^\d+]/g,""); if(p.startsWith("+880")) p="0"+p.slice(4); if(p.startsWith("880")) p="0"+p.slice(3); return p;}
function channelFrom(text){const t=String(text||"").toLowerCase(); if(/bkash|b-kash|বিকাশ/.test(t)) return "bkash"; if(/nagad|নগদ/.test(t)) return "nagad"; if(/rocket|রকেট|dutch.?bangla/.test(t)) return "rocket"; return null;}
function parseSms(body,headers){const raw=typeof body==="string"?body:JSON.stringify(body||{}); const sender=String(headers["x-sms-sender"]||headers["x-sender"]||""); const text=raw+" "+sender;
 const channel=channelFrom(text); if(!channel) throw new Error("Unsupported payment channel. Could not detect bKash, Nagad, or Rocket.");
 const trx=(text.match(/(?:trx(?:id)?|transaction(?:\s*id)?|txn(?:id)?)[\s:#=-]*([A-Z0-9]{6,30})/i)||[])[1] || (text.match(/\b([A-Z]{2,5}\d{6,20})\b/)||[])[1];
 const amountMatch=text.match(/(?:amount|received|payment|tk|taka|৳)[\s:=\-]*([0-9]{2,8}(?:[,.][0-9]{1,2})?)/i);
 const amount=amountMatch?Number(String(amountMatch[1]).replace(/,/g,"")):NaN;
 const phones=text.match(/(?:01\d{9}|(?:\+?88)?01\d{9})/g)||[];
 const senderPhone=normalizePhone(phones[0]||"");
 if(!trx || !Number.isFinite(amount) || amount<=0) throw new Error("Could not parse transaction ID or amount from SMS.");
 return {channel,trxId:trx.toUpperCase(),amount,senderPhone,rawSms:raw};
}
function errorResponse(res,error,code=400){console.error("[Payment Webhook]",error);return res.status(code).json({success:false,error:error.message||"Payment webhook failed."});}

async function webhook(req,res){
 const expected=String(process.env.MACRODROID_WEBHOOK_KEY||""); const provided=String(req.get("x-webhook-token")||"");
 if(!expected || provided!==expected) return res.status(401).json({success:false,error:"Unauthorized webhook."});
 try{
  const payment=parseSms(req.body,req.headers);
  const existing=await db.query("SELECT id,status FROM transactions WHERE trx_id=$1",[payment.trxId]);
  if(existing.rows.length){await db.query("UPDATE transactions SET status='duplicate' WHERE id=$1",[existing.rows[0].id]); return res.status(200).json({success:true,status:"duplicate",trx_id:payment.trxId});}
  let user=null;
  if(payment.senderPhone) { const found=await db.query("SELECT username FROM pppoe_users WHERE RIGHT(regexp_replace(phone,'[^0-9]','','g'),10)=RIGHT($1,10) OR RIGHT(regexp_replace(comment,'[^0-9]','','g'),10)=RIGHT($1,10) LIMIT 1",[payment.senderPhone]); user=found.rows[0]||null; }
  if(!user && req.body && typeof req.body==="object" && req.body.username){const found=await db.query("SELECT username FROM pppoe_users WHERE username=$1",[String(req.body.username).trim()]);user=found.rows[0]||null;}
  let status="unmatched";
  if(user){
    await db.query("UPDATE pppoe_users SET status='active',disabled=false,expiry_date=GREATEST(COALESCE(expiry_date,NOW()),NOW()) + INTERVAL '30 days',updated_at=NOW() WHERE username=$1",[user.username]);
    await mikrotikService.toggleSecret(user.username,false);
    await mikrotikService.kickActiveUser(user.username);
    status="processed";
  }
  await db.query("INSERT INTO transactions(channel,trx_id,sender_phone,amount,status,matched_username,raw_sms) VALUES($1,$2,$3,$4,$5,$6,$7)",[payment.channel,payment.trxId,payment.senderPhone,payment.amount,status,user?user.username:null,payment.rawSms]);
  return res.status(200).json({success:true,status,trx_id:payment.trxId,matched_username:user?user.username:null,amount:payment.amount});
 }catch(error){return errorResponse(res,error,400);}
}

async function list(req,res){try{const r=await db.query("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500");res.json({success:true,transactions:r.rows});}catch(e){return errorResponse(res,e,503);}}
async function manualMatch(req,res){try{const id=Number(req.body.id),username=String(req.body.username||"").trim();if(!Number.isInteger(id)||!username)return res.status(400).json({success:false,error:"Transaction ID and username are required."});const t=await db.query("SELECT * FROM transactions WHERE id=$1",[id]);if(!t.rows.length)return res.status(404).json({success:false,error:"Transaction not found."});await db.query("UPDATE pppoe_users SET status='active',disabled=false,expiry_date=GREATEST(COALESCE(expiry_date,NOW()),NOW()) + INTERVAL '30 days',updated_at=NOW() WHERE username=$1",[username]);await mikrotikService.toggleSecret(username,false);await mikrotikService.kickActiveUser(username);await db.query("UPDATE transactions SET status='processed',matched_username=$1 WHERE id=$2",[username,id]);res.json({success:true,message:"Payment matched and user activated."});}catch(e){return errorResponse(res,e,503);}}
async function summary(req,res){try{const r=await db.query("SELECT COALESCE(SUM(amount),0) AS today_collection, COUNT(*) FILTER (WHERE status='processed') AS processed_today FROM transactions WHERE created_at::date=CURRENT_DATE");const recent=await db.query("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 8");res.json({success:true,summary:r.rows[0],recent:recent.rows});}catch(e){return errorResponse(res,e,503);}}
module.exports={webhook,list,manualMatch,summary};

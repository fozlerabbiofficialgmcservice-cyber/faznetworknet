const db=require("../db");
const mikrotikService=require("../services/mikrotikService");

let running=false;
function dhakaDate(){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Dhaka",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const get=k=>parts.find(p=>p.type===k)?.value||"";
  return get("year")+"-"+get("month")+"-"+get("day");
}
async function collectCustomerUsage(){
  if(running)return {skipped:true};
  running=true;
  let sampled=0,failed=0;
  try{
    const customers=await db.query("SELECT id,username FROM customers WHERE COALESCE(username,'')<>'' AND LOWER(COALESCE(status,'')) NOT IN ('left') ORDER BY id");
    const date=dhakaDate();
    for(const customer of customers.rows){
      try{
        const live=await mikrotikService.getPppoeLiveTraffic(customer.username);
        if(!live.online)continue;
        const download=Math.max(0,Math.trunc(Number(live.downloadBytes??live.bytesOut)||0));
        const upload=Math.max(0,Math.trunc(Number(live.uploadBytes??live.bytesIn)||0));
        const prevResult=await db.query("SELECT download_bytes,upload_bytes,session_id,interface_name FROM customer_usage_counters WHERE customer_id=$1",[customer.id]);
        const prev=prevResult.rows[0];
        // On the first sample establish a baseline. Counter resets/session changes start a new baseline.
        let downloadDelta=0,uploadDelta=0;
        if(prev){
          downloadDelta=download>=Number(prev.download_bytes)?download-Number(prev.download_bytes):download;
          uploadDelta=upload>=Number(prev.upload_bytes)?upload-Number(prev.upload_bytes):upload;
          if(prev.session_id&&live.sessionId&&prev.session_id!==live.sessionId){downloadDelta=download;uploadDelta=upload;}
        }
        await db.query(
          "INSERT INTO customer_usage_counters(customer_id,username,interface_name,download_bytes,upload_bytes,session_id,sampled_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(customer_id) DO UPDATE SET username=EXCLUDED.username,interface_name=EXCLUDED.interface_name,download_bytes=EXCLUDED.download_bytes,upload_bytes=EXCLUDED.upload_bytes,session_id=EXCLUDED.session_id,sampled_at=NOW()",
          [customer.id,customer.username,live.interface||null,download,upload,live.sessionId||null]
        );
        if(downloadDelta||uploadDelta){
          await db.query(
            "INSERT INTO customer_usage_daily(customer_id,usage_date,download_bytes,upload_bytes,updated_at) VALUES($1,$2::date,$3,$4,NOW()) ON CONFLICT(customer_id,usage_date) DO UPDATE SET download_bytes=customer_usage_daily.download_bytes+EXCLUDED.download_bytes,upload_bytes=customer_usage_daily.upload_bytes+EXCLUDED.upload_bytes,updated_at=NOW()",
            [customer.id,date,downloadDelta,uploadDelta]
          );
        }else{
          await db.query("INSERT INTO customer_usage_daily(customer_id,usage_date) VALUES($1,$2::date) ON CONFLICT(customer_id,usage_date) DO NOTHING",[customer.id,date]);
        }
        sampled++;
      }catch(error){failed++;console.warn("[USAGE RECORD] Failed for "+customer.username+": "+error.message);}
    }
    if(sampled||failed)console.log("[USAGE RECORD] Sampled="+sampled+" failed="+failed+" date="+date);
    return {sampled,failed};
  }catch(error){console.error("[USAGE RECORD] Collector failed:",error.message);return {sampled,failed:failed+1,error:error.message};}
  finally{running=false;}
}
function startUsageCollector(){
  collectCustomerUsage().catch(e=>console.error("[USAGE RECORD] Initial sample failed:",e.message));
  return setInterval(()=>collectCustomerUsage().catch(e=>console.error("[USAGE RECORD] Scheduled sample failed:",e.message)),5*60*1000);
}
module.exports={collectCustomerUsage,startUsageCollector};

const db=require("../db");
const mikrotikService=require("../services/mikrotikService");
const {logAuditAction}=require("../utils/auditLogger");

const EXPIRED_PROFILE=String(process.env.EXPIRED_PROFILE_NAME||"EXPIRED").trim()||"EXPIRED";

async function runBillingExpiration(){
  const startedAt=Date.now();
  try{
    // expiration_date is a Bangladesh calendar date. Migration overrides still
    // transition to expired billing status, but the worker preserves the live line.
    const q=await db.query(
      "SELECT id,username,full_name,phone,expiration_date,status,billing_expiry_override FROM customers WHERE expiration_date IS NOT NULL AND expiration_date < CURRENT_DATE AND LOWER(COALESCE(status,'')) <> 'expired' ORDER BY expiration_date ASC,id ASC"
    );
    if(!q.rows.length){
      console.log("[BILLING EXPIRATION] No overdue customers found.");
      return {checked:0,expired:0,failed:0};
    }

    let expired=0,failed=0;
    for(const customer of q.rows){
      try{
        if(customer.billing_expiry_override){
          // Migration override means expiry still updates billing status, but must
          // not change the live router profile, disable the secret, or kick sessions.
          await db.query("UPDATE customers SET status='expired',billing_status='unpaid',updated_at=NOW() WHERE id=$1",[customer.id]);
          await db.query("UPDATE pppoe_users SET status='expired',billing_status='unpaid',synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($1)",[customer.username]);
          await logAuditAction({customerId:customer.id,adminId:"billing-cron",action:"AUTO_EXPIRE_STATUS_ONLY",details:{message:"Billing expiry reached; migration override preserved the live connection",username:customer.username,expirationDate:customer.expiration_date,connectionPreserved:true},ipAddress:null});
          expired++;
          continue;
        }
        // changeSecretProfile resolves the live /ppp/secret .id and emits exactly:
        // ['/ppp/secret/set', '=.id=<secretId>', '=profile=EXPIRED']
        await mikrotikService.changeSecretProfile(customer.username,EXPIRED_PROFILE);

        // Force a fresh PPPoE authentication so the EXPIRED profile's pool is used.
        let disconnected=false;
        try{
          const result=await mikrotikService.kickActiveUser(customer.username);
          disconnected=Boolean(result?.kicked);
        }catch(kickError){
          console.warn("[BILLING EXPIRATION] Session reset warning for "+customer.username+":",kickError.message);
        }

        await db.query(
          "UPDATE customers SET status='expired',billing_status='unpaid',updated_at=NOW() WHERE id=$1",
          [customer.id]
        );
        await db.query(
          "UPDATE pppoe_users SET profile=$1,status='expired',disabled=FALSE,billing_status='unpaid',synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($2)",
          [EXPIRED_PROFILE,customer.username]
        );

        await logAuditAction({
          customerId:customer.id,
          adminId:"billing-cron",
          action:"AUTO_EXPIRE",
          details:{
            message:"Auto-expired: Moved to EXPIRED profile due to unpaid bill",
            username:customer.username,
            expirationDate:customer.expiration_date,
            expiredProfile:EXPIRED_PROFILE,
            sessionDisconnected:disconnected
          },
          ipAddress:null
        });
        expired++;
      }catch(error){
        failed++;
        console.error("[BILLING EXPIRATION] Failed for "+customer.username+":",error.message);
      }
    }

    console.log("[BILLING EXPIRATION] Completed. checked="+q.rows.length+" expired="+expired+" failed="+failed+" durationMs="+(Date.now()-startedAt));
    return {checked:q.rows.length,expired,failed};
  }catch(error){
    console.error("[BILLING EXPIRATION] Worker failed:",error.message);
    return {checked:0,expired:0,failed:1,error:error.message};
  }
}

function startBillingCron(){
  runBillingExpiration().catch(error=>console.error("[BILLING EXPIRATION] Initial run failed:",error.message));
  return setInterval(
    ()=>runBillingExpiration().catch(error=>console.error("[BILLING EXPIRATION] Scheduled run failed:",error.message)),
    60*60*1000
  );
}

module.exports={runBillingExpiration,startBillingCron,EXPIRED_PROFILE};

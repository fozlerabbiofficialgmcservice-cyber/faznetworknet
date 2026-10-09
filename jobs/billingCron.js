const db=require("../db");
const mikrotikService=require("../services/mikrotikService");
const {logAuditAction}=require("../utils/auditLogger");

const EXPIRED_PROFILE="EXPIRED-PROFILE";

async function runBillingExpiration(){
  const startedAt=Date.now();
  try{
    // expiration_date is a Bangladesh calendar date. Migration overrides still
    // transition to expired billing status, but the worker preserves the live line.
    const q=await db.query(
      "SELECT c.id,c.username,c.full_name,c.phone,c.expiration_date,c.status,c.billing_expiry_override,u.profile AS router_profile,u.disabled AS router_disabled FROM customers c LEFT JOIN pppoe_users u ON LOWER(u.username)=LOWER(c.username) WHERE c.expiration_date IS NOT NULL AND c.expiration_date < CURRENT_DATE AND LOWER(COALESCE(c.status,'')) NOT IN ('suspended','inactive','left') AND (LOWER(COALESCE(c.status,'')) <> 'expired' OR LOWER(COALESCE(u.profile,'')) <> LOWER($1)) ORDER BY c.expiration_date ASC,c.id ASC",
      [EXPIRED_PROFILE]
    );
    if(!q.rows.length){
      console.log("[BILLING EXPIRATION] No overdue customers found.");
      return {checked:0,expired:0,failed:0};
    }

    await mikrotikService.ensureExpiredProfile();
    let expired=0,failed=0;
    for(const customer of q.rows){
      try{
        // changeSecretProfile resolves the live /ppp/secret .id and emits exactly:
        // ['/ppp/secret/set', '=.id=<secretId>', '=profile=EXPIRED-PROFILE']
        // Expiration must leave the secret enabled; repair legacy disabled state for eligible expired subscribers.
        await mikrotikService.toggleSecret(customer.username,false);
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
            message:"Auto-expired: Moved to EXPIRED-PROFILE (1k/1k) due to unpaid bill",
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

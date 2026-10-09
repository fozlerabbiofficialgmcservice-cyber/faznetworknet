const db=require("../db");
const mikrotikService=require("../services/mikrotikService");
const {logAuditAction}=require("../utils/auditLogger");

const EXPIRED_PROFILE="EXPIRED-PROFILE";

async function runBillingExpiration(){
  const startedAt=Date.now();
  try{
    // Expiration dates are Bangladesh calendar dates. An explicit migration
    // override allows billing to be marked expired without changing live service.
    const q=await db.query(
      "SELECT id,username,full_name,phone,expiration_date,status,billing_expiry_override FROM customers WHERE expiration_date IS NOT NULL AND expiration_date < CURRENT_DATE AND LOWER(COALESCE(status,'')) NOT IN ('suspended','inactive','left') AND (LOWER(COALESCE(status,'')) <> 'expired' OR NOT EXISTS (SELECT 1 FROM pppoe_users u WHERE LOWER(u.username)=LOWER(customers.username) AND LOWER(COALESCE(u.profile,''))=LOWER($1))) ORDER BY expiration_date ASC,id ASC",
      [EXPIRED_PROFILE]
    );
    if(!q.rows.length){
      console.log("[BILLING EXPIRATION] No overdue customers found.");
      return {checked:0,expired:0,failed:0};
    }

    // The quarantine profile is only needed for subscribers without an explicit
    // migration override. Never touch MikroTik for override customers.
    if(q.rows.some(customer=>customer.billing_expiry_override!==true)){
      await mikrotikService.ensureExpiredProfile();
    }
    let expired=0,failed=0;
    for(const customer of q.rows){
      try{
        const overridden=customer.billing_expiry_override===true;
        let disconnected=false;
        if(!overridden){
          // Keep the PPPoE secret enabled, move it to the quarantine profile,
          // and reset its session so the profile's rate limit takes effect.
          await mikrotikService.toggleSecret(customer.username,false);
          await mikrotikService.changeSecretProfile(customer.username,EXPIRED_PROFILE);
          try{
            const result=await mikrotikService.kickActiveUser(customer.username);
            disconnected=Boolean(result?.kicked);
          }catch(kickError){
            console.warn("[BILLING EXPIRATION] Session reset warning for "+customer.username+":",kickError.message);
          }
        }

        await db.query(
          "UPDATE customers SET status='expired',billing_status='unpaid',updated_at=NOW() WHERE id=$1",
          [customer.id]
        );
        if(overridden){
          // Persist the billing state only; preserve profile, disabled flag and
          // active session for an explicitly overridden migration customer.
          await db.query(
            "UPDATE pppoe_users SET status='expired',billing_status='unpaid',synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($1)",
            [customer.username]
          );
        }else{
          await db.query(
            "UPDATE pppoe_users SET profile=$1,status='expired',disabled=FALSE,billing_status='unpaid',synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($2)",
            [EXPIRED_PROFILE,customer.username]
          );
        }

        await logAuditAction({
          customerId:customer.id,
          adminId:"billing-cron",
          action:"AUTO_EXPIRE",
          details:{
            message:overridden
              ?"Billing marked expired under explicit migration override; live PPPoE service unchanged"
              :"Auto-expired: Moved to EXPIRED-PROFILE (1k/1k) due to unpaid bill",
            username:customer.username,
            expirationDate:customer.expiration_date,
            expiredProfile:overridden?null:EXPIRED_PROFILE,
            migrationOverride:overridden,
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

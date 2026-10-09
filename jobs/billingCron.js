const db=require("../db");
const mikrotikService=require("../services/mikrotikService");
const {logAuditAction}=require("../utils/auditLogger");

const EXPIRED_PROFILE="EXPIRED-PROFILE";


async function runExpiryWarnings(){
  try{
    const settings=await require("../services/appSettings").getAllSettings();
    if(!["bulk_sms","personal_device"].includes(String(settings.sms_gateway_mode||"disabled"))||
       !require("../services/appSettings").bool(settings.sms_event_expiry_warning))return {checked:0,sent:0};
    const due=await db.query(
      "SELECT username,full_name,monthly_bill,phone,expiration_date FROM customers WHERE expiration_date=CURRENT_DATE+3 AND phone IS NOT NULL AND BTRIM(phone)<>'' AND LOWER(COALESCE(status,'')) NOT IN ('expired','inactive','left','suspended') ORDER BY expiration_date,username"
    );
    let sent=0;
    for(const customer of due.rows||[]){
      const eventKey="expiry_warning:"+String(customer.username).toLowerCase()+":"+String(customer.expiration_date).slice(0,10);
      const claim=await db.query(
        "INSERT INTO sms_notification_log(event_key,event_type,username,phone,status) VALUES($1,'expiry_warning',$2,$3,'pending') ON CONFLICT(event_key) DO NOTHING RETURNING event_key",
        [eventKey,customer.username,customer.phone]
      );
      if(!claim.rows.length)continue;
      try{
        const result=await require("../services/smsService").sendNotification({
          to:customer.phone,
          message:"Reminder from FAZ NETWORK: your internet bill expires in 3 days. Please renew on time to avoid service interruption.",
          event:"expiry_warning",variables:{name:customer.full_name||customer.username,username:customer.username,amount:customer.monthly_bill,expiry_date:String(customer.expiration_date).slice(0,10)}
        });
        if(result.skipped){
          await db.query("DELETE FROM sms_notification_log WHERE event_key=$1",[eventKey]);
        }else{
          await db.query("UPDATE sms_notification_log SET status='sent',sent_at=NOW() WHERE event_key=$1",[eventKey]);
          sent++;
        }
      }catch(error){
        await db.query("DELETE FROM sms_notification_log WHERE event_key=$1",[eventKey]).catch(()=>{});
        console.warn("[SMS] Expiry warning failed for "+customer.username+":",error.message);
      }
    }
    return {checked:(due.rows||[]).length,sent};
  }catch(error){
    console.warn("[SMS] Expiry warning scan skipped:",error.message);
    return {checked:0,sent:0};
  }
}

async function runBillingExpiration(){
  const startedAt=Date.now();
  try{
    await runExpiryWarnings();
    const policyRows=await db.query("SELECT key,value FROM app_settings WHERE key IN ('grace_period_days','expiry_action')");
    const policy=Object.fromEntries((policyRows.rows||[]).map(row=>[row.key,row.value]));
    const graceDays=Math.max(0,Math.min(7,Number.parseInt(policy.grace_period_days||"0",10)||0));
    const expiryAction=policy.expiry_action==="disable_secret"?"disable_secret":"quarantine";
    // Expiration dates are Bangladesh calendar dates. An explicit migration
    // override allows billing to be marked expired without changing live service.
    const q=await db.query(
      "SELECT id,username,full_name,phone,expiration_date,status,billing_expiry_override FROM customers WHERE expiration_date IS NOT NULL AND expiration_date < CURRENT_DATE - $2::int AND LOWER(COALESCE(status,'')) NOT IN ('suspended','inactive','left') AND (LOWER(COALESCE(status,'')) <> 'expired' OR NOT EXISTS (SELECT 1 FROM pppoe_users u WHERE LOWER(u.username)=LOWER(customers.username) AND LOWER(COALESCE(u.profile,''))=LOWER($1))) ORDER BY expiration_date ASC,id ASC",
      [EXPIRED_PROFILE,graceDays]
    );
    if(!q.rows.length){
      console.log("[BILLING EXPIRATION] No overdue customers found.");
      return {checked:0,expired:0,failed:0};
    }

    // The quarantine profile is only needed for subscribers without an explicit
    // migration override. Never touch MikroTik for override customers.
    if(expiryAction==="quarantine"&&q.rows.some(customer=>customer.billing_expiry_override!==true)){
      await mikrotikService.ensureExpiredProfile();
    }
    let expired=0,failed=0;
    for(const customer of q.rows){
      try{
        const overridden=customer.billing_expiry_override===true;
        let disconnected=false;
        if(!overridden){
          if(expiryAction==="disable_secret"){
            await mikrotikService.toggleSecret(customer.username,true);
          }else{
            // Quarantine preserves the secret and MAC visibility while applying the expired profile.
            await mikrotikService.toggleSecret(customer.username,false);
            await mikrotikService.changeSecretProfile(customer.username,EXPIRED_PROFILE);
          }
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
        }else if(expiryAction==="disable_secret"){
          await db.query(
            "UPDATE pppoe_users SET status='expired',disabled=TRUE,billing_status='unpaid',synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($1)",
            [customer.username]
          );
        }else{
          await db.query(
            "UPDATE pppoe_users SET profile=$1,status='expired',disabled=FALSE,billing_status='unpaid',synced_at=NOW(),updated_at=NOW() WHERE LOWER(username)=LOWER($2)",
            [EXPIRED_PROFILE,customer.username]
          );
        }

        if(!overridden&&customer.phone){
          Promise.resolve().then(()=>require("../services/smsService").sendNotification({to:customer.phone,message:"Your FAZ NETWORK internet service has expired due to unpaid bill. Please renew to restore service.",event:"line_expiry",variables:{name:customer.full_name||customer.username,username:customer.username}})).catch(error=>console.warn("[SMS] Expiry notice failed for "+customer.username+":",error.message));
        }

        await logAuditAction({
          customerId:customer.id,
          adminId:"billing-cron",
          action:"AUTO_EXPIRE",
          details:{
            message:overridden
              ?"Billing marked expired under explicit migration override; live PPPoE service unchanged"
              :expiryAction==="disable_secret"
                ?"Auto-expired: PPPoE secret disabled due to unpaid bill"
                :"Auto-expired: Moved to EXPIRED-PROFILE (1k/1k) due to unpaid bill",
            username:customer.username,
            expirationDate:customer.expiration_date,
            expiredProfile:overridden||expiryAction==="disable_secret"?null:EXPIRED_PROFILE,
            expiryAction:overridden?"migration_override":expiryAction,
            gracePeriodDays:graceDays,
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

module.exports={runBillingExpiration,startBillingCron,runExpiryWarnings,EXPIRED_PROFILE};

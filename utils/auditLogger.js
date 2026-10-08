const db=require("../db");

function getAdminId(req){return String(req?.session?.adminUser||req?.user?.username||"admin").slice(0,100);}
function getIpAddress(req){
  const forwarded=String(req?.headers?.["x-forwarded-for"]||"").split(",")[0].trim();
  return String(forwarded||req?.ip||req?.socket?.remoteAddress||"").slice(0,50)||null;
}
async function logAuditAction({customerId,adminId="admin",action,details,ipAddress}){
  try{
    await db.query(
      `INSERT INTO audit_logs (customer_id,admin_id,action,details,ip_address)
       VALUES ($1,$2,$3,$4,$5)`,
      [customerId||null,String(adminId||"admin").slice(0,100),String(action||"UNKNOWN").slice(0,50),
       typeof details==="object"?JSON.stringify(details):String(details||""),ipAddress?String(ipAddress).slice(0,50):null]
    );
  }catch(err){console.error("Audit Log Error:",err.message);}
}
module.exports={logAuditAction,getAdminId,getIpAddress};

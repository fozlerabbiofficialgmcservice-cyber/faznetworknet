const crypto=require("crypto");const db=require("../db");const mikrotikService=require("../services/mikrotikService");
function clean(v,max=255){return String(v??"").trim().slice(0,max)}
function errorResponse(res,e){console.error("[Hotspot API]",e);const message=e?.message||"Hotspot operation failed.";return res.status(e?.statusCode||503).json({success:false,users:[],profiles:[],message,error:message});}
function randomPin(length=8){return crypto.randomBytes(Math.ceil(length*1.5)).toString("base64url").replace(/[^A-Za-z0-9]/g,"").slice(0,length).toUpperCase();}
function normalizeFilter(value){const filter=String(value||"all").trim().toLowerCase();return ["all","active","online"].includes(filter)?filter:"all";}
function validityMs(value){const m=String(value||"").trim().match(/^(\\d+(?:\\.\\d+)?)\\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i);if(!m)return 0;const n=Number(m[1]),u=m[2].toLowerCase();const unit=u.startsWith("m")?60000:u.startsWith("h")?3600000:u.startsWith("w")?604800000:86400000;return n*unit;}
function voucherValidUntil(createdAt,validity){const ms=validityMs(validity);return ms?new Date(new Date(createdAt).getTime()+ms):null;}
async function page(req,res){res.render("hotspot",{title:"Hotspot Vouchers",page:"hotspot"});}
async function profiles(req,res){try{const data=await mikrotikService.getHotspotProfiles();res.json({success:true,profiles:data});}catch(e){return errorResponse(res,e);}}
function buildHotspotOnLoginScript(validity,sharedUsers){
 const v=String(validity||"").trim();
 const macLock=Number(sharedUsers||1)===1
   ? ':local loginMac $"mac-address"; :if ([:len $loginMac] > 0) do={ /ip hotspot user set [find name=$user] mac-address=$loginMac; };'
   : '';
 const safeValidity=v.replace(/"/g,'');
 return ':local validity "'+safeValidity+'"; :local userName $user; '+macLock+' :if ([:len [/system scheduler find name=("hs-exp-" . $userName)]] = 0) do={ /system scheduler add name=("hs-exp-" . $userName) interval=$validity start-time=[/system clock get time] on-event=(":local u \\"" . $userName . "\\"; /ip hotspot active remove [find user=$u]; /ip hotspot user disable [find name=$u]; /system scheduler remove [find name=(\\"hs-exp-\\" . $u)];"); };';
}
function normalizeProfileValidity(value,unit){
 const n=Math.max(1,Number(value)||0);
 const u=String(unit||"d").toLowerCase();
 if(!Number.isInteger(n)||!["m","h","d"].includes(u)) throw new Error("Validity value and unit must be valid.");
 return {value:n,unit:u,validity:n+u};
}
async function createProfile(req,res){
 try{
  const name=clean(req.body.name,100);
  const rateLimit=clean(req.body.rateLimit,100);
  const sharedUsers=Math.max(1,Number(req.body.sharedUsers)||1);
  const validity=normalizeProfileValidity(req.body.validityValue,req.body.validityUnit);
  if(!name||name.toLowerCase()==="default") return res.status(400).json({success:false,message:"A custom profile name is required."});
  if(!rateLimit) return res.status(400).json({success:false,message:"Rate limit / speed is required."});
  const onLogin=buildHotspotOnLoginScript(validity.validity,sharedUsers);
  const result=await mikrotikService.createHotspotProfile({name,rateLimit,sharedUsers,sessionTimeout:validity.validity,keepaliveTimeout:clean(req.body.keepaliveTimeout,50),onLogin});
  res.json({success:true,message:"Hotspot profile created successfully in MikroTik.",profile:{...result,rateLimit,sharedUsers,validityValue:validity.value,validityUnit:validity.unit,sessionTimeout:validity.validity,onLogin}});
 }catch(e){return errorResponse(res,e);}
}
async function updateProfile(req,res){
 try{
  const name=clean(req.body.name,100);
  const rateLimit=clean(req.body.rateLimit,100);
  const sharedUsers=Math.max(1,Number(req.body.sharedUsers)||1);
  const validity=normalizeProfileValidity(req.body.validityValue,req.body.validityUnit);
  if(!name||name.toLowerCase()==="default") return res.status(400).json({success:false,message:"A custom profile name is required."});
  if(!rateLimit) return res.status(400).json({success:false,message:"Rate limit / speed is required."});
  const onLogin=buildHotspotOnLoginScript(validity.validity,sharedUsers);
  const result=await mikrotikService.updateHotspotProfile({name,rateLimit,sharedUsers,sessionTimeout:validity.validity,keepaliveTimeout:clean(req.body.keepaliveTimeout,50),onLogin});
  res.json({success:true,message:"Hotspot profile updated successfully in MikroTik.",profile:{...result,rateLimit,sharedUsers,validityValue:validity.value,validityUnit:validity.unit,sessionTimeout:validity.validity,onLogin}});
 }catch(e){return errorResponse(res,e);}
}
async function deleteProfile(req,res){
 try{
  const name=clean(req.body.name,100);
  if(!name||name.toLowerCase()==="default") return res.status(400).json({success:false,message:"The default profile cannot be deleted here."});
  const result=await mikrotikService.deleteHotspotProfile(name);
  res.json({success:true,message:"Hotspot profile deleted successfully from MikroTik.",profile:result});
 }catch(e){return errorResponse(res,e);}
}
async function serverProfiles(req,res){try{const data=await mikrotikService.getHotspotServerProfiles();res.json({success:true,profiles:data});}catch(e){return errorResponse(res,e);}}
async function list(req,res){try{
 const filter=normalizeFilter(req.query.filter);
 const needSessions=filter==="online"||filter==="active";
 const [dbRows,mikrotikUsers,sessions]=await Promise.all([
   db.query("SELECT * FROM hotspot_vouchers ORDER BY created_at DESC LIMIT 5000"),
   mikrotikService.getHotspotUsers(),
   needSessions?mikrotikService.getActiveHotspotSessions():Promise.resolve([])
 ]);
 const isExplicitCustomer=function(user){
   const username=String(user?.username||user?.name||"").trim().toLowerCase();
   const profile=String(user?.profile||"").trim().toLowerCase();
   return Boolean(username&&username!=="default-trial"&&profile&&profile!=="default-trial");
 };
 const customerMikrotikUsers=mikrotikUsers.filter(isExplicitCustomer);
 const customerSessions=sessions.filter(isExplicitCustomer);
 const mtMap=new Map(customerMikrotikUsers.map(u=>[u.username,u]));
 const onlineMap=new Map(customerSessions.map(s=>[s.username,s]));
 const dbMap=new Map(dbRows.rows.filter(isExplicitCustomer).map(v=>[v.username,v]));
 const allNames=new Set([...dbMap.keys(),...mtMap.keys()]);
 let vouchers=[...allNames].map(username=>{
   const v=dbMap.get(username)||{},mt=mtMap.get(username)||null,validUntil=v.created_at?voucherValidUntil(v.created_at,v.validity):null,online=onlineMap.get(username)||null;
   const dbValid=Boolean(validUntil&&validUntil.getTime()>Date.now()),mtValid=Boolean(online||mt);
   return {id:v.id||null,username,password:v.password||mt?.password||"",profile:v.profile||mt?.profile||"",validity:v.validity||mt?.validity||"",price:Number(v.price||mt?.price||0),status:v.status||((mt&&!mt.disabled)?"active":"unused"),comment:v.comment||mt?.comment||"",created_at:v.created_at||null,mikrotik:mt,online,valid_until:validUntil?validUntil.toISOString():null,active:(v.status!=="expired"&&(dbValid||mtValid))};
 });
 if(filter==="active") vouchers=vouchers.filter(v=>v.active);
 if(filter==="online") vouchers=customerSessions.map(s=>({id:s.id,username:s.username,password:mtMap.get(s.username)?.password||"",profile:s.profile||mtMap.get(s.username)?.profile||"",validity:mtMap.get(s.username)?.validity||"",price:Number(mtMap.get(s.username)?.price||0),status:"active",comment:"Live MikroTik session",created_at:null,online:s,active:true,address:s.address,mac_address:s.macAddress,uptime:s.uptime,bytes_in:s.bytesIn,bytes_out:s.bytesOut,session_time_left:s.sessionTimeLeft}));
 res.json({success:true,filter,count:vouchers.length,users:vouchers,sessions:customerSessions});
}catch(e){return errorResponse(res,e);}}async function active(req,res){req.query.filter="online";return list(req,res);}
async function generate(req,res){try{
 const quantity=Math.min(Math.max(Number(req.body.quantity)||0,1),500);
 const profile=clean(req.body.profile,100),validity=clean(req.body.validity,50),price=Number(req.body.price);
 const userPrefix=clean(req.body.userPrefix||"FAZ-",20).replace(/[^A-Za-z0-9_-]/g,"")||"FAZ-";
 const charLength=Math.min(Math.max(Number(req.body.charLength)||6,4),16);
 if(!profile||!validity||!Number.isFinite(price)||price<0)return res.status(400).json({success:false,error:"Profile, validity, and valid price are required."});
 const created=[];
 for(let i=0;i<quantity;i++){
   let username="",password="",unique=false;
   for(let attempt=0;attempt<30&&!unique;attempt++){
     username=userPrefix+randomPin(charLength); password=randomPin(charLength);
     const exists=await db.query("SELECT 1 FROM hotspot_vouchers WHERE username=$1",[username]);
     unique=!exists.rows.length;
   }
   if(!unique)throw new Error("Could not generate a unique voucher username. Please try again.");
   await mikrotikService.createHotspotUser({username,password,profile,comment:"Auto-Generated"});
   try{
     await db.query("INSERT INTO hotspot_vouchers(username,password,profile,validity,price,status,comment) VALUES($1,$2,$3,$4,$5,'unused',$6)",[username,password,profile,validity,price,"Auto-Generated"]);
   }catch(dbError){try{await mikrotikService.removeHotspotUser(username);}catch(_){ }throw dbError;}
   created.push({username,password,profile,validity,price,status:"unused"});
 }
 res.json({success:true,count:created.length,vouchers:created});
}catch(e){return errorResponse(res,e);}}
async function createUser(req,res){
  try{
    const username=clean(req.body.username,100);
    const password=clean(req.body.password,100);
    const profile=clean(req.body.profile,100);
    const server=clean(req.body.server||"all",100)||"all";
    const timeLimit=clean(req.body.timeLimit,50);
    const dataLimit=clean(req.body.dataLimit,50);
    const comment=clean(req.body.comment,500);
    const phone=clean(req.body.phone,40);
    const price=Number(req.body.price||0);
    if(!username||!password||!profile)return res.status(400).json({success:false,message:"Username, password, and profile are required."});
    if(!/^[A-Za-z0-9._@-]{2,100}$/.test(username))return res.status(400).json({success:false,message:"Username contains unsupported characters."});
    if(!Number.isFinite(price)||price<0)return res.status(400).json({success:false,message:"Price must be a valid non-negative amount."});
    const existingDb=await db.query("SELECT 1 FROM hotspot_vouchers WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);
    if(existingDb.rows.length)return res.status(409).json({success:false,message:"Hotspot username already exists in database."});
    const mtUsers=await mikrotikService.getHotspotUsers();
    if(mtUsers.some(u=>String(u.username||"").toLowerCase()===username.toLowerCase()))return res.status(409).json({success:false,message:"Hotspot username already exists in MikroTik."});
    await mikrotikService.createHotspotUser({username,password,profile,server,"limit-uptime":timeLimit,"limit-bytes-total":dataLimit,comment});
    try{
      await db.query("INSERT INTO hotspot_vouchers(username,password,profile,validity,price,status,comment,phone,server,time_limit,data_limit) VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10)",
        [username,password,profile,timeLimit||"custom",price,comment,phone,server,timeLimit||null,dataLimit||null]);
    }catch(dbError){
      try{await mikrotikService.removeHotspotUser(username);}catch(_){}
      throw dbError;
    }
    return res.json({success:true,message:"Hotspot user created successfully in MikroTik & DB",user:{username,profile,server,timeLimit,dataLimit,price,phone,comment}});
  }catch(e){return errorResponse(res,e);}
}
async function dashboardMetrics(req,res){
  try{
    const [users,sessions,revenue]=await Promise.all([
      mikrotikService.getHotspotUsers(),
      mikrotikService.getActiveHotspotSessions(),
      db.query("SELECT COALESCE(SUM(price),0) AS total FROM hotspot_vouchers WHERE created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + INTERVAL '1 day'")
    ]);
    const explicit=users.filter(u=>String(u.username||"").toLowerCase()!=="default-trial"&&String(u.profile||"").trim()&&String(u.profile||"").toLowerCase()!=="default-trial");
    const live=sessions.filter(s=>String(s.username||"").toLowerCase()!=="default-trial");
    const recentActiveSessions=live.slice(-5).reverse().map(s=>({username:s.username,ip:s.address,mac:s.macAddress,uptime:s.uptime,rxBytes:s.bytesIn,txBytes:s.bytesOut}));
    const totalBytes=live.reduce((sum,s)=>sum+Number(s.bytesIn||0)+Number(s.bytesOut||0),0);
    return res.json({success:true,totalUsers:explicit.length,onlineUsers:live.length,todayRevenue:Number(revenue.rows?.[0]?.total||0),totalActiveBandwidthUsage:totalBytes,recentActiveSessions});
  }catch(e){return errorResponse(res,e);}
}
async function kick(req,res){try{const username=clean(req.body.username,100),id=clean(req.body.id,100);if(!username&&!id)return res.status(400).json({success:false,error:"Username or session id is required."});const result=await mikrotikService.kickActiveHotspotUser(username,id);res.json({success:true,...result});}catch(e){return errorResponse(res,e);}}
async function remove(req,res){try{
 const username=clean(req.body.username,100);if(!username)return res.status(400).json({success:false,error:"Username is required."});
 await mikrotikService.removeHotspotUser(username);
 await db.query("UPDATE hotspot_vouchers SET status='expired' WHERE username=$1",[username]);
 res.json({success:true,username});
}catch(e){return errorResponse(res,e);}}
module.exports={page,profiles,createProfile,updateProfile,deleteProfile,serverProfiles,list,active,generate,createUser,dashboardMetrics,kick,remove};
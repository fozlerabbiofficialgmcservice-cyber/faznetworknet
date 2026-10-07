const crypto=require("crypto");const db=require("../db");const mikrotikService=require("../services/mikrotikService");
function clean(v,max=255){return String(v??"").trim().slice(0,max)}
function errorResponse(res,e){console.error("[Hotspot API]",e);const message=e?.message||"Hotspot operation failed.";return res.status(e?.statusCode||503).json({success:false,users:[],profiles:[],message,error:message});}
function randomPin(length=8){return crypto.randomBytes(Math.ceil(length*1.5)).toString("base64url").replace(/[^A-Za-z0-9]/g,"").slice(0,length).toUpperCase();}
function normalizeFilter(value){const filter=String(value||"all").trim().toLowerCase();return ["all","active","online"].includes(filter)?filter:"all";}
function validityMs(value){const m=String(value||"").trim().match(/^(\\d+(?:\\.\\d+)?)\\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i);if(!m)return 0;const n=Number(m[1]),u=m[2].toLowerCase();const unit=u.startsWith("m")?60000:u.startsWith("h")?3600000:u.startsWith("w")?604800000:86400000;return n*unit;}
function voucherValidUntil(createdAt,validity){const ms=validityMs(validity);return ms?new Date(new Date(createdAt).getTime()+ms):null;}
async function page(req,res){res.render("hotspot",{title:"Hotspot Vouchers",page:"hotspot"});}
async function profiles(req,res){try{const data=await mikrotikService.getHotspotProfiles();res.json({success:true,profiles:data});}catch(e){return errorResponse(res,e);}}
async function serverProfiles(req,res){try{const data=await mikrotikService.getHotspotServerProfiles();res.json({success:true,profiles:data});}catch(e){return errorResponse(res,e);}}
async function list(req,res){try{
 const filter=normalizeFilter(req.query.filter);
 const [dbRows,mikrotikUsers,sessions]=await Promise.all([db.query("SELECT * FROM hotspot_vouchers ORDER BY created_at DESC LIMIT 5000"),mikrotikService.getHotspotUsers(),filter==="online"?mikrotikService.getActiveHotspotSessions():Promise.resolve([])]);
 const mtMap=new Map(mikrotikUsers.map(u=>[u.username,u]));
 const onlineMap=new Map(sessions.map(s=>[s.username,s]));
 const dbMap=new Map(dbRows.rows.map(v=>[v.username,v]));
 const allNames=new Set([...dbMap.keys(),...mtMap.keys()]);
 let vouchers=[...allNames].map(username=>{
   const v=dbMap.get(username)||{}, mt=mtMap.get(username)||null;
   const validUntil=v.created_at?voucherValidUntil(v.created_at,v.validity):null;
   return {id:v.id||null,username,password:v.password||mt?.password||"",profile:v.profile||mt?.profile||"",validity:v.validity||"",price:Number(v.price||0),status:v.status||((mt&&!mt.disabled)?"active":"unused"),comment:v.comment||mt?.comment||"",created_at:v.created_at||null,mikrotik:mt,online:onlineMap.get(username)||null,valid_until:validUntil?validUntil.toISOString():null,active:!!v.created_at&&v.status!=="expired"&&(!validUntil||validUntil.getTime()>Date.now())};
 });
 if(filter==="active") vouchers=vouchers.filter(v=>v.active);
 if(filter==="online") vouchers=sessions.map(s=>({id:null,username:s.username,password:mtMap.get(s.username)?.password||"",profile:s.profile||mtMap.get(s.username)?.profile||"",validity:mtMap.get(s.username)?.validity||"",price:mtMap.get(s.username)?.price||0,status:"active",comment:"Live MikroTik session",created_at:null,online:s}));
 res.json({success:true,filter,count:vouchers.length,users:vouchers,sessions}); 
}catch(e){return errorResponse(res,e);}}
async function active(req,res){req.query.filter="online";return list(req,res);}
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
async function kick(req,res){try{const username=clean(req.body.username,100);if(!username)return res.status(400).json({success:false,error:"Username is required."});const result=await mikrotikService.kickActiveHotspotUser(username);res.json({success:true,...result});}catch(e){return errorResponse(res,e);}}
async function remove(req,res){try{
 const username=clean(req.body.username,100);if(!username)return res.status(400).json({success:false,error:"Username is required."});
 await mikrotikService.removeHotspotUser(username);
 await db.query("UPDATE hotspot_vouchers SET status='expired' WHERE username=$1",[username]);
 res.json({success:true,username});
}catch(e){return errorResponse(res,e);}}
module.exports={page,profiles,serverProfiles,list,active,generate,kick,remove};
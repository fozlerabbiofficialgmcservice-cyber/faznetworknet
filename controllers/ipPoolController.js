const db = require("../db");
const mikrotikService = require("../services/mikrotikService");

function clean(value, max = 255) { return String(value ?? "").trim().slice(0, max); }
function errorResponse(res, error) {
  console.error("[IP POOL API]", error);
  const message = error?.message || "IP pool operation failed.";
  return res.status(error?.statusCode || 503).json({ success: false, message, error: message });
}
function ipv4ToNumber(value) {
  const parts=String(value||"").split(".");
  if(parts.length!==4||parts.some(part=>!/^\d{1,3}$/.test(part)||Number(part)>255))return null;
  return parts.reduce((total,part)=>total*256+Number(part),0);
}
function validRangePart(value) {
  const part=clean(value,100);
  if(/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(part)){const [ip,prefix]=part.split("/");return ipv4ToNumber(ip)!==null&&Number(prefix)>=0&&Number(prefix)<=32;}
  const match=part.match(/^(\d{1,3}(?:\.\d{1,3}){3})-(\d{1,3}(?:\.\d{1,3}){3})$/);
  if(!match)return false;
  const start=ipv4ToNumber(match[1]),end=ipv4ToNumber(match[2]);
  return start!==null&&end!==null&&start<=end;
}
function normalizePayload(body){
  const name=clean(body?.name,100),ranges=clean(body?.ranges,1000),nextPool=clean(body?.nextPool||body?.["next-pool"],100);
  if(!name)throw new Error("IP pool name is required.");
  if(/^default(?:[-_].*)?$/i.test(name))throw new Error("Default system IP pool names cannot be managed here.");
  if(!ranges)throw new Error("IP ranges are required.");
  if(ranges.split(",").some(part=>!validRangePart(part)))throw new Error("Enter valid IPv4 subnet/range values, separated by commas.");
  return {name,ranges,nextPool};
}
async function list(req,res){
  try{
    const rows=await mikrotikService.getIpPools();
    return res.json(rows.filter(pool=>!/^default(?:[-_].*)?$/i.test(String(pool.name||"").trim())).map(pool=>({id:pool.id,name:pool.name,ranges:pool.ranges,nextPool:pool.nextPool||""})));
  }catch(error){return errorResponse(res,error);}
}
async function saveOrUpdateIpPool(req,res){
  try{
    const body=req.body||{};
    const originalName=clean(body.originalName||body.original_name,100);
    const name=clean(body.name||originalName,100);
    const ranges=clean(body.ranges,1000).split(",").map(x=>x.trim().replace(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g,(_,ip)=>ip.split(".").map(x=>String(Number(x))).join("."))).filter(Boolean).join(",");
    const nextPool=clean(body.nextPool||body["next-pool"],100);
    const localAddress=clean(body.localAddress||body.local_address,255);
    const subnet=clean(body.subnet,50);
    if(!name||!ranges)return res.status(400).json({success:false,message:"Pool Name and Valid IP Ranges are required"});
    if(/^default(?:[-_].*)?$/i.test(name))return res.status(400).json({success:false,message:"Default system IP pool names cannot be managed here."});
    if(ranges.split(",").some(part=>!validRangePart(part)))return res.status(400).json({success:false,message:"Enter valid IPv4 subnet/range values, separated by commas."});
    const pools=await mikrotikService.getIpPools();
    const existing=originalName?pools.find(x=>String(x.name).toLowerCase()===originalName.toLowerCase()):null;
    const targetNext=nextPool&&!/^none$/i.test(nextPool)?nextPool:"none";
    const result=existing?await mikrotikService.updateIpPool(existing.id,{name,ranges,nextPool:targetNext}):await mikrotikService.createIpPool({name,ranges,nextPool:targetNext});
    try{
      const device=await mikrotikService.getRouterIdentity();
      await db.query("INSERT INTO ip_pools(name,ranges,local_address,subnet,device_name,next_pool,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(device_name,name) DO UPDATE SET ranges=EXCLUDED.ranges,local_address=EXCLUDED.local_address,subnet=EXCLUDED.subnet,next_pool=EXCLUDED.next_pool,updated_at=NOW()",[name,ranges,localAddress||null,subnet||null,device,targetNext]);
      if(existing&&existing.name.toLowerCase()!==name.toLowerCase())await db.query("DELETE FROM ip_pools WHERE device_name=$1 AND name=$2",[device,existing.name]);
    }catch(dbErr){console.warn("[DB ip_pools warning]:",dbErr.message);}
    return res.json({success:true,message:'IP Pool "'+name+'" saved and synced with MikroTik!',pool:result});
  }catch(error){return errorResponse(res,error,500);}
}
async function create(req,res){return saveOrUpdateIpPool(req,res);}
async function update(req,res){return saveOrUpdateIpPool(req,res);}
async function remove(req,res){
  try{const identifier=clean(req.params.id,100);if(!identifier||/^default(?:[-_].*)?$/i.test(identifier))return res.status(400).json({success:false,message:"The default system IP pool cannot be deleted."});const result=await mikrotikService.deleteIpPool(identifier);return res.json({success:true,message:"IP pool removed successfully from MikroTik.",pool:result});}
  catch(error){return errorResponse(res,error);}
}
module.exports={list,create,update,saveOrUpdateIpPool,remove};

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
async function create(req,res){
  try{const payload=normalizePayload(req.body||{});const result=await mikrotikService.createIpPool(payload);return res.status(201).json({success:true,message:"IP pool created successfully in MikroTik.",pool:result});}
  catch(error){return errorResponse(res,error);}
}
async function update(req,res){
  try{const payload=normalizePayload(req.body||{}),identifier=clean(req.params.id,100);if(!identifier)return res.status(400).json({success:false,message:"IP pool id or name is required."});const result=await mikrotikService.updateIpPool(identifier,payload);return res.json({success:true,message:"IP pool updated successfully in MikroTik.",pool:result});}
  catch(error){return errorResponse(res,error);}
}
async function remove(req,res){
  try{const identifier=clean(req.params.id,100);if(!identifier||/^default(?:[-_].*)?$/i.test(identifier))return res.status(400).json({success:false,message:"The default system IP pool cannot be deleted."});const result=await mikrotikService.deleteIpPool(identifier);return res.json({success:true,message:"IP pool removed successfully from MikroTik.",pool:result});}
  catch(error){return errorResponse(res,error);}
}
module.exports={list,create,update,remove};

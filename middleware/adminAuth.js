const crypto=require("crypto");

const COOKIE_NAME="faz_admin_session";
const SESSION_TTL_SECONDS=8*60*60;

function secret(){
  return String(process.env.ADMIN_SESSION_SECRET||process.env.SESSION_SECRET||"").trim();
}

function sign(payload){
  const key=secret();
  if(!key) return "";
  return crypto.createHmac("sha256",key).update(payload).digest("base64url");
}

function parseCookie(header){
  const out={};
  for(const part of String(header||"").split(";")){
    const index=part.indexOf("=");
    if(index<0) continue;
    const key=part.slice(0,index).trim();
    const value=part.slice(index+1).trim();
    out[key]=decodeURIComponent(value);
  }
  return out;
}

function createToken(username){
  const payload=Buffer.from(JSON.stringify({u:String(username),exp:Math.floor(Date.now()/1000)+SESSION_TTL_SECONDS})).toString("base64url");
  return payload+"."+sign(payload);
}

function verifyToken(token){
  if(!token||!secret()) return null;
  const [payload,signature]=String(token).split(".");
  if(!payload||!signature||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(sign(payload)))) return null;
  try{
    const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    return data&&data.exp>Math.floor(Date.now()/1000)?data:null;
  }catch(_){return null;}
}

function isAdminAuthenticated(req){
  const cookies=parseCookie(req.headers.cookie);
  return Boolean(verifyToken(cookies[COOKIE_NAME]));
}

function setSessionCookie(res,username){
  const token=createToken(username);
  const secure=process.env.NODE_ENV==="production"?"; Secure":"";
  res.setHeader("Set-Cookie",`${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function clearSessionCookie(res){
  res.setHeader("Set-Cookie",`${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV==="production"?"; Secure":""}`);
}

function requireAdmin(req,res,next){
  if(isAdminAuthenticated(req)) return next();
  if(req.path.startsWith("/api/")) return res.status(401).json({success:false,message:"Admin authentication required."});
  return res.redirect("/login?next="+encodeURIComponent(req.originalUrl||"/admin"));
}

function adminCredentialsValid(username,password){
  const configuredUser=String(process.env.ADMIN_USERNAME||"admin").trim();
  const inputUser=String(username||"").trim();
  if(!inputUser||inputUser.toLowerCase()!==configuredUser.toLowerCase()) return false;
  const plain=String(process.env.ADMIN_PASSWORD||"");
  if(plain&&String(password||"")===plain) return true;
  const hash=String(process.env.ADMIN_PASSWORD_HASH||"");
  if(!hash) return false;
  try{
    const bcrypt=require("bcryptjs");
    return bcrypt.compareSync(String(password||""),hash);
  }catch(_){return false;}
}

module.exports={COOKIE_NAME,isAdminAuthenticated,setSessionCookie,clearSessionCookie,requireAdmin,adminCredentialsValid};

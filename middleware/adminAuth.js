const crypto=require("crypto");

const COOKIE_NAME="faz_admin_session";
const SESSION_TTL_SECONDS=8*60*60;
const FALLBACK_SESSION_SECRET=crypto.randomBytes(32).toString("hex");

function secret(){
  return String(process.env.ADMIN_SESSION_SECRET||process.env.SESSION_SECRET||FALLBACK_SESSION_SECRET).trim();
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
    try{out[key]=decodeURIComponent(value);}catch(_){out[key]=value;}
  }
  return out;
}

function createToken(username){
  const payload=Buffer.from(JSON.stringify({
    u:String(username),
    exp:Math.floor(Date.now()/1000)+SESSION_TTL_SECONDS
  })).toString("base64url");
  return payload+"."+sign(payload);
}

function verifyToken(token){
  if(!token||!secret()) return null;
  const [payload,signature]=String(token).split(".");
  if(!payload||!signature) return null;
  const expected=sign(payload);
  const actualBuffer=Buffer.from(signature);
  const expectedBuffer=Buffer.from(expected);
  if(actualBuffer.length!==expectedBuffer.length||!crypto.timingSafeEqual(actualBuffer,expectedBuffer)) return null;
  try{
    const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    return data&&data.exp>Math.floor(Date.now()/1000)?data:null;
  }catch(_){return null;}
}

function isAdminAuthenticated(req){
  const cookies=parseCookie(req.headers.cookie);
  return Boolean(verifyToken(cookies[COOKIE_NAME]));
}

function setSessionCookie(res,username,req){
  const token=createToken(username);
  const forwardedProto=String(req?.get?.("x-forwarded-proto")||"").split(",")[0].trim().toLowerCase();
  const secure=process.env.NODE_ENV==="production" && (Boolean(req?.secure)||forwardedProto==="https");
  const parts=[
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if(secure) parts.push("Secure");
  res.setHeader("Set-Cookie",parts.join("; "));
}

function clearSessionCookie(res,req){
  const forwardedProto=String(req?.get?.("x-forwarded-proto")||"").split(",")[0].trim().toLowerCase();
  const secure=process.env.NODE_ENV==="production" && (Boolean(req?.secure)||forwardedProto==="https");
  const parts=[`${COOKIE_NAME}=`, "Max-Age=0", "Path=/", "HttpOnly", "SameSite=Lax"];
  if(secure) parts.push("Secure");
  res.setHeader("Set-Cookie",parts.join("; "));
}

function requireAdmin(req,res,next){
  if(isAdminAuthenticated(req)) return next();
  if(req.path.startsWith("/api/")) return res.status(401).json({success:false,message:"Admin authentication required."});
  return res.redirect("/login?next="+encodeURIComponent(req.originalUrl||"/admin"));
}

function getAdminCredentials(){
  const ADMIN_USER=String(process.env.ADMIN_USERNAME||process.env.ADMIN_USER||"admin").trim()||"admin";
  const ADMIN_PASS=String(process.env.ADMIN_PASSWORD||"faznetwork2026").trim()||"faznetwork2026";
  const ADMIN_HASH=String(process.env.ADMIN_PASSWORD_HASH||"").trim()||null;
  return {ADMIN_USER,ADMIN_PASS,ADMIN_HASH};
}

async function adminCredentialsValid(username,password){
  const {ADMIN_USER,ADMIN_PASS,ADMIN_HASH}=getAdminCredentials();
  const inputUser=String(username||"").trim();
  const inputPass=String(password||"").trim();
  if(!inputUser||inputUser.toLowerCase()!==ADMIN_USER.toLowerCase()) return false;

  if(ADMIN_HASH){
    try{
      const bcrypt=require("bcryptjs");
      if(await bcrypt.compare(inputPass,ADMIN_HASH)) return true;
    }catch(error){
      console.warn("[Admin Auth] bcrypt comparison failed; trying configured plaintext fallback:",error.message);
    }
  }

  return inputPass===ADMIN_PASS;
}

module.exports={
  COOKIE_NAME,
  isAdminAuthenticated,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
  adminCredentialsValid,
  getAdminCredentials
};

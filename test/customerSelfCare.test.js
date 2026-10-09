process.env.CUSTOMER_SESSION_SECRET="self-care-test-secret-only";
const test=require("node:test");
const assert=require("node:assert/strict");
const {issueToken,readToken}=require("../controllers/customerSelfCareController");
function requestWithCookie(token){return {headers:{cookie:"faz_customer_session="+encodeURIComponent(token)}};}
test("customer session token carries subscriber identity and account type",()=>{
 const token=issueToken({sub:"pppoe-user-1",type:"pppoe",name:"Test Customer"});
 const decoded=readToken(requestWithCookie(token));
 assert.equal(decoded.sub,"pppoe-user-1");
 assert.equal(decoded.type,"pppoe");
 assert.ok(decoded.exp>decoded.iat);
});
test("tampered customer session token is rejected",()=>{
 const token=issueToken({sub:"subscriber-1",type:"hotspot"});
 const parts=token.split(".");
 parts[1]=Buffer.from(JSON.stringify({sub:"other-subscriber",type:"hotspot",exp:9999999999})).toString("base64url");
 assert.equal(readToken(requestWithCookie(parts.join("."))),null);
});
test("customer cookie does not accept an admin session cookie",()=>{
 const decoded=readToken({headers:{cookie:"connect.sid=s%3Aadmin-session; other=value"}});
 assert.equal(decoded,null);
});

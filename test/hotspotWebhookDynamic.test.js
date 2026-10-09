"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const db=require("../db");
const mikrotik=require("../services/mikrotikService");
const paymentController=require("../controllers/paymentController");

function responseRecorder(){
  return {
    statusCode:200,body:null,
    status(code){this.statusCode=code;return this;},
    json(body){this.body=body;return this;}
  };
}

test("verifyTrx uses the current database profile price after a 10 to 15 Tk edit",async()=>{
  const originalQuery=db.query,originalProfiles=mikrotik.getHotspotProfiles,originalRecharge=mikrotik.rechargeHotspotUser;
  let profileMetadata={Weekend:{price:10,validityValue:1,validityUnit:"days",validityLabel:"1 Day",limitBytesTotal:0}};
  let rechargePayload=null;
  try{
    // Simulate the admin saving the profile price from Tk 10 to Tk 15 in app_settings.
    profileMetadata={Weekend:{price:15,validityValue:2,validityUnit:"days",validityLabel:"2 Days",limitBytesTotal:0}};
    db.query=async(sql,params=[])=>{
      if(sql.includes("SELECT * FROM transactions"))return {rows:[{id:params[0]==="PRICE10"?72:71,trx_id:params[0],amount:params[0]==="PRICE10"?10:15,used:false,status:"unmatched",matched_username:null}]};
      if(sql.includes("SELECT 1 FROM pppoe_users"))return {rows:[]};
      if(sql.includes("FROM packages WHERE ROUND(price*100)"))return {rows:[]};
      if(sql.includes("key='hotspot_profile_metadata'"))return {rows:[{value:JSON.stringify(profileMetadata)}]};
      if(sql.includes("SET used=true,status='processing'"))return {rows:[{id:params[1]}]};
      if(sql.startsWith("UPDATE transactions"))return {rows:[]};
      throw new Error("Unexpected SQL in test: "+sql);
    };
    mikrotik.getHotspotProfiles=async()=>[{name:"Weekend",sessionTimeout:"1d"}];
    mikrotik.rechargeHotspotUser=async(payload)=>{rechargePayload=payload;return {username:payload.username};};
    const req={ip:"test-price-sync-15",body:{phone:"01712345678",trxId:"PRICE15"}};
    const res=responseRecorder();
    await paymentController.verifyTrx(req,res);
    assert.equal(res.statusCode,200);
    assert.equal(res.body.success,true);
    assert.equal(res.body.profile,"Weekend");
    assert.equal(res.body.validity,"2d");
    assert.equal(res.body.amount,15);
    assert.equal(rechargePayload.profile,"Weekend");
    assert.equal(rechargePayload.validity,"2d");

    // The old Tk 10 amount must stop matching immediately after the profile price is changed.
    const oldAmountResponse=responseRecorder();
    await paymentController.verifyTrx({ip:"test-price-sync-old-10",body:{phone:"01712345678",trxId:"PRICE10"}},oldAmountResponse);
    assert.equal(oldAmountResponse.statusCode,400);
    assert.match(oldAmountResponse.body.error,/no active Hotspot profile currently has a price of ৳10\.00/i);
  }finally{
    db.query=originalQuery;
    mikrotik.getHotspotProfiles=originalProfiles;
    mikrotik.rechargeHotspotUser=originalRecharge;
  }
});

test("dynamicWebhook catches a custom full-URL path from app_settings",async()=>{
  const originalQuery=db.query;
  let nextCalled=false;
  try{
    db.query=async(sql)=>{
      if(sql.includes("personal_payment_webhook_url"))return {rows:[{key:"personal_payment_webhook_url",value:"https://forwarder.example/api/custom-forwarder?source=sms"}]};
      if(sql.includes("personal_payment_webhook_enabled"))return {rows:[{key:"personal_payment_webhook_enabled",value:"false"},{key:"personal_payment_webhook_secret",value:""}]};
      throw new Error("Unexpected SQL in test: "+sql);
    };
    const req={path:"/api/custom-forwarder",body:{},query:{},headers:{},get:()=>""};
    const res=responseRecorder();
    await paymentController.dynamicWebhook(req,res,()=>{nextCalled=true;});
    assert.equal(nextCalled,false,"matching custom path should be handled, not passed to next route");
    assert.equal(res.statusCode,403,"custom endpoint should reach webhook processor and respect its enabled guard");
    assert.equal(res.body.error,"Automation disabled");
  }finally{
    db.query=originalQuery;
  }
});


test("verifyTrx accepts username and trx_id aliases with case/whitespace-insensitive lookup",async()=>{
  const originalQuery=db.query,originalProfiles=mikrotik.getHotspotProfiles,originalRecharge=mikrotik.rechargeHotspotUser;
  let lookupSql="",lookupValue="",rechargePayload=null;
  try{
    db.query=async(sql,params=[])=>{
      if(sql.includes("SELECT * FROM transactions")){lookupSql=sql;lookupValue=params[0];return {rows:[{id:91,trx_id:"AbC-123",amount:15,used:false,status:"Unmatched",matched_username:null}]};}
      if(sql.includes("SELECT 1 FROM pppoe_users"))return {rows:[]};
      if(sql.includes("FROM packages WHERE ROUND(price*100)"))return {rows:[]};
      if(sql.includes("key='hotspot_profile_metadata'"))return {rows:[{value:JSON.stringify({Weekend:{price:15,validityValue:2,validityUnit:"days",limitBytesTotal:0}})}]};
      if(sql.includes("SET used=true,status='processing'"))return {rows:[{id:params[1]}]};
      if(sql.startsWith("UPDATE transactions"))return {rows:[]};
      throw new Error("Unexpected SQL in test: "+sql);
    };
    mikrotik.getHotspotProfiles=async()=>[{name:"Weekend",sessionTimeout:"1d"}];
    mikrotik.rechargeHotspotUser=async(payload)=>{rechargePayload=payload;return {username:payload.username};};
    const req={ip:"test-alias-trim-case",body:{username:" 01712345678 ",trx_id:"  aBc-123  "},query:{}};
    const res=responseRecorder();
    await paymentController.verifyTrx(req,res);
    assert.equal(res.statusCode,200);
    assert.equal(res.body.success,true);
    assert.equal(res.body.username,"01712345678");
    assert.equal(lookupValue,"  aBc-123  ");
    assert.match(lookupSql,/UPPER\(TRIM\(trx_id\)\)\s*=\s*UPPER\(TRIM\(\$1\)\)/i);
    assert.match(lookupSql,/used\s*=\s*false/i);
    assert.match(lookupSql,/unmatched/i);
    assert.equal(rechargePayload.username,"01712345678");
  }finally{
    db.query=originalQuery;
    mikrotik.getHotspotProfiles=originalProfiles;
    mikrotik.rechargeHotspotUser=originalRecharge;
  }
});

"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const db=require("../db");
const mikrotik=require("../services/mikrotikService");
const customerController=require("../controllers/customerController");

function responseRecorder(){
  return {statusCode:200,body:null,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
}
function baseCustomer(){
  return {id:42,full_name:"Migration Customer",phone:"01712345678",username:"01712345678",password:"secret",package_name:"Home 30",profile:"HOME30",monthly_bill:500,expiration_date:"2026-10-31",billing_cycle:"monthly",billing_duration_days:null,billing_expiry_override:false,connection_date:"2025-01-01",billing_status:"unpaid",status:"active",remarks:"existing note"};
}

test("updateCustomer accepts past next_billing_date and preserves line under explicit migration override",async()=>{
  const originalQuery=db.query,originalTest=mikrotik.testConnection;
  const sqlSeen=[],paramsSeen=[];
  try{
    mikrotik.testConnection=async()=>false;
    db.query=async(sql,params=[])=>{
      sqlSeen.push(sql);paramsSeen.push(params);
      if(sql.includes("SELECT * FROM customers WHERE id::text=$1"))return {rows:[baseCustomer()]};
      if(sql.startsWith("SELECT id FROM customers WHERE id<>"))return {rows:[]};
      if(sql.includes("SELECT id,plan_name,pool_name,rate_limit,price,duration_months,profile_name FROM packages"))return {rows:[{id:7,plan_name:"Home 30",profile_name:"HOME30",price:500,duration_months:1,pool_name:"",rate_limit:"30M"}]};
      if(sql.startsWith("UPDATE customers SET"))return {rows:[{...baseCustomer(),expiration_date:"2020-02-29",billing_cycle:"custom_days",billing_duration_days:45,billing_expiry_override:true,status:"expired"}]};
      return {rows:[]};
    };
    const req={params:{id:"42"},body:{id:"42",username:"01712345678",billing_expiry_date:"2020-02-29",billing_cycle:"custom_days",billing_duration_days:"45",billing_expiry_override:true},ip:"test"};
    const res=responseRecorder();
    await customerController.updateCustomer(req,res);
    assert.equal(res.statusCode,200);
    assert.equal(res.body.success,true);
    const customerUpdateIndex=sqlSeen.findIndex(sql=>sql.startsWith("UPDATE customers SET"));
    assert.notEqual(customerUpdateIndex,-1);
    const updateSql=sqlSeen[customerUpdateIndex],updateParams=paramsSeen[customerUpdateIndex];
    assert.match(updateSql,/billing_cycle=\$20/);
    assert.match(updateSql,/billing_duration_days=\$21/);
    assert.match(updateSql,/billing_expiry_override=\$22/);
    assert.equal(updateParams[12],"2020-02-29");
    assert.equal(updateParams[19],"custom_days");
    assert.equal(updateParams[20],45);
    assert.equal(updateParams[21],true);
    const pppoeIndex=sqlSeen.findIndex(sql=>sql.includes("INSERT INTO pppoe_users"));
    assert.notEqual(pppoeIndex,-1);
    const pppoeParams=paramsSeen[pppoeIndex];
    assert.equal(pppoeParams[2],"HOME30","past migration expiry must not switch to EXPIRED profile");
    assert.equal(pppoeParams[3],false,"past migration expiry must not disable the line by default");
    assert.equal(pppoeParams[7],"2020-02-29");
    assert.equal(pppoeParams[8],"expired","billing state should still be flagged as expired");
  }finally{
    db.query=originalQuery;
    mikrotik.testConnection=originalTest;
  }
});

test("updateCustomer rejects invalid calendar dates and invalid custom durations",async()=>{
  const originalQuery=db.query;
  try{
    let customerQueries=0;
    db.query=async(sql)=>{customerQueries++;if(sql.includes("SELECT * FROM customers WHERE id::text=$1"))return {rows:[baseCustomer()]};return {rows:[]};};
    const invalidDate=responseRecorder();
    await customerController.updateCustomer({params:{id:"42"},body:{billing_expiry_date:"2026-02-31"}},invalidDate);
    assert.equal(invalidDate.statusCode,400);
    assert.match(invalidDate.body.message,/valid YYYY-MM-DD/i);
    const invalidDuration=responseRecorder();
    await customerController.updateCustomer({params:{id:"42"},body:{billing_cycle:"custom_days",billing_duration_days:"0"}},invalidDuration);
    assert.equal(invalidDuration.statusCode,400);
    assert.match(invalidDuration.body.message,/between 1 and 3650/i);
    assert.equal(customerQueries,2);
  }finally{db.query=originalQuery;}
});

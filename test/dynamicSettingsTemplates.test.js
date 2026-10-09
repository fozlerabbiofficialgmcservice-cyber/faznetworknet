"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const ejs=require("ejs");
const templates=["views/admin.ejs","views/index.ejs","views/customer-dashboard.ejs","views/portal.ejs","views/customer-profile.ejs","views/reports.ejs"];
test("all updated EJS templates compile after branding and settings changes",()=>{
 for(const file of templates){
  const source=fs.readFileSync(path.join(__dirname,"..",file),"utf8");
  assert.doesNotThrow(()=>ejs.compile(source,{filename:file}),file+" should compile");
 }
});

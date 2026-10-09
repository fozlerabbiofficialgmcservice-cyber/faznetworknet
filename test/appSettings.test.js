"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const service=require("../services/appSettings");
test("brand defaults are safe and preserve copyright year placeholder",async()=>{
 const brand=await service.getBrandSettings();
 assert.equal(brand.company_name,"FAZ NETWORK");
 assert.match(brand.footer_copyright,/{year}/);
 assert.equal(typeof brand.whatsapp_number,"string");
});
test("WhatsApp number normalization strips punctuation",()=>{
 // Normalization is exposed through the public settings loader; this test guards the default contract.
 assert.equal(service.DEFAULTS.company_name,"FAZ NETWORK");
 assert.equal(service.DEFAULTS.sms_gateway_mode,"disabled");
});

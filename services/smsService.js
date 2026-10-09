"use strict";
const settingsService=require("./appSettings");
function withTimeout(promise,ms=8000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("SMS provider request timed out.")),ms);})]).finally(()=>clearTimeout(timer));}
function safeText(value,max=1000){return String(value??"").trim().slice(0,max);}
async function sendSms({to,message,event="manual"}={}){
 const settings=await settingsService.getAllSettings();
 const mode=String(settings.sms_gateway_mode||"disabled");
 const recipient=safeText(to,40),text=safeText(message,1200);
 if(!recipient||!text)throw new Error("SMS recipient and message are required.");
 if(mode==="disabled")return {success:true,skipped:true,reason:"sms_gateway_disabled"};
 const payload={to:recipient,message:text,event,from:safeText(settings.sms_sender_id,50),timestamp:new Date().toISOString()};
 let url,headers={"Content-Type":"application/json"},body;
 if(mode==="bulk_sms"){
  url=safeText(settings.sms_api_url,1000);
  if(!/^https?:\/\//i.test(url))throw new Error("A valid HTTP(S) SMS API URL is required.");
  if(settings.sms_api_key)headers.Authorization="Bearer "+String(settings.sms_api_key);
  body=JSON.stringify(payload);
 }else if(mode==="personal_device"){
  url=safeText(settings.sms_device_url,1000);
  if(!/^https?:\/\//i.test(url))throw new Error("A valid HTTP(S) Android device endpoint is required.");
  if(settings.sms_device_token)headers.Authorization="Bearer "+String(settings.sms_device_token);
  body=JSON.stringify(payload);
 }else throw new Error("Unsupported SMS gateway mode.");
 const response=await withTimeout(fetch(url,{method:"POST",headers,body,redirect:"error"}),8000);
 const responseText=await response.text().catch(()=> "");
 if(!response.ok)throw new Error("SMS provider returned HTTP "+response.status+".");
 let data={};try{data=responseText?JSON.parse(responseText):{};}catch(_){data={message:responseText.slice(0,200)};}
 return {success:true,mode,providerResponse:data};
}
async function sendNotification({to,message,event}={}){
 const settings=await settingsService.getAllSettings();
 const allowed={
  expiry_warning:settings.sms_event_expiry_warning,
  payment_receipt:settings.sms_event_payment_receipt,
  line_expiry:settings.sms_event_line_expiry
 };
 if(event&&Object.prototype.hasOwnProperty.call(allowed,event)&&!settingsService.bool(allowed[event]))return {success:true,skipped:true,reason:"event_disabled"};
 return sendSms({to,message,event});
}
module.exports={sendSms,sendNotification};

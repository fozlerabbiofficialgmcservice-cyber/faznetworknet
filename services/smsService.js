"use strict";
const settingsService=require("./appSettings");
const EVENT_CONFIG={
 expiry_warning:{enabled:"sms_event_expiry_warning",template:"sms_template_expiry_warning"},
 payment_receipt:{enabled:"sms_event_payment_receipt",template:"sms_template_payment_receipt"},
 line_expiry:{enabled:"sms_event_line_expiry",template:"sms_template_line_block"}
};
function withTimeout(promise,ms=8000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("SMS provider request timed out.")),ms);})]).finally(()=>clearTimeout(timer));}
function safeText(value,max=1200){return String(value??"").trim().slice(0,max);}
function renderTemplate(template,variables={}){
 const source=String(template??"");
 const values={...variables};
 if(values.company_name&&!values.company)values.company=values.company_name;
 if(values.new_expiry_date&&!values.expiry_date)values.expiry_date=values.new_expiry_date;
 if(values.trx_id&&!values.transaction_id)values.transaction_id=values.trx_id;
 return source.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,(whole,key)=>{
  if(!Object.prototype.hasOwnProperty.call(values,key)||values[key]===null||values[key]===undefined)return whole;
  return String(values[key]).slice(0,300);
 }).slice(0,1200);
}
function eventTemplate(settings,event,variables={},fallbackMessage=""){
 const config=EVENT_CONFIG[event];
 if(!config)return renderTemplate(fallbackMessage,variables);
 const template=String(settings[config.template]||"");
 return renderTemplate(template||fallbackMessage,variables);
}
async function sendSms({to,phone,message,event="manual",variables={},token:overrideToken}={}){
 const settings=await settingsService.getAllSettings();
 const mode=String(settings.sms_provider_mode||settings.sms_gateway_mode||"disabled");
 const recipient=safeText(phone||to,40),text=renderTemplate(message,variables);
 if(mode==="disabled"){console.info("[SMS] Dispatch skipped: provider mode is disabled.");return {success:true,skipped:true,reason:"sms_gateway_disabled"};}
 if(!recipient||!text)throw new Error("SMS recipient and message are required.");
 const sender=safeText(settings.sms_sender_id,80);
 let url,method="POST",headers={"Content-Type":"application/json"},body;
 if(mode==="bulk_sms"){
  url=safeText(settings.sms_api_url,1000);
  if(!/^https?:\/\//i.test(url))throw new Error("A valid HTTP(S) SMS API URL is required.");
  method=String(settings.sms_api_method||"POST").toUpperCase()==="GET"?"GET":"POST";
  const apiToken=String(settings.sms_api_key||"");
  if(method==="GET"){
   const target=new URL(url);
   target.searchParams.set("phone",recipient);
   target.searchParams.set("to",recipient);
   target.searchParams.set("message",text);
   if(sender)target.searchParams.set("senderid",sender);
   if(apiToken)target.searchParams.set("token",apiToken);
   url=target.toString();
  }else{
   if(apiToken)headers.Authorization="Bearer "+apiToken;
   body=JSON.stringify({phone:recipient,to:recipient,message:text,sender_id:sender,senderid:sender,token:apiToken,event});
  }
 }else if(mode==="personal_device"){
  url=safeText(settings.sms_device_webhook_url||settings.sms_device_url,1000);
  if(!/^https?:\/\//i.test(url))throw new Error("A valid HTTP(S) Android device webhook URL is required.");
  const deviceToken=String(overrideToken||settings.sms_device_token||"");
  body=JSON.stringify({phone:recipient,message:text,token:deviceToken});
 }else throw new Error("Unsupported SMS gateway mode.");
 const response=await withTimeout(fetch(url,{method,headers,body,redirect:"error"}),8000);
 const responseText=await response.text().catch(()=> "");
 if(!response.ok)throw new Error("SMS provider returned HTTP "+response.status+".");
 let data={};try{data=responseText?JSON.parse(responseText):{};}catch(_){data={message:responseText.slice(0,200)};}
 return {success:true,mode,method,providerResponse:data};
}
async function sendNotification({to,phone,message,event,variables={},...extra}={}){
 const settings=await settingsService.getAllSettings();
 const config=EVENT_CONFIG[event];
 if(config&&!settingsService.bool(settings[config.enabled]))return {success:true,skipped:true,reason:"event_disabled"};
 const resolvedVariables={...extra,...variables};
 const rendered=eventTemplate(settings,event,resolvedVariables,message);
 return sendSms({to,phone,message:rendered,event,variables:resolvedVariables});
}
module.exports={sendSms,sendNotification,renderTemplate,eventTemplate,EVENT_CONFIG};

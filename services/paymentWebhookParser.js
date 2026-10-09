function firstDefined(values){
  for(const value of values){
    if(value===undefined||value===null)continue;
    if(typeof value==="string" && !value.trim())continue;
    return value;
  }
  return "";
}
function getNestedValue(body,keys){
  if(!body||typeof body!=="object"||Array.isArray(body))return "";
  for(const key of keys){if(Object.prototype.hasOwnProperty.call(body,key))return body[key];}
  return "";
}
function extractWebhookPayload(body,query={},headers={}){
  const objectBody=body&&typeof body==="object"&&!Array.isArray(body)?body:{};
  const text=firstDefined([
    getNestedValue(objectBody,["message","sms","text","body","sms_body","sms_message","sms body","smsText","smsTextMessage","notification"]),
    query?.message,query?.text,query?.sms,query?.body,
    headers["x-sms-message"],headers["x-sms-body"],headers["x-sms-text"],headers["x-message"],headers["x-sms"],headers["x-notification-message"],
    typeof body==="string"?body:""
  ]);
  const sender=firstDefined([
    getNestedValue(objectBody,["sender","from","number","sms_number"]),
    headers["x-sms-sender"],headers["x-sender"],headers["x-sms-from"],headers["x-payer-phone"],query?.sender,query?.from
  ]);
  const token=firstDefined([
    headers["x-webhook-token"],headers["x-macrodroid-token"],
    getNestedValue(objectBody,["token","secret"]),query?.token
  ]);
  return {text:String(typeof text==="object"?JSON.stringify(text):text||""),sender:String(sender||"").trim(),token:String(token||"").trim()};
}
function normalizePhone(value){
  const bangla="০১২৩৪৫৬৭৮৯";
  let p=String(value||"").replace(/[০-৯]/g,ch=>String(bangla.indexOf(ch))).replace(/[^0-9]/g,"");
  if(p.startsWith("880")&&p.length===13)p="0"+p.slice(3);
  return p;
}
function normalizeAmount(value){
  const cleaned=String(value||"").replace(/[, ]/g,"").trim();
  const amount=Number(cleaned);
  return Number.isFinite(amount)?amount:NaN;
}
function channelFrom(text,sender=""){
  const t=(String(text||"")+" "+String(sender||"")).toLowerCase();
  if(/bkash|b-kash|বিকাশ/.test(t))return"bkash";
  if(/nagad|নগদ/.test(t))return"nagad";
  if(/rocket|রকেট|dutch\s*bangla|dbbl/.test(t))return"rocket";
  if(/upay|উপায়|উপায়/.test(t))return"upay";
  return null;
}
function extractTransactionId(text){
  const t=String(text||"").replace(/[\u200b\u200c\u200d]/g,"");
  const labeled=[
    /\b(?:trx\s*id|transaction\s*id|txn\s*id)\s*[:#=\-]?\s*([A-Z0-9][A-Z0-9._-]{5,39})\b/i,
    /\b(?:trx|txn)\s*[:#=\-]\s*([A-Z0-9][A-Z0-9._-]{5,39})\b/i
  ];
  for(const re of labeled){const m=t.match(re);if(m)return m[1].replace(/[^A-Z0-9_-]/gi,"").toUpperCase();}
  return "";
}
function extractAmount(text){
  const t=String(text||"").replace(/\u00a0/g," ");
  const patterns=[
    /(?:amount|received|payment|paid|cash\s*in|cashin)\s*[:=\-]?\s*(?:tk|taka|৳)\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)/i,
    /(?:tk|taka|৳)\s*[:=\-]?\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)/i
  ];
  for(const re of patterns){const m=t.match(re);if(m){const n=normalizeAmount(m[1]);if(Number.isFinite(n)&&n>0)return n;}}
  return NaN;
}
function extractSenderPhone(text,sender){
  const matches=String(text||"").match(/(?:\+?880|0)1\d{9}/g)||[];
  const normalized=matches.map(normalizePhone).filter(v=>/^01\d{9}$/.test(v));
  if(normalized.length)return normalized[0];
  const normalizedSender=normalizePhone(sender);
  return /^01\d{9}$/.test(normalizedSender)?normalizedSender:"";
}
function extractReference(text){
  const m=String(text||"").match(/\b(?:ref|reference)\s*[:#=-]?\s*([A-Za-z0-9_-]{1,50})/i);
  return m?m[1].trim():"";
}
function parseSms(body,query={},headers={}){
  const payload=extractWebhookPayload(body,query,headers);
  const text=payload.text;
  const trxId=extractTransactionId(text);
  const amount=extractAmount(text);
  const channel=channelFrom(text,payload.sender);
  if(!trxId||!Number.isFinite(amount)||amount<=0)throw new Error("Could not parse transaction ID or amount from SMS.");
  if(!channel)throw new Error("Unsupported payment channel. Include the MFS name in the SMS or sender.");
  return {channel,trxId,amount,senderPhone:extractSenderPhone(text,payload.sender),customerRef:extractReference(text),rawSms:text,sourceSender:payload.sender};
}
module.exports={extractWebhookPayload,extractTransactionId,extractAmount,parseSms,normalizePhone,channelFrom};
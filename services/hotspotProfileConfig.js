"use strict";
function normalizeProfileValidity(value, unit) {
 const n=Number(value),raw=String(unit||"").trim().toLowerCase(),aliases={m:"minutes",min:"minutes",minute:"minutes",minutes:"minutes",h:"hours",hr:"hours",hour:"hours",hours:"hours",d:"days",day:"days",days:"days",gb:"gb"},u=aliases[raw];
 if(!Number.isSafeInteger(n)||n<=0)throw new Error("Validity must be a positive whole number.");
 if(!u)throw new Error("Validity unit must be minutes, hours, days, or GB.");
 if(u==="gb"){const bytes=n*1073741824;if(!Number.isSafeInteger(bytes))throw new Error("GB quota is too large.");return {value:n,unit:u,validity:"",validityLabel:n+" GB",limitBytesTotal:bytes};}
 const suffix={minutes:"m",hours:"h",days:"d"}[u],label={minutes:"Minute",hours:"Hour",days:"Day"}[u];
 return {value:n,unit:u,validity:String(n)+suffix,validityLabel:n+" "+label+(n===1?"":"s"),limitBytesTotal:0};
}
function parseStoredValidity(profile){const timeout=String(profile?.sessionTimeout||profile?.["session-timeout"]||"").trim(),m=timeout.match(/^(\d+)(m|h|d)$/i);if(!m)return {value:1,unit:"days",validity:"1d",validityLabel:"1 Day",limitBytesTotal:0};return normalizeProfileValidity(Number(m[1]),m[2].toLowerCase());}
function buildHotspotOnLoginScript(config){
 const v=normalizeProfileValidity(config.validityValue,config.validityUnit),shared=Math.max(1,Number(config.sharedUsers)||1),name=String(config.name||"").replace(/[^a-zA-Z0-9_. -]/g,"").slice(0,80),policy=v.validity||v.validityLabel,macField=shared===1?' mac-address=$loginMac':"";
 const base=':local u $user; :local loginMac $"mac-address"; :local auth "unknown"; :local activeId [/ip hotspot active find where user=$u]; :if ([:len $activeId] > 0) do={ :set auth [/ip hotspot active get $activeId login-by]; }; :local uid [/ip hotspot user find where name=$u]; :if ([:len $uid] > 0) do={ /ip hotspot user set $uid'+macField+' comment=("FAZ|PROFILE='+name+'|VALIDITY='+policy+'|MAC=".$loginMac."|AUTH=".$auth); };';
 if(v.unit==="gb")return base+' :if ([:len $uid] > 0) do={ /ip hotspot user set $uid limit-bytes-total='+v.limitBytesTotal+'; };';
 return base+' :if ([:len $uid] > 0) do={ /ip hotspot user set $uid limit-bytes-total=0; }; :local sched ("faz-exp-".$u); :if ([:len [/system scheduler find where name=$sched]] = 0) do={ /system scheduler add name=$sched interval='+v.validity+' start-time=[/system clock get time] on-event=(":local n \\"" . $u . "\\"; /ip hotspot active remove [find where user=$n]; /ip hotspot user disable [find where name=$n]; /system scheduler remove [find where name=(\\"faz-exp-\\".$n)];"); };';
}
module.exports={normalizeProfileValidity,parseStoredValidity,buildHotspotOnLoginScript};

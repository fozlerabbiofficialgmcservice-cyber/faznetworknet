const { RouterOSAPI } = require("node-routeros");

const CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_PORT = 8728;

class MikroTikService {
  _getConfig() {
    const host = String(process.env.ROUTER_HOST || "").trim();
    const port = Number.parseInt(process.env.ROUTER_PORT || DEFAULT_PORT, 10);
    const user = String(process.env.ROUTER_USER || "").trim();
    const password = String(process.env.ROUTER_PASS || "");
    if (!host) throw new Error("MikroTik configuration error: ROUTER_HOST is not configured.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MikroTik configuration error: ROUTER_PORT must be a valid TCP port.");
    if (!user) throw new Error("MikroTik configuration error: ROUTER_USER is not configured.");
    return { host, port, user, password };
  }
  _createConnection(config) { return new RouterOSAPI({ host: config.host, port: config.port, user: config.user, password: config.password, timeout: CONNECTION_TIMEOUT_MS / 1000 }); }
  async _withConnection(operationName, operation) {
    const connection = this._createConnection(this._getConfig()); let timer;
    try {
      const connectPromise = connection.connect();
      await Promise.race([connectPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Connection timed out after 5 seconds.")), CONNECTION_TIMEOUT_MS); })]);
      return await operation(connection);
    } catch (error) {
      const details=this._extractRouterError(error);
      const wrapped=new Error(details.message);
      wrapped.cause=error;
      wrapped.category=details.category;
      wrapped.code=error&&error.code?error.code:"MIKROTIK_ERROR";
      wrapped.operation=operationName;
      throw wrapped;
    } finally { if (timer) clearTimeout(timer); await this._safeClose(connection); }
  }
  async _safeClose(connection) {
    if (!connection) return;
    try { if (typeof connection.close === "function") await Promise.resolve(connection.close()); else if (typeof connection.disconnect === "function") await Promise.resolve(connection.disconnect()); else if (typeof connection.destroy === "function") connection.destroy(); } catch (_) {}
  }
  _firstRow(rows, operationName) { if (!Array.isArray(rows) || rows.length === 0) throw new Error("MikroTik " + operationName + " returned no data."); return rows[0]; }
  _number(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
  _bool(value) { return String(value || "false").toLowerCase() === "true"; }
  _str(value) { return value === undefined || value === null ? "" : String(value); }
  _writeParams(values) { return Object.entries(values).filter(([, value]) => value !== undefined && value !== null && String(value) !== "").map(([key, value]) => "=" + key + "=" + value); }

  async testConnection() { return this._withConnection("connection test", async (connection) => { const identity = this._firstRow(await connection.write("/system/identity/print"), "identity query"); const resources = this._firstRow(await connection.write("/system/resource/print"), "resource query"); return { routerName: this._str(identity.name) || "Unknown Router", version: this._str(resources.version) || "Unknown" }; }); }
  async getSystemResources() { return this._withConnection("resource query", async (connection) => { const resource = this._firstRow(await connection.write("/system/resource/print"), "resource query"); const totalMemoryBytes = this._number(resource["total-memory"]); const freeMemoryBytes = this._number(resource["free-memory"]); return { cpuLoad: this._number(resource["cpu-load"]), freeMemoryMb: Number((freeMemoryBytes / 1024 / 1024).toFixed(2)), totalMemoryMb: Number((totalMemoryBytes / 1024 / 1024).toFixed(2)), memoryUsedMb: Number(((Math.max(0, totalMemoryBytes - freeMemoryBytes)) / 1024 / 1024).toFixed(2)), memoryUsagePercent: totalMemoryBytes > 0 ? Number((((totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes) * 100).toFixed(1)) : 0, uptime: this._str(resource.uptime) || "unknown", version: this._str(resource.version) || "Unknown" }; }); }
  async getInterfaces() { return this._withConnection("interface query", async (connection) => { const rows = await connection.write("/interface/print"); return (Array.isArray(rows) ? rows : []).filter((item) => { const type = this._str(item.type).toLowerCase(); return ["ether","ethernet","sfp","sfp-sfpplus","sfpplus","bridge","vlan","pppoe","lte","bonding"].some((allowed) => type.includes(allowed)); }).map((item) => ({ name: this._str(item.name), type: this._str(item.type) || "unknown", running: this._bool(item.running), disabled: this._bool(item.disabled), comment: this._str(item.comment) })).filter((item) => item.name); }); }
  async getInterfaceTraffic(interfaceName) { const name = String(interfaceName || "").trim(); if (!name || name.length > 100) throw new Error("MikroTik traffic query failed: a valid interface name is required."); return this._withConnection("traffic query for " + name, async (connection) => { const rows = await connection.write("/interface/monitor-traffic", ["=interface=" + name, "=once=true"]); const traffic = this._firstRow(rows, "traffic query"); const rxBitsPerSecond = this._number(traffic["rx-bits-per-second"]); const txBitsPerSecond = this._number(traffic["tx-bits-per-second"]); return { interface: name, rxBitsPerSecond, txBitsPerSecond, rxMbps: Number((rxBitsPerSecond / 1000000).toFixed(3)), txMbps: Number((txBitsPerSecond / 1000000).toFixed(3)), rxKbps: Number((rxBitsPerSecond / 1000).toFixed(1)), txKbps: Number((txBitsPerSecond / 1000).toFixed(1)), timestamp: new Date().toISOString() }; }); }

  async fetchExistingProfiles() {
    return this._withConnection("PPPoE profile sync", async (connection) => {
      const rows = await connection.write("/ppp/profile/print");
      return (Array.isArray(rows) ? rows : []).map((item) => {
        const rateLimit=this._str(item["rate-limit"]);
        const localAddress=this._str(item["local-address"]);
        const remoteAddress=this._str(item["remote-address"]);
        const dnsServer=this._str(item["dns-server"]);
        const changeTcpMss=this._str(item["change-tcp-mss"]) || "default";
        return {
          id:this._str(item[".id"]),
          name:this._str(item.name),
          rateLimit,
          "rate-limit":rateLimit,
          localAddress,
          "local-address":localAddress,
          remoteAddress,
          "remote-address":remoteAddress,
          dnsServer,
          "dns-server":dnsServer,
          sessionTimeout:this._str(item["session-timeout"]),
          idleTimeout:this._str(item["idle-timeout"]),
          onlyOne:this._bool(item["only-one"]),
          changeTcpMss,
          "change-tcp-mss":changeTcpMss,
          comment:this._str(item.comment),
          raw:item
        };
      }).filter((item) => item.name);
    });
  }
  async fetchExistingSecrets() {
    return this._withConnection("PPPoE secret sync", async (connection) => {
      const rows = await connection.write("/ppp/secret/print", ["?service=pppoe"]);
      return (Array.isArray(rows) ? rows : []).map((item) => ({ id: this._str(item[".id"]), name: this._str(item.name), password: this._str(item.password), profile: this._str(item.profile), service: this._str(item.service) || "pppoe", callerId: this._str(item["caller-id"]), disabled: this._bool(item.disabled), comment: this._str(item.comment), localAddress: this._str(item["local-address"]), remoteAddress: this._str(item["remote-address"]), raw: item })).filter((item) => item.name);
    });
  }
  async getActiveSessions() {
    return this._withConnection("active PPPoE session query", async (connection) => {
      const rows = await connection.write("/ppp/active/print");
      return (Array.isArray(rows) ? rows : []).filter((item) => this._str(item.service).toLowerCase() === "pppoe").map((item) => ({ id: this._str(item[".id"]), username: this._str(item.name), service: this._str(item.service), address: this._str(item.address), uptime: this._str(item.uptime), callerId: this._str(item["caller-id"]), encoding: this._str(item.encoding), sessionId: this._str(item["session-id"]), radius: this._str(item.radius), raw: item })).filter((item) => item.username);
    });
  }
  async getHotspotUsers() {
    return this._withConnection("Hotspot user query", async (connection) => {
      const rows = await connection.write("/ip/hotspot/user/print");
      return (Array.isArray(rows) ? rows : []).map((item) => ({
        id: this._str(item[".id"]), username: this._str(item.name), password: this._str(item.password),
        profile: this._str(item.profile), disabled: this._bool(item.disabled), server: this._str(item.server),
        comment: this._str(item.comment), limitUptime: this._str(item["limit-uptime"]), raw: item
      })).filter((item) => item.username);
    });
  }
  async getHotspotServerProfiles() {
    return this._withConnection("Hotspot server profile query", async (connection) => {
      const rows = await connection.write("/ip/hotspot/profile/print");
      return (Array.isArray(rows) ? rows : []).map((item) => ({
        id: this._str(item[".id"]),
        name: this._str(item.name),
        hotspotAddress: this._str(item["hotspot-address"]),
        dnsName: this._str(item["dns-name"]),
        htmlDirectory: this._str(item["html-directory"]),
        loginBy: this._str(item["login-by"]),
        rateLimit: this._str(item["rate-limit"]),
        statusAutorefresh: this._str(item["status-autorefresh"]),
        sharedUsers: this._str(item["shared-users"]),
        raw: item
      })).filter((item) => item.name);
    });
  }
  async createHotspotServerProfile(data) {
    const name=this._str(data.name).trim();
    if(!name || name.toLowerCase()==='default') throw new Error("A custom server profile name is required.");
    return this._withConnection("Hotspot server profile creation",async(connection)=>{
      const params=this._writeParams({
        name,
        "hotspot-address":data.hotspotAddress,
        "dns-name":data.dnsName,
        "html-directory":data.htmlDirectory || "hotspot",
        "login-by":data.loginBy,
        "rate-limit":data.rateLimit,
        "status-autorefresh":data.statusAutorefresh
      });
      await connection.write("/ip/hotspot/profile/add",params);
      return {name};
    });
  }
  async _findHotspotServerProfile(connection,identifier) {
    const key=this._str(identifier).trim();
    const rows=await connection.write("/ip/hotspot/profile/print");
    const items=Array.isArray(rows)?rows:[];
    const match=items.find(item=>this._str(item[".id"])===key) || items.find(item=>this._str(item.name)===key);
    if(!match||!match[".id"]) throw new Error('Hotspot server profile "'+key+'" was not found on MikroTik.');
    if(this._str(match.name).toLowerCase()==='default') throw new Error("The default server profile cannot be modified.");
    return match;
  }
  async updateHotspotServerProfile(identifier,data) {
    return this._withConnection("Hotspot server profile update",async(connection)=>{
      const item=await this._findHotspotServerProfile(connection,identifier);
      const params=this._writeParams({
        ".id":item[".id"],
        name:data.name,
        "hotspot-address":data.hotspotAddress,
        "dns-name":data.dnsName,
        "html-directory":data.htmlDirectory || "hotspot",
        "login-by":data.loginBy,
        "rate-limit":data.rateLimit,
        "status-autorefresh":data.statusAutorefresh
      });
      await connection.write("/ip/hotspot/profile/set",params);
      return {id:this._str(item[".id"]),name:data.name};
    });
  }
  async deleteHotspotServerProfile(identifier) {
    return this._withConnection("Hotspot server profile deletion",async(connection)=>{
      const item=await this._findHotspotServerProfile(connection,identifier);
      await connection.write("/ip/hotspot/profile/remove",["=.id="+item[".id"]]);
      return {id:this._str(item[".id"]),name:this._str(item.name)};
    });
  }
  async getHotspotProfiles() {
    return this._withConnection("Hotspot profile query", async (connection) => {
      const rows = await connection.write("/ip/hotspot/user/profile/print");
      return (Array.isArray(rows) ? rows : []).map((item) => ({ id:this._str(item[".id"]), name: this._str(item.name), rateLimit: this._str(item["rate-limit"]), sharedUsers: this._str(item["shared-users"]), sessionTimeout: this._str(item["session-timeout"]), idleTimeout: this._str(item["idle-timeout"]), keepaliveTimeout: this._str(item["keepalive-timeout"]), statusAutorefresh: this._str(item["status-autorefresh"]), raw: item })).filter((item) => item.name);
    });
  }
  async createHotspotProfile(data) {
    const name=this._str(data.name).trim();
    if(!name) throw new Error("Hotspot profile name is required.");
    return this._withConnection("Hotspot profile creation",async(connection)=>{
      const params=this._writeParams({name,"rate-limit":data.rateLimit,"shared-users":data.sharedUsers||1,"session-timeout":data.sessionTimeout,"keepalive-timeout":data.keepaliveTimeout,"on-login":data.onLogin});
      await connection.write("/ip/hotspot/user/profile/add",params); return {name};
    });
  }
  async updateHotspotProfile(data) {
    const name=this._str(data.name).trim();
    if(!name) throw new Error("Hotspot profile name is required.");
    return this._withConnection("Hotspot profile update",async(connection)=>{
      const rows=await connection.write("/ip/hotspot/user/profile/print");
      const item=(Array.isArray(rows)?rows:[]).find(x=>this._str(x.name)===name);
      if(!item||!item[".id"]) throw new Error("Hotspot profile \""+name+"\" was not found on MikroTik.");
      const params=this._writeParams({".id":item[".id"],"rate-limit":data.rateLimit,"shared-users":data.sharedUsers||1,"session-timeout":data.sessionTimeout,"keepalive-timeout":data.keepaliveTimeout,"on-login":data.onLogin});
      await connection.write("/ip/hotspot/user/profile/set",params); return {name,id:this._str(item[".id"])};
    });
  }
  async deleteHotspotProfile(nameValue) {
    const name=this._str(nameValue).trim();
    if(!name) throw new Error("Hotspot profile name is required.");
    return this._withConnection("Hotspot profile deletion",async(connection)=>{
      const rows=await connection.write("/ip/hotspot/user/profile/print");
      const item=(Array.isArray(rows)?rows:[]).find(x=>this._str(x.name)===name);
      if(!item||!item[".id"]) throw new Error("Hotspot profile \""+name+"\" was not found on MikroTik.");
      await connection.write("/ip/hotspot/user/profile/remove",["=.id="+item[".id"]]); return {name,id:this._str(item[".id"])};
    });
  }

  async createHotspotUser(data) {
    const username=this._str(data.username).trim(), password=this._str(data.password), profile=this._str(data.profile).trim();
    if(!username || !password || !profile) throw new Error("Hotspot username, password, and profile are required.");
    return this._withConnection("Hotspot user creation", async (connection) => { const params=this._writeParams({ name: username, password, profile, server:data.server, "limit-uptime":data.timeLimit||data["limit-uptime"], "limit-bytes-total":data.dataLimit||data["limit-bytes-total"], comment:data.comment }); await connection.write("/ip/hotspot/user/add", params); return { username }; });
  }
  async kickActiveHotspotUser(username,idValue) {
    const name=this._str(username).trim(), requestedId=this._str(idValue).trim();
    if(!name&&!requestedId) throw new Error("Hotspot username or session id is required.");
    return this._withConnection("active Hotspot user kick", async (connection) => {
      let matches=[];
      if(requestedId) matches=[{".id":requestedId,user:name}];
      else {
        const rows=await connection.write("/ip/hotspot/active/print");
        matches=(Array.isArray(rows)?rows:[]).filter((item)=>this._str(item.user)===name && item[".id"]);
      }
      for(const session of matches) await connection.write("/ip/hotspot/active/remove",["=.id="+session[".id"]]);
      return {username:name,kicked:matches.length>0,count:matches.length,id:requestedId||this._str(matches[0]?.[".id"])};
    });
  }
  async removeHotspotUser(username) {
    const name=this._str(username).trim(); if(!name) throw new Error("Hotspot username is required.");
    return this._withConnection("Hotspot user removal", async (connection) => {
      const rows=await connection.write("/ip/hotspot/user/print");
      const matches=(Array.isArray(rows)?rows:[]).filter((item)=>this._str(item.name)===name && item[".id"]);
      if(!matches.length) throw new Error("Hotspot user \""+name+"\" was not found on MikroTik.");
      for(const item of matches) await connection.write("/ip/hotspot/user/remove", ["=.id="+item[".id"]]);
      return { username:name, removed:matches.length };
    });
  }
  async getActiveHotspotSessions() {
    return this._withConnection("active Hotspot session query", async (connection) => {
      const rows=await connection.write("/ip/hotspot/active/print");
      return (Array.isArray(rows)?rows:[]).map((item)=>({ id:this._str(item[".id"]), username:this._str(item.user), address:this._str(item.address), macAddress:this._str(item["mac-address"]), uptime:this._str(item.uptime), bytesIn:this._number(item["bytes-in"]), bytesOut:this._number(item["bytes-out"]), sessionTimeLeft:this._str(item["session-time-left"]), idleTime:this._str(item["idle-time"]), server:this._str(item.server), profile:this._str(item.profile), raw:item })).filter((item)=>item.username&&item.id);
    });
  }

  async getRouterIdentity() {
    try {
      return await this._withConnection("MikroTik identity query", async (connection) => {
        const rows = await connection.write("/system/identity/print");
        const name = this._str(Array.isArray(rows) ? rows[0]?.name : rows?.name).trim();
        return name || "MikroTik";
      });
    } catch (error) {
      console.warn("[MikroTik] Router identity unavailable; using fallback:", error?.message || error);
      return "MikroTik";
    }
  }

  async getIpPools() {
    return this._withConnection("IP pool query", async (connection) => {
      const rows = await connection.write("/ip/pool/print");
      return (Array.isArray(rows) ? rows : []).map((item) => ({
        id: this._str(item[".id"]),
        name: this._str(item.name),
        ranges: this._str(item.ranges),
        nextPool: this._str(item["next-pool"]) || "none",
        raw: item
      })).filter((item) => item.name && item.id);
    });
  }

  async createIpPool(data) {
    const name=this._str(data.name).trim(), ranges=this._str(data.ranges).trim(), nextPool=this._str(data.nextPool).trim() || "none";
    if(!name||!ranges) throw new Error("IP pool name and ranges are required.");
    return this._withConnection("IP pool creation",async(connection)=>{
      await connection.write("/ip/pool/add",this._writeParams({name,ranges,"next-pool":nextPool}));
      return {name,ranges,nextPool};
    });
  }

  _extractRouterError(error) {
    const candidates=[error,error?.cause,error?.error,error?.response,error?.data].filter(Boolean);
    for(const item of candidates){
      const message=this._str(item?.message||item?.["=message"]||item?.error).trim();
      const category=this._str(item?.category||item?.["=category"]).trim();
      if(message)return {message,category};
    }
    return {message:"MikroTik rejected the IP pool operation.",category:""};
  }
  async _findIpPool(connection,identifier) {
    const key=this._str(identifier).trim(), rows=await connection.write("/ip/pool/print"), items=Array.isArray(rows)?rows:[];
    const match=items.find(item=>this._str(item[".id"])===key)||items.find(item=>this._str(item.name)===key);
    if(!match||!match[".id"]) throw new Error('MikroTik IP pool "'+key+'" was not found.');
    if(/^default(?:[-_].*)?$/i.test(this._str(match.name))) throw new Error("The default system IP pool cannot be modified.");
    return match;
  }
  async updateIpPool(originalName,data) {
     const key=this._str(originalName).trim();
     const name=this._str(data.name).trim(), ranges=this._str(data.ranges).trim();
     const nextPool=this._str(data.nextPool).trim();
     if(!key) throw new Error("Pool identifier and ranges are required");
     if(!name||!ranges) throw new Error("IP pool name and ranges are required.");
     return this._withConnection("IP pool update",async(connection)=>{
       // Resolve the current RouterOS ID from this live session.
       const item=await this._findIpPool(connection,key);
       const targetId=this._str(item[".id"]).trim();
       const targetNextPool=nextPool&&nextPool.toLowerCase()!=="none"?nextPool:"none";
       const params=[
         "=.id="+targetId,
         "=name="+name,
         "=ranges="+ranges,
         "=next-pool="+targetNextPool
       ];
       await connection.write("/ip/pool/set",params);
       return {id:targetId,name,ranges,nextPool:targetNextPool};
     });
   }
   async deleteIpPool(originalName) {
     const key=this._str(originalName).trim();
     if(!key) throw new Error("Pool identifier is required");
     return this._withConnection("IP pool deletion",async(connection)=>{
       // Resolve the current RouterOS ID by exact pool name in the same session.
       const item=await this._findIpPool(connection,key);
       const targetId=this._str(item[".id"]).trim();
       await connection.write("/ip/pool/remove",["=.id="+targetId]);
       return {id:targetId,name:this._str(item.name).trim()};
     });
   }
  async createProfile(data) {
    const name=this._str(data.name).trim();
    if(!name)throw new Error("Profile name is required.");
    return this._withConnection("PPPoE profile creation",async(connection)=>{
      const params=this._writeParams({
        name,
        "rate-limit":data.rateLimit,
        "local-address":data.localAddress,
        "remote-address":data.remoteAddress,
        "dns-server":data.dnsServer,
        "change-tcp-mss":data.changeTcpMss||"default"
      });
      await connection.write("/ppp/profile/add",params);
      return {name};
    });
  }

  async updateProfile(identifier,data){
    const key=this._str(identifier).trim();
    return this._withConnection("PPPoE profile update",async(connection)=>{
      const rows=await connection.write("/ppp/profile/print");
      const items=Array.isArray(rows)?rows:[];
      const item=items.find(x=>this._str(x[".id"])===key)||items.find(x=>this._str(x.name)===key);
      if(!item||!item[".id"])throw new Error("PPPoE profile not found.");
      const params=[
        "=.id="+item[".id"],
        "=name="+this._str(data.name).trim(),
        "=local-address="+this._str(data.localAddress??data["local-address"]),
        "=remote-address="+this._str(data.remoteAddress??data["remote-address"]),
        "=dns-server="+this._str(data.dnsServer??data["dns-server"]),
        "=change-tcp-mss="+(this._str(data.changeTcpMss??data["change-tcp-mss"])||"default"),
        "=rate-limit="+this._str(data.rateLimit??data["rate-limit"])
      ];
      await connection.write("/ppp/profile/set",params);
      return {id:this._str(item[".id"]),name:this._str(data.name).trim()};
    });
  }

  async isProfileInUse(profileName){
    const name=this._str(profileName).trim();
    if(!name)return false;
    return this._withConnection("PPPoE profile usage check",async(connection)=>{
      const rows=await connection.write("/ppp/secret/print");
      return (Array.isArray(rows)?rows:[]).some(item=>this._str(item.profile).trim().toLowerCase()===name.toLowerCase());
    });
  }

  async removeProfile(identifier){
    const key=this._str(identifier).trim();
    return this._withConnection("PPPoE profile removal",async(connection)=>{
      const rows=await connection.write("/ppp/profile/print");
      const items=Array.isArray(rows)?rows:[];
      const item=items.find(x=>this._str(x[".id"])===key)||items.find(x=>this._str(x.name)===key);
      if(!item||!item[".id"])throw new Error("PPPoE profile not found.");
      const profileName=this._str(item.name);
      if(/^default$/i.test(profileName))throw new Error('The default MikroTik PPP profile cannot be deleted.');
      try{
        await connection.write("/ppp/profile/remove",["=.id="+item[".id"]]);
      }catch(error){
        const message=this._str(error?.message||error).trim();
        if(/used|in use|reference|referenced/i.test(message))throw new Error('MikroTik profile "'+profileName+'" is in use and cannot be deleted. Disconnect or reassign its users first.');
        throw error;
      }
      return {id:this._str(item[".id"]),name:profileName,removed:true};
    });
  }

  async createSecret(data) {
    const name = this._str(data.username).trim(); const password = this._str(data.password); const profile = this._str(data.profile).trim();
    if (!name || !password || !profile) throw new Error("Username, password, and profile are required.");
    return this._withConnection("PPPoE user creation", async (connection) => { const params = this._writeParams({ name, password, profile, service: "pppoe", "caller-id": data.callerId, comment: data.comment, disabled: data.disabled ? "yes" : undefined }); await connection.write("/ppp/secret/add", params); return { username: name }; });
  }
  async removeSecret(username) {
    const name = this._str(username).trim();
    if (!name) throw new Error("PPPoE username is required.");

    return this._withConnection("PPPoE user removal", async (connection) => {
      const secret = await this._findSecret(connection, name);
      await connection.write("/ppp/secret/remove", ["=.id=" + secret[".id"]]);
      return { username: name, removed: true };
    });
  }
  async _findSecret(connection, username) { const rows = await connection.write("/ppp/secret/print"); const match = (Array.isArray(rows) ? rows : []).find((item) => this._str(item.name) === username); if (!match || !match[".id"]) throw new Error("PPPoE user \"" + username + "\" was not found on MikroTik."); return match; }
  async updateSecret(username,data){const name=this._str(username).trim();return this._withConnection("PPPoE user update",async(connection)=>{const secret=await this._findSecret(connection,name);const params=this._writeParams({password:data.password,profile:data.profile,"remote-address":data.remoteAddress,"caller-id":data.callerId,comment:data.comment,disabled:data.disabled?"yes":"no"});await connection.write("/ppp/secret/set",["=.id="+secret[".id"],...params]);return {username:name};});}
  async toggleSecret(username, disabled) { const name = this._str(username).trim(); return this._withConnection("PPPoE user toggle", async (connection) => { const secret = await this._findSecret(connection, name); await connection.write("/ppp/secret/set", ["=.id=" + secret[".id"], "=disabled=" + (disabled ? "yes" : "no")]); return { username: name, disabled: Boolean(disabled) }; }); }
  async kickActiveUser(username) { const name = this._str(username).trim(); return this._withConnection("active PPPoE user kick", async (connection) => { const rows = await connection.write("/ppp/active/print"); const matches = (Array.isArray(rows) ? rows : []).filter((item) => this._str(item.name) === name && this._str(item.service).toLowerCase() === "pppoe" && item[".id"]); if (!matches.length) return { username: name, kicked: false, count: 0, message: "User is not currently online." }; for (const session of matches) await connection.write("/ppp/active/remove", ["=.id=" + session[".id"]]); return { username: name, kicked: true, count: matches.length }; }); }
}

module.exports = new MikroTikService();

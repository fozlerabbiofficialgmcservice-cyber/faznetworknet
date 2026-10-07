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
      const message = error && error.message ? error.message : String(error);
      const wrapped = new Error("MikroTik " + operationName + " failed: " + message); wrapped.cause = error; wrapped.code = error && error.code ? error.code : "MIKROTIK_ERROR"; throw wrapped;
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
      return (Array.isArray(rows) ? rows : []).map((item) => ({ id: this._str(item[".id"]), name: this._str(item.name), rateLimit: this._str(item["rate-limit"]), localAddress: this._str(item["local-address"]), remoteAddress: this._str(item["remote-address"]), sessionTimeout: this._str(item["session-timeout"]), idleTimeout: this._str(item["idle-timeout"]), onlyOne: this._bool(item["only-one"]), changeTcpMss: this._bool(item["change-tcp-mss"]), comment: this._str(item.comment), raw: item })).filter((item) => item.name);
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
        id: this._str(item[".id"]), name: this._str(item.name), hotspotAddress: this._str(item["hotspot-address"]),
        dnsName: this._str(item["dns-name"]), htmlDirectory: this._str(item["html-directory"]),
        rateLimit: this._str(item["rate-limit"]), loginBy: this._str(item["login-by"]),
        useRadius: this._bool(item["use-radius"]), raw: item
      })).filter((item) => item.name);
    });
  }
  async getHotspotProfiles() {
    return this._withConnection("Hotspot profile query", async (connection) => {
      const rows = await connection.write("/ip/hotspot/user/profile/print");
      return (Array.isArray(rows) ? rows : []).map((item) => ({ name: this._str(item.name), rateLimit: this._str(item["rate-limit"]), sharedUsers: this._str(item["shared-users"]), idleTimeout: this._str(item["idle-timeout"]), keepaliveTimeout: this._str(item["keepalive-timeout"]), statusAutorefresh: this._str(item["status-autorefresh"]), raw: item })).filter((item) => item.name);
    });
  }
  async createHotspotUser(data) {
    const username=this._str(data.username).trim(), password=this._str(data.password), profile=this._str(data.profile).trim();
    if(!username || !password || !profile) throw new Error("Hotspot username, password, and profile are required.");
    return this._withConnection("Hotspot user creation", async (connection) => { await connection.write("/ip/hotspot/user/add", this._writeParams({ name: username, password, profile, comment: data.comment })); return { username }; });
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
      return (Array.isArray(rows)?rows:[]).map((item)=>({ id:this._str(item[".id"]), username:this._str(item.user), address:this._str(item.address), macAddress:this._str(item["mac-address"]), uptime:this._str(item.uptime), server:this._str(item.server), profile:this._str(item.profile), bytesIn:this._number(item["bytes-in"]), bytesOut:this._number(item["bytes-out"]), raw:item })).filter((item)=>item.username);
    });
  }

  async createProfile(data) {
    const name = this._str(data.name).trim(); if (!name) throw new Error("Profile name is required.");
    return this._withConnection("PPPoE profile creation", async (connection) => {
      const params = this._writeParams({ name, "rate-limit": data.rateLimit, "local-address": data.localAddress, "remote-address": data.remoteAddress, "session-timeout": data.sessionTimeout, "idle-timeout": data.idleTimeout, "only-one": data.onlyOne ? "yes" : undefined, "change-tcp-mss": data.changeTcpMss ? "yes" : undefined, comment: data.comment });
      await connection.write("/ppp/profile/add", params); return { name };
    });
  }
  async createSecret(data) {
    const name = this._str(data.username).trim(); const password = this._str(data.password); const profile = this._str(data.profile).trim();
    if (!name || !password || !profile) throw new Error("Username, password, and profile are required.");
    return this._withConnection("PPPoE user creation", async (connection) => { const params = this._writeParams({ name, password, profile, service: "pppoe", "caller-id": data.callerId, comment: data.comment, disabled: data.disabled ? "yes" : undefined }); await connection.write("/ppp/secret/add", params); return { username: name }; });
  }
  async _findSecret(connection, username) { const rows = await connection.write("/ppp/secret/print"); const match = (Array.isArray(rows) ? rows : []).find((item) => this._str(item.name) === username); if (!match || !match[".id"]) throw new Error("PPPoE user \"" + username + "\" was not found on MikroTik."); return match; }
  async updateSecret(username, data) { const name = this._str(username).trim(); return this._withConnection("PPPoE user update", async (connection) => { const secret = await this._findSecret(connection, name); const params = this._writeParams({ password: data.password, profile: data.profile, "caller-id": data.callerId, comment: data.comment, disabled: data.disabled ? "yes" : "no" }); await connection.write("/ppp/secret/set", ["=.id=" + secret[".id"], ...params]); return { username: name }; }); }
  async toggleSecret(username, disabled) { const name = this._str(username).trim(); return this._withConnection("PPPoE user toggle", async (connection) => { const secret = await this._findSecret(connection, name); await connection.write("/ppp/secret/set", ["=.id=" + secret[".id"], "=disabled=" + (disabled ? "yes" : "no")]); return { username: name, disabled: Boolean(disabled) }; }); }
  async kickActiveUser(username) { const name = this._str(username).trim(); return this._withConnection("active PPPoE user kick", async (connection) => { const rows = await connection.write("/ppp/active/print"); const matches = (Array.isArray(rows) ? rows : []).filter((item) => this._str(item.name) === name && this._str(item.service).toLowerCase() === "pppoe" && item[".id"]); if (!matches.length) return { username: name, kicked: false, count: 0, message: "User is not currently online." }; for (const session of matches) await connection.write("/ppp/active/remove", ["=.id=" + session[".id"]]); return { username: name, kicked: true, count: matches.length }; }); }
}

module.exports = new MikroTikService();

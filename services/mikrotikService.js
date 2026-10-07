const { RouterOSAPI } = require("node-routeros");

const CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_PORT = 8728;

class MikroTikService {
  constructor() {
    this._configSignature = null;
  }

  _getConfig() {
    const host = String(process.env.ROUTER_HOST || "").trim();
    const port = Number.parseInt(process.env.ROUTER_PORT || DEFAULT_PORT, 10);
    const user = String(process.env.ROUTER_USER || "").trim();
    const password = String(process.env.ROUTER_PASS || "");

    if (!host) throw new Error("MikroTik configuration error: ROUTER_HOST is not configured.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("MikroTik configuration error: ROUTER_PORT must be a valid TCP port.");
    }
    if (!user) throw new Error("MikroTik configuration error: ROUTER_USER is not configured.");

    return { host, port, user, password };
  }

  _createConnection(config) {
    return new RouterOSAPI({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      timeout: CONNECTION_TIMEOUT_MS / 1000
    });
  }

  async _withConnection(operationName, operation) {
    const config = this._getConfig();
    const connection = this._createConnection(config);
    let timer;

    try {
      const connectPromise = connection.connect();
      await Promise.race([
        connectPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Connection timed out after 5 seconds.")), CONNECTION_TIMEOUT_MS);
        })
      ]);

      return await operation(connection);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const wrapped = new Error(`MikroTik ${operationName} failed: ${message}`);
      wrapped.cause = error;
      wrapped.code = error && error.code ? error.code : "MIKROTIK_ERROR";
      throw wrapped;
    } finally {
      if (timer) clearTimeout(timer);
      await this._safeClose(connection);
    }
  }

  async _safeClose(connection) {
    if (!connection) return;
    try {
      if (typeof connection.close === "function") {
        await Promise.resolve(connection.close());
      } else if (typeof connection.disconnect === "function") {
        await Promise.resolve(connection.disconnect());
      } else if (typeof connection.destroy === "function") {
        connection.destroy();
      }
    } catch (_) {
      // Cleanup errors must never crash the Express process.
    }
  }

  _firstRow(rows, operationName) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`MikroTik ${operationName} returned no data.`);
    }
    return rows[0];
  }

  _number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  _formatUptime(value) {
    const raw = String(value || "").trim();
    if (!raw) return "unknown";
    return raw;
  }

  async testConnection() {
    return this._withConnection("connection test", async (connection) => {
      const identity = this._firstRow(await connection.write("/system/identity/print"), "identity query");
      const resources = this._firstRow(await connection.write("/system/resource/print"), "resource query");
      return {
        routerName: String(identity.name || "Unknown Router"),
        version: String(resources.version || "Unknown")
      };
    });
  }

  async getSystemResources() {
    return this._withConnection("resource query", async (connection) => {
      const resource = this._firstRow(await connection.write("/system/resource/print"), "resource query");
      const totalMemoryBytes = this._number(resource["total-memory"]);
      const freeMemoryBytes = this._number(resource["free-memory"]);

      return {
        cpuLoad: this._number(resource["cpu-load"]),
        freeMemoryMb: Number((freeMemoryBytes / 1024 / 1024).toFixed(2)),
        totalMemoryMb: Number((totalMemoryBytes / 1024 / 1024).toFixed(2)),
        memoryUsedMb: Number(Math.max(0, totalMemoryBytes - freeMemoryBytes) / 1024 / 1024).toFixed(2) * 1,
        memoryUsagePercent: totalMemoryBytes > 0
          ? Number((((totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes) * 100).toFixed(1))
          : 0,
        uptime: this._formatUptime(resource.uptime),
        version: String(resource.version || "Unknown")
      };
    });
  }

  async getInterfaces() {
    return this._withConnection("interface query", async (connection) => {
      const rows = await connection.write("/interface/print");
      return (Array.isArray(rows) ? rows : [])
        .filter((item) => {
          const type = String(item.type || "").toLowerCase();
          return ["ether", "ethernet", "sfp", "sfp-sfpplus", "sfpplus", "bridge", "vlan"].some((allowed) => type.includes(allowed));
        })
        .map((item) => ({
          name: String(item.name || ""),
          type: String(item.type || "unknown"),
          running: String(item.running || "false") === "true",
          disabled: String(item.disabled || "false") === "true",
          comment: String(item.comment || "")
        }))
        .filter((item) => item.name);
    });
  }

  async getInterfaceTraffic(interfaceName) {
    const name = String(interfaceName || "").trim();
    if (!name || name.length > 100) {
      throw new Error("MikroTik traffic query failed: a valid interface name is required.");
    }

    return this._withConnection(`traffic query for ${name}`, async (connection) => {
      const rows = await connection.write("/interface/monitor-traffic", [
        `=interface=${name}`,
        "=once=true"
      ]);
      const traffic = this._firstRow(rows, "traffic query");

      const rxBitsPerSecond = this._number(traffic["rx-bits-per-second"]);
      const txBitsPerSecond = this._number(traffic["tx-bits-per-second"]);

      return {
        interface: name,
        rxBitsPerSecond,
        txBitsPerSecond,
        rxMbps: Number((rxBitsPerSecond / 1000000).toFixed(3)),
        txMbps: Number((txBitsPerSecond / 1000000).toFixed(3)),
        rxKbps: Number((rxBitsPerSecond / 1000).toFixed(1)),
        txKbps: Number((txBitsPerSecond / 1000).toFixed(1)),
        timestamp: new Date().toISOString()
      };
    });
  }
}

module.exports = new MikroTikService();

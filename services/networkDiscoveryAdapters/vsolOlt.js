/**
 * Inactive V-SOL OLT adapter placeholder.
 * Web credentials alone do not establish SSH, Telnet, or SNMP availability.
 * This module performs no network I/O and emits no invented ONU observations.
 */
const { registerAdapter } = require("./index");

registerAdapter({
  key: "vsol-olt-unverified",
  vendor: "V-SOL",
  deviceTypes: ["olt"],
  protocols: ["ssh", "telnet", "snmp", "https"],
  create: () => ({
    async probe() {
      return {
        supported: false,
        status: "not_configured",
        readOnly: true,
        message: "V-SOL protocol, firmware support and read-only access must be verified before enabling discovery."
      };
    },
    async discover() {
      return {
        supported: false,
        status: "not_configured",
        readOnly: true,
        observations: [],
        message: "No OLT/ONU discovery was attempted because protocol support has not been verified."
      };
    }
  })
});

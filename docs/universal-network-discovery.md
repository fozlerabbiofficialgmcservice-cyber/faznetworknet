# Universal Network Discovery: safe enablement

The 10-minute collector only runs when a network_discovery_sources row is explicitly enabled for an inventoried MikroTik device and uses protocol routeros_api or mikrotik_api. Without that row it skips before opening a RouterOS connection. Manual admin discovery remains read-only.

After verifying the intended inventory record, enable one source with a reviewed SQL migration or administrative workflow. Use the exact device ID and source key; do not enable multiple sources for one router until multi-device source selection is implemented.

## V-SOL OLT

The adapter registry includes a deliberately inactive V-SOL placeholder. It does not probe or connect to the OLT and emits no fabricated ONU observations. Actual discovery requires verified protocol reachability, firmware/command or MIB support, and a read-only account. Web UI credentials must not be reused as SSH/SNMP credentials unless independently confirmed.

## Data safety

- Discovery must never provision or change RouterOS/OLT configuration.
- PPPoE username matching only attaches an observation when exactly one customer matches.
- Bridge-host MACs are not automatically labelled as router or ONU MACs.
- Unknown or ambiguous identities remain unattached pending independent evidence.

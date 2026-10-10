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


## V-SOL V1601E04-DP/BT: read-only command verification

Public EPON references describe the following as read-only inspection commands, but syntax can vary by firmware build. Do not execute them automatically from the application until the exact output has been confirmed on this OLT.

- `show version` — identify the installed firmware (inspection only; do not upgrade).
- `show onu opm-diag all` — candidate command to list ONU optical diagnostics.
- `show onu opm-diag pon 1` — candidate command for a single PON port; replace the port only after confirming the installed CLI syntax.
- `show onu 1 ctc opm_diag` — candidate single-ONU optical diagnostics, only after confirming the correct PON interface context and ONU ID.

The command names above are candidates from public EPON references, not yet validated against the live device. Do not use `configure`, `write`, `reboot`, firmware operations, or any configuration-changing command for this task. The next collector milestone requires a redacted sample of the actual read-only CLI output, including ONU ID/MAC and RX Power (dBm), plus confirmed read-only SSH/CLI access. Never store or commit credentials or raw authentication data.


## Confirmed OLT web UI evidence (operator screenshot, 2026-10-11)

The operator confirmed that the existing V-SOL OLT web UI already displays the **ONU OPM Diag** table. The screenshot shows columns for ONU ID, MAC Address, Description, Distance, Temperature, Supply Voltage, TX Bias Current, TX Power, and **RX Power (dBm)**, with a PON selector (shown as PON1) and Refresh action. Example rows use EPON ONU IDs such as EPON0/1:2 and EPON0/1:3.

This confirms optical measurements are available in the installed UI; it does **not** establish an API endpoint, SSH/CLI command syntax, SNMP OID, or automated access credentials. Do not scrape or automate the browser UI using guessed endpoints. The next implementation step is to verify a supported read-only programmatic interface for this exact OLT/firmware, then match ONU MAC to the customer's stored `onu_mac` using normalized exact MAC comparison and reject duplicate/ambiguous matches. Keep RouterOS PPPoE caller-id MAC separate. Record the observed RX dBm, timestamp, and OLT source only from a successful live read. Do not upgrade firmware or change OLT configuration.

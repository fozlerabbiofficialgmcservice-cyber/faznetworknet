#!/usr/bin/env python3
"""Read-only V-SOL EPON optical telemetry over Telnet/SSH and push it to FAZ NETWORK."""
import json
import logging
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

LOG = logging.getLogger("faz-vsol-container")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s %(levelname)s %(message)s")

ANSI_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
PROMPT_RE = re.compile(r"(?im)(?:^|\n)\s*[^\r\n]{0,80}OLT\s*[>#]\s*$")
PORT_RE = re.compile(r"(?i)EPON\s*0\s*/\s*(\d+)\s*:\s*(\d+)")
MAC_RE = re.compile(r"(?i)(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}")
NUMBER_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")
NA_VALUES = {"", "n/a", "na", "n.a.", "-", "--", "none", "null", "offline", "los", "down"}

def env(name, default=""):
    return os.getenv(name, default).strip()

def required(name):
    value = env(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return value

def parse_power(value, minimum, maximum):
    text = value.strip()
    if text.lower() in NA_VALUES or not NUMBER_RE.fullmatch(text):
        return None
    number = float(text)
    if not minimum <= number <= maximum:
        return None
    return round(number, 2)

def parse_mac_output(text):
    """Map explicit EPON0/x:y identifiers to MACs only when both occur on one output line."""
    found = {}
    for line in text.splitlines():
        port = PORT_RE.search(line)
        mac = MAC_RE.search(line)
        if port and mac:
            key = (int(port.group(1)), int(port.group(2)))
            found[key] = mac.group(0).replace("-", ":").lower()
    return found

def parse_opm_output(text, mac_map=None, observed_at=None):
    """Parse the documented pipe-delimited table; unknown layouts are rejected, not guessed."""
    mac_map = mac_map or {}
    observed_at = observed_at or datetime.now(timezone.utc).isoformat()
    rows = {}
    for line in text.splitlines():
        match = PORT_RE.search(line)
        if not match:
            continue
        # Expected fields after the EPONx/y:ONU identifier:
        # Voltage | Bias | TX power (dBm) | RX power (dBm)
        if "|" in line:
            fields = [part.strip() for part in line.split("|")]
            # Handle either "EPON0/1:1 | V | Bias | TX | RX" or a leading table separator.
            ident_index = next((i for i, part in enumerate(fields) if PORT_RE.search(part)), None)
            if ident_index is None or len(fields) < ident_index + 5:
                LOG.warning("Skipping unrecognized optical row (wrong column count): %s", line.strip())
                continue
            tx_raw, rx_raw = fields[ident_index + 3], fields[ident_index + 4]
        else:
            # Whitespace-only formats vary across firmware; don't infer column boundaries.
            LOG.warning("Skipping optical row without pipe-delimited columns: %s", line.strip())
            continue
        pon_index, onu_number = int(match.group(1)), int(match.group(2))
        # This collector is intentionally scoped to EPON 0/1 through 0/4.
        if pon_index not in range(1, 5):
            continue
        rx = parse_power(rx_raw, -50, 10)
        tx = parse_power(tx_raw, -50, 20)
        unavailable = rx is None and tx is None
        key = (pon_index, onu_number)
        rows[key] = {
            "onuId": f"EPON0/{pon_index}:{onu_number}",
            "onuMac": mac_map.get(key),
            "ponPort": f"EPON0/{pon_index}",
            "status": "unknown" if unavailable else "online",
            "rxPowerDbm": rx,
            "txPowerDbm": tx,
            "observedAt": observed_at,
            "sourceAgent": env("COLLECTOR_ID", "mikrotik-vsol-container"),
            "raw": {"opticalRow": line.strip(), "rxRaw": rx_raw, "txRaw": tx_raw},
        }
    return list(rows.values())

class OLTSession:
    def __init__(self):
        self.host = required("OLT_HOST")
        self.port = int(env("OLT_PORT", "23"))
        self.protocol = env("OLT_PROTOCOL", "telnet").lower()
        self.connect_timeout = float(env("CONNECT_TIMEOUT_SECONDS", "8"))
        self.command_timeout = float(env("COMMAND_TIMEOUT_SECONDS", "20"))
        self.sock = None
        self.buffer = b""

    def connect(self):
        if self.protocol not in {"telnet", "ssh"}:
            raise RuntimeError("OLT_PROTOCOL must be telnet or ssh")
        if self.protocol == "ssh":
            # Optional SSH dependency deliberately not bundled into the minimal Telnet image.
            raise RuntimeError("SSH fallback is not enabled in this minimal image; use Telnet or add a verified SSH adapter.")
        self.sock = socket.create_connection((self.host, self.port), self.connect_timeout)
        self.sock.settimeout(0.5)
        LOG.info("Connected to OLT %s:%s using Telnet", self.host, self.port)
        self._wait_for([re.compile(rb"(?i)login\s*:"), re.compile(rb"(?i)username\s*:"), re.compile(rb"(?i)password\s*:"), re.compile(rb"(?m)OLT\s*[>#]\s*$")], 10)
        lower = self.buffer.lower()
        if b"login:" in lower or b"username:" in lower:
            self._send(required("OLT_USERNAME"))
            self._wait_for([re.compile(rb"(?i)password\s*:")], 10)
            self._send(required("OLT_PASSWORD"))
            self._wait_for([re.compile(rb"(?m)OLT\s*[>#]\s*$")], 15)
        elif b"password:" in lower:
            self._send(required("OLT_PASSWORD"))
            self._wait_for([re.compile(rb"(?m)OLT\s*[>#]\s*$")], 15)
        self.buffer = b""
        if re.search(rb"(?m)OLT\s*>\s*$", self.buffer):
            self._send("enable")
            try:
                self._wait_for([re.compile(rb"(?i)password\s*:"), re.compile(rb"(?m)OLT\s*#\s*$")], 5)
                if b"password" in self.buffer.lower():
                    self._send(required("OLT_ENABLE_PASSWORD"))
                    self._wait_for([re.compile(rb"(?m)OLT\s*#\s*$")], 8)
            except (TimeoutError, RuntimeError):
                raise RuntimeError("OLT is in user mode but enable mode could not be confirmed")
        self.buffer = b""

    def _send(self, value):
        self.sock.sendall(value.encode("utf-8") + b"\r\n")

    def _read_more(self):
        try:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("OLT closed the Telnet connection")
            # Basic Telnet option negotiation: refuse options safely (IAC WONT/DONT).
            out, i = bytearray(), 0
            while i < len(chunk):
                if chunk[i] == 255 and i + 1 < len(chunk):
                    command = chunk[i + 1]
                    if command in (251, 252, 253, 254) and i + 2 < len(chunk):
                        verb = 254 if command in (251, 253) else 252
                        self.sock.sendall(bytes((255, verb, chunk[i + 2])))
                        i += 3
                        continue
                    if command == 255:
                        out.append(255); i += 2; continue
                out.append(chunk[i]); i += 1
            self.buffer += bytes(out)
        except socket.timeout:
            pass

    def _wait_for(self, patterns, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            text = self.buffer
            if any(pattern.search(text) for pattern in patterns):
                return text
            self._read_more()
        clean = ANSI_RE.sub(b"", self.buffer).decode("utf-8", "replace")[-600:]
        raise TimeoutError(f"Timed out waiting for OLT prompt. Last output: {clean!r}")

    def command(self, command):
        self.buffer = b""
        self._send(command)
        self._wait_for([re.compile(rb"(?m)OLT\s*[>#]\s*$")], self.command_timeout)
        output = ANSI_RE.sub(b"", self.buffer).decode("utf-8", "replace")
        return output.replace("\r", "")

    def close(self):
        if self.sock:
            try: self.sock.close()
            finally: self.sock = None

def collect():
    observed_at = datetime.now(timezone.utc).isoformat()
    session = OLTSession()
    try:
        session.connect()
        combined = []
        mac_output = ""
        try:
            mac_output = session.command(env("OLT_MAC_COMMAND", "show onu mac"))
        except Exception as exc:
            LOG.warning("Optional MAC command failed; optical readings will still be collected: %s", exc)
        mac_map = parse_mac_output(mac_output)
        for port in range(1, 5):
            command = env("OLT_OPM_COMMAND_TEMPLATE", "show onu opm-diag epon 0/{port}").format(port=port)
            output = session.command(command)
            parsed = parse_opm_output(output, mac_map, observed_at)
            LOG.info("PON EPON0/%s: parsed %s optical rows", port, len(parsed))
            combined.extend(parsed)
        if not combined:
            raise RuntimeError("No optical rows parsed from any PON. OLT output format must be checked before enabling production ingestion.")
        return combined
    finally:
        session.close()

def push(readings):
    endpoint = required("RENDER_INGEST_URL")
    token = required("OLT_COLLECTOR_TOKEN")
    payload = json.dumps({"oltId": required("OLT_ID"), "readings": readings}).encode("utf-8")
    request = urllib.request.Request(endpoint, data=payload, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token,
        "User-Agent": "FAZ-NETWORK-VSOL-Collector/1.0",
    })
    try:
        with urllib.request.urlopen(request, timeout=15, context=ssl.create_default_context()) as response:
            body = response.read(4096).decode("utf-8", "replace")
            if not 200 <= response.status < 300:
                raise RuntimeError(f"Render ingest returned HTTP {response.status}: {body}")
            LOG.info("Render accepted telemetry: %s", body)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Render ingest HTTP {exc.code}: {exc.read(2048).decode('utf-8', 'replace')}") from exc

def main():
    interval = max(60, int(env("POLL_INTERVAL_SECONDS", "300")))
    while True:
        started = time.monotonic()
        try:
            readings = collect()
            push(readings)
        except Exception:
            LOG.exception("OLT telemetry cycle failed; retrying next cycle")
        time.sleep(max(1, interval - (time.monotonic() - started)))

if __name__ == "__main__":
    main()

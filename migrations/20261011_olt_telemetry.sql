CREATE TABLE IF NOT EXISTS olt_telemetry (
  id BIGSERIAL PRIMARY KEY,
  olt_id VARCHAR(160) NOT NULL,
  onu_mac MACADDR,
  onu_id VARCHAR(160) NOT NULL,
  pon_port VARCHAR(100),
  status VARCHAR(20) NOT NULL CHECK (status IN ('online','offline','los','unknown')),
  rx_power_dbm NUMERIC(6,2) CHECK (rx_power_dbm IS NULL OR (rx_power_dbm >= -50 AND rx_power_dbm <= 10)),
  tx_power_dbm NUMERIC(6,2) CHECK (tx_power_dbm IS NULL OR (tx_power_dbm >= -50 AND tx_power_dbm <= 20)),
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_agent VARCHAR(160),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (olt_id, onu_id)
);
CREATE INDEX IF NOT EXISTS idx_olt_telemetry_mac ON olt_telemetry(onu_mac);
CREATE INDEX IF NOT EXISTS idx_olt_telemetry_seen ON olt_telemetry(received_at DESC);

ALTER TABLE olt_telemetry ADD COLUMN IF NOT EXISTS pppoe_username VARCHAR(160);

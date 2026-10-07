CREATE TABLE IF NOT EXISTS pppoe_profiles (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  rate_limit TEXT,
  local_address TEXT,
  remote_address TEXT,
  session_timeout TEXT,
  idle_timeout TEXT,
  only_one BOOLEAN DEFAULT FALSE,
  change_tcp_mss BOOLEAN DEFAULT FALSE,
  comment TEXT,
  router_id TEXT,
  raw_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pppoe_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT,
  profile TEXT,
  service TEXT DEFAULT 'pppoe',
  caller_id TEXT,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  comment TEXT,
  phone TEXT,
  local_address TEXT,
  remote_address TEXT,
  router_id TEXT,
  raw_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'active',
  expiry_date TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('bkash','nagad','rocket')),
  trx_id VARCHAR(100) NOT NULL UNIQUE,
  sender_phone VARCHAR(40),
  amount NUMERIC(12,2) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('processed','unmatched','duplicate')),
  matched_username VARCHAR(100),
  raw_sms TEXT,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hotspot_vouchers (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(100) NOT NULL,
  profile VARCHAR(100) NOT NULL,
  validity VARCHAR(50) NOT NULL,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','active','expired')),
  comment VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pppoe_users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE pppoe_users ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS used BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_pppoe_users_profile ON pppoe_users(profile);
CREATE INDEX IF NOT EXISTS idx_pppoe_users_disabled ON pppoe_users(disabled);
CREATE INDEX IF NOT EXISTS idx_pppoe_users_synced_at ON pppoe_users(synced_at);
CREATE INDEX IF NOT EXISTS idx_pppoe_profiles_synced_at ON pppoe_profiles(synced_at);
CREATE INDEX IF NOT EXISTS idx_transactions_channel_created ON transactions(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_used ON transactions(used);

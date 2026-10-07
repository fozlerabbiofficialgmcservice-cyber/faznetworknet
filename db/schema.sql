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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pppoe_users_profile ON pppoe_users(profile);
CREATE INDEX IF NOT EXISTS idx_pppoe_users_disabled ON pppoe_users(disabled);
CREATE INDEX IF NOT EXISTS idx_pppoe_users_synced_at ON pppoe_users(synced_at);
CREATE INDEX IF NOT EXISTS idx_pppoe_profiles_synced_at ON pppoe_profiles(synced_at);

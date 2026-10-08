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
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone VARCHAR(40) NOT NULL UNIQUE,
  connection_date DATE NOT NULL,
  username VARCHAR(100) NOT NULL UNIQUE,
  password TEXT NOT NULL,
  package_name VARCHAR(100) NOT NULL,
  profile VARCHAR(100) NOT NULL,
  monthly_bill NUMERIC(12,2) NOT NULL CHECK (monthly_bill >= 0),
  nid VARCHAR(100),
  installation_address TEXT,
  fiber_box VARCHAR(150),
  onu_mac VARCHAR(100),
  remarks TEXT,
  provisioning_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (provisioning_status IN ('pending','provisioned','failed')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','left')),
  router_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

ALTER TABLE pppoe_profiles ADD COLUMN IF NOT EXISTS price NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE pppoe_users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE pppoe_users ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS used BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hotspot_vouchers ADD COLUMN IF NOT EXISTS phone VARCHAR(40);
ALTER TABLE hotspot_vouchers ADD COLUMN IF NOT EXISTS server VARCHAR(100) DEFAULT 'all';
ALTER TABLE hotspot_vouchers ADD COLUMN IF NOT EXISTS time_limit VARCHAR(50);
ALTER TABLE hotspot_vouchers ADD COLUMN IF NOT EXISTS data_limit VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_hotspot_vouchers_created_at ON hotspot_vouchers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hotspot_vouchers_phone ON hotspot_vouchers(phone);


CREATE INDEX IF NOT EXISTS idx_pppoe_users_profile ON pppoe_users(profile);
CREATE INDEX IF NOT EXISTS idx_pppoe_users_disabled ON pppoe_users(disabled);
CREATE INDEX IF NOT EXISTS idx_pppoe_users_synced_at ON pppoe_users(synced_at);
CREATE INDEX IF NOT EXISTS idx_pppoe_profiles_synced_at ON pppoe_profiles(synced_at);
CREATE INDEX IF NOT EXISTS idx_transactions_channel_created ON transactions(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_used ON transactions(used);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_profile ON customers(profile);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS expiration_date DATE;
CREATE INDEX IF NOT EXISTS idx_customers_expiration_date ON customers(expiration_date);

CREATE TABLE IF NOT EXISTS packages (id BIGSERIAL PRIMARY KEY,plan_name VARCHAR(120) NOT NULL UNIQUE,pool_name VARCHAR(100) NOT NULL,profile_name VARCHAR(120) NOT NULL,rate_limit VARCHAR(100) NOT NULL,price NUMERIC(12,2) NOT NULL CHECK(price>0),duration_months INTEGER NOT NULL DEFAULT 1 CHECK(duration_months>=1),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_packages_pool_name ON packages(pool_name);
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_status_check CHECK(status IN ('active','inactive','left','expired'));

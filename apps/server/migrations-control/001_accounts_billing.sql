-- Control database: who the clients are, how they log in, what they pay.
-- Each client's CRM data lives in its own tenant database file (see src/tenancy.ts).

CREATE TABLE IF NOT EXISTS plan (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_paise INTEGER NOT NULL CHECK (price_paise >= 100),
  currency TEXT NOT NULL DEFAULT 'INR',
  features_json TEXT NOT NULL DEFAULT '[]',
  razorpay_plan_id TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- tenant database file, relative to the data directory; NULL = the default desk database
  db_file TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  billing_exempt INTEGER NOT NULL DEFAULT 0,
  plan_id TEXT REFERENCES plan(id) ON DELETE SET NULL,
  -- access is paid up to this instant (ms); sending stops after paid_until + grace
  paid_until INTEGER,
  rz_subscription_id TEXT UNIQUE,
  rz_subscription_status TEXT,
  -- a subscription opened in Checkout but not yet authorised
  rz_pending_subscription_id TEXT UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin', 'owner')),
  -- NULL until the invite link has been used
  password_hash TEXT,
  invite_token_hash TEXT UNIQUE,
  invite_expires_at INTEGER,
  disabled_at INTEGER,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_user_account ON app_user(account_id);

-- Pairing codes are typed by hand, so they cannot carry the account id; this routes them.
CREATE TABLE IF NOT EXISTS pairing_route (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  rz_payment_id TEXT NOT NULL UNIQUE,
  rz_subscription_id TEXT,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_account ON payment(account_id, paid_at);

-- Razorpay retries webhooks; each event id is processed once.
CREATE TABLE IF NOT EXISTS webhook_event (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  account_id TEXT,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

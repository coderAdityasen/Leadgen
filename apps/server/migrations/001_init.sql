-- Schema Migration 001: Init
CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- operator
CREATE TABLE IF NOT EXISTS operator (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  default_country TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- operator_session
CREATE TABLE IF NOT EXISTS operator_session (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  hard_expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- extension_device
CREATE TABLE IF NOT EXISTS extension_device (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  paired_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT,
  wa_pushname TEXT,
  wa_jid TEXT,
  stream_mode TEXT,
  authenticated INTEGER NOT NULL DEFAULT 0,
  extension_version TEXT,
  bridge_version TEXT
);

-- pairing_code
CREATE TABLE IF NOT EXISTS pairing_code (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_by_session_id TEXT
);

-- sender_lease
CREATE TABLE IF NOT EXISTS sender_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device_id TEXT REFERENCES extension_device(id) ON DELETE SET NULL,
  lease_until INTEGER,
  grace_until INTEGER
);

-- pipeline
CREATE TABLE IF NOT EXISTS pipeline (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- stage
CREATE TABLE IF NOT EXISTS stage (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipeline(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE(pipeline_id, position)
);

-- lead
CREATE TABLE IF NOT EXISTS lead (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  stage_id TEXT NOT NULL REFERENCES stage(id),
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  require_approval INTEGER NOT NULL DEFAULT 0,
  automation_paused INTEGER NOT NULL DEFAULT 0,
  do_not_message INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER
);

-- phone_identity
CREATE TABLE IF NOT EXISTS phone_identity (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  e164 TEXT,
  wa_jid TEXT,
  wa_lid TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CONSTRAINT chk_at_least_one CHECK (e164 IS NOT NULL OR wa_jid IS NOT NULL OR wa_lid IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_identity_e164 ON phone_identity(e164) WHERE e164 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_identity_wa_jid ON phone_identity(wa_jid) WHERE wa_jid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_identity_wa_lid ON phone_identity(wa_lid) WHERE wa_lid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_identity_lead_primary ON phone_identity(lead_id) WHERE is_primary = 1;

-- sequence
CREATE TABLE IF NOT EXISTS sequence (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- sequence_step
CREATE TABLE IF NOT EXISTS sequence_step (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL REFERENCES sequence(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  delay_seconds INTEGER NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(sequence_id, position)
);

-- sequence_enrollment
CREATE TABLE IF NOT EXISTS sequence_enrollment (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL REFERENCES sequence(id) ON DELETE RESTRICT,
  lead_id TEXT NOT NULL REFERENCES lead(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'stopped')),
  current_step_id TEXT REFERENCES sequence_step(id) ON DELETE RESTRICT,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  stop_reason TEXT,
  idempotency_key TEXT UNIQUE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sequence_enrollment_lead_active ON sequence_enrollment(lead_id) WHERE status = 'active';

-- scheduled_message
CREATE TABLE IF NOT EXISTS scheduled_message (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES lead(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  allow_during_quiet_hours INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('materialized', 'cancelled')),
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

-- outbound_queue
CREATE TABLE IF NOT EXISTS outbound_queue (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES lead(id) ON DELETE RESTRICT,
  phone_id TEXT REFERENCES phone_identity(id) ON DELETE SET NULL,
  to_e164 TEXT,
  to_jid TEXT,
  needs_resolve INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('manual', 'scheduled', 'sequence', 'ai_reply')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'claimed', 'sent', 'failed', 'needs_review', 'needs_approval', 'cancelled', 'expired')),
  earliest_due_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  claim_token_hash TEXT,
  ack_token_hash TEXT,
  claimed_by_device_id TEXT REFERENCES extension_device(id) ON DELETE SET NULL,
  claimed_at INTEGER,
  claim_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  wa_message_id TEXT,
  scheduled_message_id TEXT REFERENCES scheduled_message(id) ON DELETE SET NULL,
  enrollment_id TEXT REFERENCES sequence_enrollment(id) ON DELETE SET NULL,
  step_id TEXT REFERENCES sequence_step(id) ON DELETE RESTRICT,
  inbound_message_id TEXT,
  idempotency_key TEXT UNIQUE,
  allow_during_quiet_hours INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outbound_queue_status_due_at ON outbound_queue(status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_queue_inbound ON outbound_queue(inbound_message_id) WHERE inbound_message_id IS NOT NULL;

-- message_log
CREATE TABLE IF NOT EXISTS message_log (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES lead(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  wa_message_id TEXT UNIQUE,
  body TEXT NOT NULL,
  from_jid TEXT NOT NULL,
  to_jid TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  wa_timestamp INTEGER NOT NULL,
  outbound_id TEXT REFERENCES outbound_queue(id) ON DELETE SET NULL,
  ai_state TEXT CHECK(ai_state IN ('pending', 'drafted', 'skipped', 'failed')),
  ai_reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_log_lead_created ON message_log(lead_id, created_at);

-- ai_settings
CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  mode TEXT NOT NULL DEFAULT 'off' CHECK(mode IN ('off', 'approve', 'auto')),
  system_instructions TEXT NOT NULL,
  provider_base_url TEXT NOT NULL DEFAULT 'https://api.x.ai/v1',
  model TEXT NOT NULL DEFAULT 'grok-4.7',
  api_key_ciphertext TEXT,
  api_key_nonce TEXT,
  api_key_last4 TEXT,
  max_completion_tokens INTEGER NOT NULL DEFAULT 400,
  updated_at INTEGER NOT NULL
);

-- desk_policy
CREATE TABLE IF NOT EXISTS desk_policy (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 1,
  quiet_start TEXT NOT NULL DEFAULT '21:00',
  quiet_end TEXT NOT NULL DEFAULT '08:00',
  daily_automated_cap INTEGER NOT NULL DEFAULT 80,
  daily_manual_cap INTEGER NOT NULL DEFAULT 200,
  min_automated_gap_seconds INTEGER NOT NULL DEFAULT 45,
  min_same_lead_gap_seconds INTEGER NOT NULL DEFAULT 180,
  ai_hourly_cap INTEGER NOT NULL DEFAULT 30,
  max_catchup_age_seconds INTEGER NOT NULL DEFAULT 21600,
  updated_at INTEGER NOT NULL
);

-- quick_reply
CREATE TABLE IF NOT EXISTS quick_reply (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- daily_counter
CREATE TABLE IF NOT EXISTS daily_counter (
  day_local TEXT PRIMARY KEY,
  automated_count INTEGER NOT NULL DEFAULT 0,
  manual_count INTEGER NOT NULL DEFAULT 0
);

-- ai_hourly_counter
CREATE TABLE IF NOT EXISTS ai_hourly_counter (
  hour_utc TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

-- health_probe
CREATE TABLE IF NOT EXISTS health_probe (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  touched_at INTEGER NOT NULL
);

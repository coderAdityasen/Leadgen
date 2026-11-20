-- Schema Migration 002: Seed default singleton rows and initial stages

-- Pipeline
INSERT OR IGNORE INTO pipeline (id, name) VALUES ('pip_leads', 'Leads');

-- Stages
INSERT OR IGNORE INTO stage (id, pipeline_id, name, position) VALUES ('stg_new', 'pip_leads', 'New', 0);
INSERT OR IGNORE INTO stage (id, pipeline_id, name, position) VALUES ('stg_contacted', 'pip_leads', 'Contacted', 1);
INSERT OR IGNORE INTO stage (id, pipeline_id, name, position) VALUES ('stg_waiting', 'pip_leads', 'Waiting', 2);
INSERT OR IGNORE INTO stage (id, pipeline_id, name, position) VALUES ('stg_won', 'pip_leads', 'Won', 3);
INSERT OR IGNORE INTO stage (id, pipeline_id, name, position) VALUES ('stg_lost', 'pip_leads', 'Lost', 4);

-- Sender lease singleton (id = 1)
INSERT OR IGNORE INTO sender_lease (id, device_id, lease_until, grace_until) VALUES (1, NULL, NULL, NULL);

-- Desk policy singleton (id = 1)
INSERT OR IGNORE INTO desk_policy (
  id,
  quiet_hours_enabled,
  quiet_start,
  quiet_end,
  daily_automated_cap,
  daily_manual_cap,
  min_automated_gap_seconds,
  min_same_lead_gap_seconds,
  ai_hourly_cap,
  max_catchup_age_seconds,
  updated_at
) VALUES (
  1,
  1,
  '21:00',
  '08:00',
  80,
  200,
  45,
  180,
  30,
  21600,
  0
);

-- AI settings singleton (id = 1)
INSERT OR IGNORE INTO ai_settings (
  id,
  mode,
  system_instructions,
  provider_base_url,
  model,
  api_key_ciphertext,
  api_key_nonce,
  api_key_last4,
  max_completion_tokens,
  updated_at
) VALUES (
  1,
  'off',
  'You answer WhatsApp messages for a one-person business. Be brief, polite, and specific. If you do not know, say you will check and follow up. Do not mention that you are an AI unless asked.',
  'https://api.x.ai/v1',
  'grok-4.7',
  NULL,
  NULL,
  NULL,
  400,
  0
);

-- Health probe singleton (id = 1)
INSERT OR IGNORE INTO health_probe (id, touched_at) VALUES (1, 0);

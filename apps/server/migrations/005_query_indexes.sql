-- Indexes for the queries that run on every poll (extension claim every ~5s, dashboard status
-- every ~10s) and on every sequence step. Without them those queries scan whole tables, which on
-- Turso counts against the monthly "rows read" allowance and grows with every message sent.

-- Latest automated send (gap checks in the claim loop): walk sent rows newest first.
CREATE INDEX IF NOT EXISTS idx_outbound_queue_status_sent_at ON outbound_queue(status, sent_at);

-- Rows of one sequence enrollment (step advancement, cancel, stop).
CREATE INDEX IF NOT EXISTS idx_outbound_queue_enrollment ON outbound_queue(enrollment_id) WHERE enrollment_id IS NOT NULL;

-- AI status on the dashboard and the stale-pending sweep.
CREATE INDEX IF NOT EXISTS idx_message_log_ai_state_created ON message_log(ai_state, created_at) WHERE ai_state IS NOT NULL;

-- All phones of a lead (lead detail, CRM cards).
CREATE INDEX IF NOT EXISTS idx_phone_identity_lead ON phone_identity(lead_id);

-- Enrollments of a sequence (delete / edit checks).
CREATE INDEX IF NOT EXISTS idx_sequence_enrollment_sequence ON sequence_enrollment(sequence_id, status);

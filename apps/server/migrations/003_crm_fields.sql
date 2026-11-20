-- Schema Migration 003: CRM lead fields for the stage board and the WhatsApp side panel

ALTER TABLE lead ADD COLUMN email TEXT;
ALTER TABLE lead ADD COLUMN company TEXT;
-- When the lead last moved stage; drives "days in stage" on the board.
ALTER TABLE lead ADD COLUMN stage_changed_at INTEGER;
UPDATE lead SET stage_changed_at = created_at WHERE stage_changed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lead_stage ON lead(stage_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_queue_lead_status ON outbound_queue(lead_id, status);

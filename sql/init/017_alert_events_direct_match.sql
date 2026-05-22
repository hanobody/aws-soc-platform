ALTER TABLE alert_events
  ADD COLUMN IF NOT EXISTS event_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS resource_type VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_event_id_unique
  ON alert_events(event_id);

ALTER TABLE alert_events
  ADD COLUMN IF NOT EXISTS event_source VARCHAR(255),
  ADD COLUMN IF NOT EXISTS source_ingested_event_id BIGINT REFERENCES ingested_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS matched_rule_id BIGINT REFERENCES alert_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notification_route_id BIGINT REFERENCES account_notification_routes(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS idx_alert_events_source_ingested_event_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_source_ingested_event_id_unique
  ON alert_events(source_ingested_event_id);

CREATE INDEX IF NOT EXISTS idx_alert_events_rule_time
  ON alert_events(matched_rule_id, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_event_source
  ON alert_events(event_source, event_time DESC);

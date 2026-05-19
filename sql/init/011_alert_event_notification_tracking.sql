ALTER TABLE alert_events
  ADD COLUMN IF NOT EXISTS notification_channel_id BIGINT REFERENCES notification_channels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notification_error TEXT,
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_alert_events_notification_status
  ON alert_events(alert_status, event_time DESC);

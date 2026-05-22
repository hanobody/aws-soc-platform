INSERT INTO account_notification_routes (account_id, project_name, environment, channel_id, enabled)
SELECT '*', 'default', 'default', nc.id, TRUE
FROM notification_channels nc
WHERE nc.enabled = TRUE
ORDER BY nc.id ASC
LIMIT 1
ON CONFLICT (account_id, channel_id) DO UPDATE
SET enabled = EXCLUDED.enabled,
    updated_at = NOW();

WITH default_route AS (
  SELECT id
  FROM account_notification_routes
  WHERE account_id = '*'
    AND enabled = TRUE
  ORDER BY id ASC
  LIMIT 1
)
UPDATE alert_rules
SET notification_route_id = (SELECT id FROM default_route)
WHERE notification_route_id IS NULL;

ALTER TABLE alert_rules
  ALTER COLUMN notification_route_id SET NOT NULL;

ALTER TABLE alert_rules
  DROP CONSTRAINT IF EXISTS alert_rules_notification_route_id_fkey,
  ADD CONSTRAINT alert_rules_notification_route_id_fkey
    FOREIGN KEY (notification_route_id)
    REFERENCES account_notification_routes(id)
    ON DELETE RESTRICT;

DROP INDEX IF EXISTS idx_alert_events_source_ingested_event_id_unique;

ALTER TABLE alert_events
  DROP COLUMN IF EXISTS source_ingested_event_id;

DROP TABLE IF EXISTS ingested_events;

CREATE TABLE IF NOT EXISTS rule_config_state (
  scope VARCHAR(80) PRIMARY KEY,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO rule_config_state (scope, version)
VALUES ('alert_rules', 1)
ON CONFLICT (scope) DO NOTHING;

ALTER TABLE alert_events
  ADD COLUMN IF NOT EXISTS matched_rule_name_snapshot VARCHAR(150),
  ADD COLUMN IF NOT EXISTS matched_rule_snapshot_json JSONB;

UPDATE alert_events ae
SET matched_rule_name_snapshot = ar.rule_name,
    matched_rule_snapshot_json = jsonb_build_object(
      'id', ar.id,
      'rule_name', ar.rule_name,
      'account_id', ar.account_id,
      'region_code', ar.region_code,
      'event_source', ar.event_source,
      'event_name', ar.event_name,
      'resource_type', ar.resource_type,
      'resource_pattern', ar.resource_pattern,
      'user_arn_pattern', ar.user_arn_pattern,
      'source_ip_pattern', ar.source_ip_pattern,
      'severity', ar.severity,
      'cooldown_seconds', ar.cooldown_seconds,
      'notification_route_id', ar.notification_route_id,
      'description', ar.description,
      'enabled', ar.enabled
    )
FROM alert_rules ar
WHERE ae.matched_rule_id = ar.id
  AND (ae.matched_rule_name_snapshot IS NULL OR ae.matched_rule_snapshot_json IS NULL);

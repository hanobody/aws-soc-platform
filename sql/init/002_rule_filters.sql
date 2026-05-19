ALTER TABLE alert_rules
  ADD COLUMN IF NOT EXISTS rule_name VARCHAR(150),
  ADD COLUMN IF NOT EXISTS resource_pattern TEXT,
  ADD COLUMN IF NOT EXISTS user_arn_pattern TEXT,
  ADD COLUMN IF NOT EXISTS source_ip_pattern TEXT;

CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled_lookup
  ON alert_rules(account_id, event_source, event_name, enabled);

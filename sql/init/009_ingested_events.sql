CREATE TABLE IF NOT EXISTS ingested_events (
  id BIGSERIAL PRIMARY KEY,

  schema_version VARCHAR(50) NOT NULL,
  event_id VARCHAR(128) NOT NULL,
  dedup_key VARCHAR(512) NOT NULL,

  ingest_source VARCHAR(100) NOT NULL,
  ingest_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  aws_account_id VARCHAR(32) NOT NULL,
  aws_region VARCHAR(32),
  aws_partition VARCHAR(16),

  event_source VARCHAR(255) NOT NULL,
  event_name VARCHAR(255) NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  event_detail_type VARCHAR(255),
  event_category VARCHAR(50),
  read_only BOOLEAN,

  actor_principal_type VARCHAR(64),
  actor_arn TEXT,
  actor_account_id VARCHAR(32),
  actor_user_name VARCHAR(255),
  actor_access_key_id VARCHAR(128),

  source_ip VARCHAR(64),
  user_agent TEXT,

  resource_type VARCHAR(128),
  resource_id VARCHAR(255),
  resource_name VARCHAR(255),
  resource_arn TEXT,

  request_id VARCHAR(255),
  request_parameters_json JSONB,
  response_elements_json JSONB,
  raw_event_json JSONB NOT NULL,

  process_status VARCHAR(32) NOT NULL DEFAULT 'new',
  process_attempts INTEGER NOT NULL DEFAULT 0,
  process_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_ingested_events_event_time
  ON ingested_events(event_time DESC);

CREATE INDEX IF NOT EXISTS idx_ingested_events_lookup
  ON ingested_events(aws_account_id, event_source, event_name, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_ingested_events_status
  ON ingested_events(process_status, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_ingested_events_resource
  ON ingested_events(resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_ingested_events_actor
  ON ingested_events(actor_arn);

CREATE INDEX IF NOT EXISTS idx_ingested_events_source_ip
  ON ingested_events(source_ip);

CREATE INDEX IF NOT EXISTS idx_ingested_events_raw_json
  ON ingested_events USING GIN(raw_event_json);

CREATE TABLE IF NOT EXISTS cloudtrail_sql_templates (
  id BIGSERIAL PRIMARY KEY,
  template_code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(512),
  category VARCHAR(64) NOT NULL DEFAULT 'general',
  template_type VARCHAR(32) NOT NULL DEFAULT 'personal',
  sql_text TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_by VARCHAR(64) NOT NULL DEFAULT 'system',
  updated_by VARCHAR(64) NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cloudtrail_sql_query_history (
  id BIGSERIAL PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL UNIQUE,
  template_id BIGINT REFERENCES cloudtrail_sql_templates(id) ON DELETE SET NULL,
  athena_execution_id VARCHAR(128),
  query_name VARCHAR(128),
  query_source VARCHAR(32) NOT NULL DEFAULT 'raw_sql',
  sql_text TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  result_columns_json JSONB,
  execution_statistics_json JSONB,
  error_message TEXT,
  created_by VARCHAR(64) NOT NULL DEFAULT 'system',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO cloudtrail_sql_templates (
  template_code,
  name,
  description,
  category,
  template_type,
  sql_text,
  created_by,
  updated_by
)
VALUES (
  'cloudtrail_base_query',
  'CloudTrail 基础查询',
  '默认 CloudTrail 查询模板，可直接修改 SQL 执行。',
  'cloudtrail',
  'system',
  'SELECT\n  eventtime,\n  account,\n  region,\n  eventsource,\n  eventname,\n  useridentity.arn AS user_arn,\n  sourceipaddress,\n  requestparameters\nFROM soc_logs.cloudtrail_logs\nWHERE account = ''809893975949''\n  AND region = ''ap-southeast-1''\n  AND year = ''2026''\n  AND month = ''05''\n  AND day = ''18''\n  AND eventsource = ''ec2.amazonaws.com''\n  AND eventname = ''CreateSecurityGroup''\nORDER BY eventtime DESC\nLIMIT 50',
  'system',
  'system'
)
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO cloudtrail_sql_templates (
  template_code,
  name,
  description,
  category,
  template_type,
  sql_text,
  created_by,
  updated_by
)
VALUES
(
  'ec2_instance_lifecycle',
  'EC2 实例生命周期',
  '查询 EC2 实例创建、启动、停止、终止等事件',
  'ec2',
  'system',
  'SELECT\n  eventtime,\n  account,\n  region,\n  eventsource,\n  eventname,\n  useridentity.arn AS user_arn,\n  sourceipaddress,\n  responseelements\nFROM soc_logs.cloudtrail_logs\nWHERE account = ''809893975949''\n  AND region = ''ap-southeast-1''\n  AND year = ''2026''\n  AND month = ''05''\n  AND day = ''18''\n  AND eventsource = ''ec2.amazonaws.com''\n  AND eventname IN (''RunInstances'', ''StartInstances'', ''StopInstances'', ''RebootInstances'', ''TerminateInstances'')\nORDER BY eventtime DESC\nLIMIT 100',
  'system',
  'system'
)
ON CONFLICT (template_code) DO NOTHING;

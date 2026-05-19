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
  $$SELECT
  eventtime AS "事件时间",
  account AS "账号",
  region AS "区域",
  eventsource AS "事件来源",
  eventname AS "事件名称",
  useridentity.arn AS "操作主体ARN",
  sourceipaddress AS "源IP",
  requestparameters AS "请求参数"
FROM soc_logs.cloudtrail_logs
WHERE account = '809893975949'
  AND region = 'ap-southeast-1'
  AND year = '2026'
  AND month = '05'
  AND day = '18'
  AND eventsource = 'ec2.amazonaws.com'
  AND eventname = 'CreateSecurityGroup'
ORDER BY eventtime DESC
LIMIT 50$$,
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
  $$SELECT
  eventtime AS "事件时间",
  account AS "账号",
  region AS "区域",
  eventsource AS "事件来源",
  eventname AS "事件名称",
  useridentity.arn AS "操作主体ARN",
  sourceipaddress AS "源IP",
  responseelements AS "响应结果"
FROM soc_logs.cloudtrail_logs
WHERE account = '809893975949'
  AND region = 'ap-southeast-1'
  AND year = '2026'
  AND month = '05'
  AND day = '18'
  AND eventsource = 'ec2.amazonaws.com'
  AND eventname IN ('RunInstances', 'StartInstances', 'StopInstances', 'RebootInstances', 'TerminateInstances')
ORDER BY eventtime DESC
LIMIT 100$$,
  'system',
  'system'
),
(
  'ec2_instance_id_activity',
  'EC2 指定实例 ID 事件查询',
  '按指定 EC2 实例 ID 排查相关 CloudTrail 事件，请把示例实例 ID 替换成目标实例。',
  'cloudtrail',
  'system',
  $$SELECT
  eventtime AS "事件时间",
  account AS "账号",
  region AS "区域",
  eventsource AS "事件来源",
  eventname AS "事件名称",
  useridentity.arn AS "操作主体ARN",
  sourceipaddress AS "源IP",
  json_extract_scalar(responseelements, '$.instancesSet.items[0].instanceId') AS "实例ID",
  requestparameters AS "请求参数",
  responseelements AS "响应结果"
FROM soc_logs.cloudtrail_logs
WHERE account = '809893975949'
  AND eventsource = 'ec2.amazonaws.com'
  AND year = '2026'
  AND month = '05'
  AND day = '18'
  AND (
    CAST(requestparameters AS VARCHAR) LIKE '%i-0123456789abcdef0%'
    OR CAST(responseelements AS VARCHAR) LIKE '%i-0123456789abcdef0%'
  )
ORDER BY eventtime DESC
LIMIT 100$$,
  'system',
  'system'
)
ON CONFLICT (template_code) DO NOTHING;

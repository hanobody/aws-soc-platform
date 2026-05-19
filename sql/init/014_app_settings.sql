CREATE TABLE IF NOT EXISTS app_settings (
  id BIGSERIAL PRIMARY KEY,
  setting_key VARCHAR(120) NOT NULL UNIQUE,
  setting_value TEXT,
  value_type VARCHAR(20) NOT NULL DEFAULT 'string',
  category VARCHAR(50) NOT NULL DEFAULT 'general',
  label VARCHAR(120) NOT NULL,
  description TEXT,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (setting_key, setting_value, value_type, category, label, description, is_public)
VALUES
  ('cloudtrail.historyRetentionLimit', '10', 'number', 'general', '最近查询历史保留次数', '查询中心最近执行历史最多保留多少条记录。', FALSE),
  ('athena.database', 'soc_logs', 'string', 'general', 'Athena 数据库', '查询中心默认使用的 Athena Database。', FALSE),
  ('athena.workgroup', '', 'string', 'general', 'Athena Workgroup', '可选，留空则使用默认 workgroup。', FALSE),
  ('athena.outputLocation', 's3://central-cloudtrail-igcock/socresults/', 'string', 'general', 'Athena 结果输出路径', '例如 s3://bucket/prefix/，Athena 查询结果会输出到这里。', FALSE),
  ('auth.keycloak.enabled', 'false', 'boolean', 'auth', '启用 Keycloak', '控制 Web 登录是否使用 Keycloak SSO。', TRUE),
  ('auth.keycloak.url', '', 'string', 'auth', 'Keycloak 地址', '例如 https://keycloak.example.com', TRUE),
  ('auth.keycloak.realm', '', 'string', 'auth', 'Keycloak Realm', '例如 master / soc', TRUE),
  ('auth.keycloak.clientId', '', 'string', 'auth', 'Keycloak Client ID', '前端登录使用的客户端 ID。', TRUE),
  ('ingest.sourceMode', 'sqs', 'string', 'ingest', '采集来源模式', '支持 sqs / s3，默认 sqs。', FALSE),
  ('ingest.sqs.queueUrl', 'https://sqs.ap-southeast-1.amazonaws.com/809893975949/soc-cloudtrail-events', 'string', 'ingest', 'SQS 队列地址', 'SQS 采集模式下读取的队列 URL。', FALSE),
  ('ingest.sqs.maxMessages', '10', 'number', 'ingest', 'SQS 单次拉取条数', '每次从 SQS 最多读取多少条消息。', FALSE),
  ('ingest.sqs.waitSeconds', '20', 'number', 'ingest', 'SQS Long Poll 秒数', 'SQS long polling 等待时长，单位秒。', FALSE),
  ('ingest.sqs.visibilityTimeout', '120', 'number', 'ingest', 'SQS 可见性超时', '消息处理中的隐藏时间，单位秒。', FALSE),
  ('ingest.s3.pollIntervalMinutes', '5', 'number', 'ingest', 'S3 Worker 执行频率', 'S3 / Athena 增量采集 worker 的运行频率，单位分钟。', FALSE),
  ('ingest.s3.targets', '[]', 'json', 'ingest', '账号与区域范围', 'S3 / Athena 增量采集模式下，按账号配置区域范围，例如 [{"accountId":"123","regions":["ap-southeast-1","us-east-1"]}]。', FALSE)
ON CONFLICT (setting_key) DO NOTHING;

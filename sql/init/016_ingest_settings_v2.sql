DELETE FROM app_settings
WHERE setting_key IN (
  'ingest.sourceMode',
  'ingest.sqs.queueUrl',
  'ingest.sqs.maxMessages',
  'ingest.sqs.waitSeconds',
  'ingest.sqs.visibilityTimeout',
  'ingest.s3.pollIntervalMinutes',
  'ingest.s3.targets',
  'ingest.s3.bucket',
  'ingest.s3.prefix',
  'ingest.s3.region',
  'ingest.s3.accountIds',
  'ingest.iam.captureAll',
  'ingest.sts.events',
  'ingest.ec2.instanceEvents',
  'ingest.ec2.securityGroupEvents'
);

INSERT INTO app_settings (setting_key, setting_value, value_type, category, label, description, is_public)
VALUES
  ('ingest.enabled', 'true', 'boolean', 'ingest', '采集开关', '', FALSE),
  ('ingest.queueUrl', 'https://sqs.ap-southeast-1.amazonaws.com/809893975949/cloudtrail-object-created-queue', 'string', 'ingest', 'SQS 队列地址', 'S3 ObjectCreated 事件通知投递到的 SQS 队列 URL。', FALSE),
  ('ingest.maxMessages', '10', 'number', 'ingest', 'SQS 单次拉取条数', '每次从 SQS 最多读取多少条消息。', FALSE),
  ('ingest.waitSeconds', '20', 'number', 'ingest', 'SQS Long Poll 秒数', 'SQS long polling 等待时长，单位秒。', FALSE),
  ('ingest.visibilityTimeout', '300', 'number', 'ingest', 'SQS 可见性超时', '消息处理中的隐藏时间，单位秒。', FALSE),
  ('ingest.targets', '[]', 'json', 'ingest', '采集目标 AWS 账号 / 区域', '', FALSE),
  ('ingest.eventRules', '[{"eventSource":"iam.amazonaws.com","eventNames":["*"]},{"eventSource":"sts.amazonaws.com","eventNames":["AssumeRole","AssumeRoleWithSAML","AssumeRoleWithWebIdentity"]},{"eventSource":"ec2.amazonaws.com","eventNames":["RunInstances","StartInstances","StopInstances","RebootInstances","TerminateInstances","ModifyInstanceAttribute","MonitorInstances","UnmonitorInstances","CreateSecurityGroup","DeleteSecurityGroup","AuthorizeSecurityGroupIngress","RevokeSecurityGroupIngress","AuthorizeSecurityGroupEgress","RevokeSecurityGroupEgress","ModifySecurityGroupRules","UpdateSecurityGroupRuleDescriptionsIngress","UpdateSecurityGroupRuleDescriptionsEgress"]}]', 'json', 'ingest', '采集规则', '支持任意 eventSource / eventNames JSON 数组，例如 [{"eventSource":"ec2.amazonaws.com","eventNames":["RunInstances","StopInstances"]}]。', FALSE)
ON CONFLICT (setting_key) DO NOTHING;

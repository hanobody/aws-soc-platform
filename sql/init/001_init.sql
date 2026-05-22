CREATE TABLE IF NOT EXISTS notification_channels (
  id BIGSERIAL PRIMARY KEY,
  channel_name VARCHAR(100) NOT NULL,
  channel_type VARCHAR(50) NOT NULL,
  bot_token TEXT,
  chat_id VARCHAR(255),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aws_accounts (
  id BIGSERIAL PRIMARY KEY,
  account_id VARCHAR(32) NOT NULL UNIQUE,
  account_name VARCHAR(120),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aws_regions (
  id BIGSERIAL PRIMARY KEY,
  region_code VARCHAR(32) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  region_group VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_notification_routes (
  id BIGSERIAL PRIMARY KEY,
  account_id VARCHAR(32) NOT NULL,
  project_name VARCHAR(120),
  environment VARCHAR(50),
  channel_id BIGINT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, channel_id)
);

CREATE TABLE IF NOT EXISTS resource_types (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  aws_service VARCHAR(80) NOT NULL,
  event_source VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_types (
  id BIGSERIAL PRIMARY KEY,
  resource_type_code VARCHAR(80) NOT NULL REFERENCES resource_types(code) ON DELETE RESTRICT,
  event_source VARCHAR(255) NOT NULL,
  event_name VARCHAR(255) NOT NULL,
  display_name VARCHAR(150) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(event_source, event_name)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_name VARCHAR(150),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  account_id VARCHAR(32) NOT NULL,
  region_code VARCHAR(32),
  event_source VARCHAR(255) NOT NULL,
  event_name VARCHAR(255) NOT NULL,
  resource_type VARCHAR(100),
  resource_pattern TEXT,
  user_arn_pattern TEXT,
  source_ip_pattern TEXT,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_seconds INTEGER NOT NULL DEFAULT 0,
  notification_route_id BIGINT NOT NULL REFERENCES account_notification_routes(id) ON DELETE RESTRICT,
  description TEXT,
  created_by VARCHAR(120),
  updated_by VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_lookup
  ON alert_rules(account_id, event_source, event_name, enabled);

CREATE TABLE IF NOT EXISTS alert_events (
  id BIGSERIAL PRIMARY KEY,
  event_id VARCHAR(128),
  account_id VARCHAR(32) NOT NULL,
  region_code VARCHAR(32),
  event_source VARCHAR(255),
  event_name VARCHAR(255) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  event_time TIMESTAMPTZ NOT NULL,
  resource_type VARCHAR(128),
  resource_id VARCHAR(255),
  resource_name VARCHAR(255),
  user_arn TEXT,
  source_ip VARCHAR(64),
  raw_event_json JSONB NOT NULL,
  alert_status VARCHAR(50) NOT NULL DEFAULT 'new',
  matched_rule_id BIGINT REFERENCES alert_rules(id) ON DELETE SET NULL,
  notification_route_id BIGINT REFERENCES account_notification_routes(id) ON DELETE SET NULL,
  notification_channel_id BIGINT REFERENCES notification_channels(id) ON DELETE SET NULL,
  notification_error TEXT,
  notified_at TIMESTAMPTZ,
  matched_rule_name_snapshot VARCHAR(150),
  matched_rule_snapshot_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_account_time
  ON alert_events(account_id, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_event_name
  ON alert_events(event_name);

CREATE INDEX IF NOT EXISTS idx_alert_events_rule_time
  ON alert_events(matched_rule_id, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_event_source
  ON alert_events(event_source, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_notification_status
  ON alert_events(alert_status, event_time DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_event_id_unique
  ON alert_events(event_id);

INSERT INTO notification_channels (channel_name, channel_type, enabled)
VALUES ('default-telegram', 'telegram', TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO account_notification_routes (account_id, project_name, environment, channel_id, enabled)
SELECT '*', 'default', 'default', nc.id, TRUE
FROM notification_channels nc
WHERE nc.channel_name = 'default-telegram'
ON CONFLICT (account_id, channel_id) DO NOTHING;

INSERT INTO aws_accounts (account_id, account_name, note)
VALUES
  ('577364091059', 'AWS Account 577364091059', '导入账号'),
  ('446383248756', 'AWS Account 446383248756', '导入账号'),
  ('135808916487', 'AWS Account 135808916487', '导入账号'),
  ('156041432019', 'AWS Account 156041432019', '导入账号'),
  ('247890563706', 'AWS Account 247890563706', '导入账号'),
  ('839169402617', 'AWS Account 839169402617', '导入账号'),
  ('742372923113', 'AWS Account 742372923113', '导入账号'),
  ('951656659734', 'AWS Account 951656659734', '导入账号'),
  ('076991469592', 'AWS Account 076991469592', '导入账号'),
  ('400928259799', 'AWS Account 400928259799', '导入账号'),
  ('201805606249', 'AWS Account 201805606249', '导入账号'),
  ('746669223461', 'AWS Account 746669223461', '导入账号'),
  ('828289321688', 'AWS Account 828289321688', '导入账号'),
  ('919664458431', 'AWS Account 919664458431', '导入账号'),
  ('837256265149', 'AWS Account 837256265149', '导入账号'),
  ('211326840893', 'AWS Account 211326840893', '导入账号'),
  ('809893975949', 'Security Account', '安全主账号 / central security account'),
  ('178502901686', 'AWS Account 178502901686', '导入账号'),
  ('582998837184', 'AWS Account 582998837184', '导入账号'),
  ('516199268720', 'Member Account', '成员账号 / sample member account')
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO aws_regions (region_code, display_name, region_group)
VALUES
  ('af-south-1', 'Africa (Cape Town)', 'Africa'),
  ('ap-east-1', 'Asia Pacific (Hong Kong)', 'Asia Pacific'),
  ('ap-east-2', 'Asia Pacific (Taipei)', 'Asia Pacific'),
  ('ap-northeast-1', 'Asia Pacific (Tokyo)', 'Asia Pacific'),
  ('ap-northeast-2', 'Asia Pacific (Seoul)', 'Asia Pacific'),
  ('ap-northeast-3', 'Asia Pacific (Osaka)', 'Asia Pacific'),
  ('ap-south-1', 'Asia Pacific (Mumbai)', 'Asia Pacific'),
  ('ap-south-2', 'Asia Pacific (Hyderabad)', 'Asia Pacific'),
  ('ap-southeast-1', 'Asia Pacific (Singapore)', 'Asia Pacific'),
  ('ap-southeast-2', 'Asia Pacific (Sydney)', 'Asia Pacific'),
  ('ap-southeast-3', 'Asia Pacific (Jakarta)', 'Asia Pacific'),
  ('ap-southeast-4', 'Asia Pacific (Melbourne)', 'Asia Pacific'),
  ('ap-southeast-5', 'Asia Pacific (Malaysia)', 'Asia Pacific'),
  ('ap-southeast-6', 'Asia Pacific (New Zealand)', 'Asia Pacific'),
  ('ap-southeast-7', 'Asia Pacific (Thailand)', 'Asia Pacific'),
  ('ca-central-1', 'Canada (Central)', 'Canada'),
  ('ca-west-1', 'Canada (Calgary)', 'Canada'),
  ('eu-central-1', 'Europe (Frankfurt)', 'Europe'),
  ('eu-central-2', 'Europe (Zurich)', 'Europe'),
  ('eu-north-1', 'Europe (Stockholm)', 'Europe'),
  ('eu-south-1', 'Europe (Milan)', 'Europe'),
  ('eu-south-2', 'Europe (Spain)', 'Europe'),
  ('eu-west-1', 'Europe (Ireland)', 'Europe'),
  ('eu-west-2', 'Europe (London)', 'Europe'),
  ('eu-west-3', 'Europe (Paris)', 'Europe'),
  ('il-central-1', 'Israel (Tel Aviv)', 'Israel'),
  ('me-central-1', 'Middle East (UAE)', 'Middle East'),
  ('me-south-1', 'Middle East (Bahrain)', 'Middle East'),
  ('mx-central-1', 'Mexico (Central)', 'Mexico'),
  ('sa-east-1', 'South America (São Paulo)', 'South America'),
  ('us-east-1', 'United States (N. Virginia)', 'United States'),
  ('us-east-2', 'United States (Ohio)', 'United States'),
  ('us-west-1', 'United States (N. California)', 'United States'),
  ('us-west-2', 'United States (Oregon)', 'United States')
ON CONFLICT (region_code) DO NOTHING;

INSERT INTO resource_types (code, display_name, aws_service, event_source, description)
VALUES
  ('ec2-instance', 'EC2 实例', 'EC2', 'ec2.amazonaws.com', 'EC2 instance lifecycle and configuration resources'),
  ('security-group', '安全组', 'EC2', 'ec2.amazonaws.com', 'Security Group rule and membership changes'),
  ('iam-entity', 'IAM 对象', 'IAM', 'iam.amazonaws.com', 'Generic IAM entities when the specific subtype is not identified'),
  ('iam-user', 'IAM 用户', 'IAM', 'iam.amazonaws.com', 'IAM user changes'),
  ('iam-role', 'IAM 角色', 'IAM', 'iam.amazonaws.com', 'IAM role and permission changes'),
  ('iam-group', 'IAM 用户组', 'IAM', 'iam.amazonaws.com', 'IAM group changes'),
  ('iam-policy', 'IAM 策略', 'IAM', 'iam.amazonaws.com', 'IAM managed or inline policy changes'),
  ('iam-instance-profile', 'IAM Instance Profile', 'IAM', 'iam.amazonaws.com', 'IAM instance profile changes'),
  ('iam-access-key', 'IAM Access Key', 'IAM', 'iam.amazonaws.com', 'IAM access key lifecycle changes')
ON CONFLICT (code) DO NOTHING;

INSERT INTO event_types (resource_type_code, event_source, event_name, display_name, severity, description)
VALUES
  ('iam-access-key', 'iam.amazonaws.com', 'CreateAccessKey', '创建 IAM Access Key', 'high', 'IAM access key created'),
  ('ec2-instance', 'ec2.amazonaws.com', 'RunInstances', '创建 EC2 实例', 'high', 'EC2 instance created'),
  ('ec2-instance', 'ec2.amazonaws.com', 'StartInstances', '启动 EC2 实例', 'medium', 'EC2 instance started'),
  ('ec2-instance', 'ec2.amazonaws.com', 'StopInstances', '停止 EC2 实例', 'medium', 'EC2 instance stopped'),
  ('ec2-instance', 'ec2.amazonaws.com', 'RebootInstances', '重启 EC2 实例', 'medium', 'EC2 instance rebooted'),
  ('ec2-instance', 'ec2.amazonaws.com', 'TerminateInstances', '删除 EC2 实例', 'high', 'EC2 instance terminated'),
  ('ec2-instance', 'ec2.amazonaws.com', 'ModifyInstanceAttribute', '修改 EC2 实例属性', 'high', 'EC2 instance attribute changed'),
  ('security-group', 'ec2.amazonaws.com', 'CreateSecurityGroup', '创建安全组', 'medium', 'Security group created'),
  ('security-group', 'ec2.amazonaws.com', 'DeleteSecurityGroup', '删除安全组', 'high', 'Security group deleted'),
  ('security-group', 'ec2.amazonaws.com', 'AuthorizeSecurityGroupIngress', '开放安全组入站规则', 'high', 'Security group ingress allowed'),
  ('security-group', 'ec2.amazonaws.com', 'RevokeSecurityGroupIngress', '撤销安全组入站规则', 'medium', 'Security group ingress revoked'),
  ('security-group', 'ec2.amazonaws.com', 'AuthorizeSecurityGroupEgress', '开放安全组出站规则', 'high', 'Security group egress allowed'),
  ('security-group', 'ec2.amazonaws.com', 'RevokeSecurityGroupEgress', '撤销安全组出站规则', 'medium', 'Security group egress revoked'),
  ('security-group', 'ec2.amazonaws.com', 'ModifySecurityGroupRules', '修改安全组规则', 'high', 'Security group rules changed'),
  ('security-group', 'ec2.amazonaws.com', 'UpdateSecurityGroupRuleDescriptionsIngress', '更新安全组入站规则描述', 'medium', 'Security group ingress rule description updated'),
  ('security-group', 'ec2.amazonaws.com', 'UpdateSecurityGroupRuleDescriptionsEgress', '更新安全组出站规则描述', 'medium', 'Security group egress rule description updated'),
  ('iam-role', 'sts.amazonaws.com', 'AssumeRole', '切换 IAM 角色', 'medium', 'STS AssumeRole executed')
ON CONFLICT (event_source, event_name) DO NOTHING;

INSERT INTO alert_rules (
  rule_name, is_default, account_id, region_code, event_source, event_name, resource_type, severity, enabled, cooldown_seconds, description
)
SELECT
  CONCAT('默认规则 - ', et.display_name),
  TRUE,
  '*',
  '*',
  et.event_source,
  et.event_name,
  et.resource_type_code,
  et.severity,
  TRUE,
  0,
  CONCAT('由事件类型初始化生成: ', et.display_name)
FROM event_types et
WHERE (et.event_source, et.event_name) IN (
  ('iam.amazonaws.com', 'CreateAccessKey'),
  ('sts.amazonaws.com', 'AssumeRole'),
  ('ec2.amazonaws.com', 'RunInstances'),
  ('ec2.amazonaws.com', 'StartInstances'),
  ('ec2.amazonaws.com', 'StopInstances'),
  ('ec2.amazonaws.com', 'RebootInstances'),
  ('ec2.amazonaws.com', 'TerminateInstances'),
  ('ec2.amazonaws.com', 'ModifyInstanceAttribute'),
  ('ec2.amazonaws.com', 'CreateSecurityGroup'),
  ('ec2.amazonaws.com', 'DeleteSecurityGroup'),
  ('ec2.amazonaws.com', 'AuthorizeSecurityGroupIngress'),
  ('ec2.amazonaws.com', 'RevokeSecurityGroupIngress'),
  ('ec2.amazonaws.com', 'AuthorizeSecurityGroupEgress'),
  ('ec2.amazonaws.com', 'RevokeSecurityGroupEgress'),
  ('ec2.amazonaws.com', 'ModifySecurityGroupRules'),
  ('ec2.amazonaws.com', 'UpdateSecurityGroupRuleDescriptionsIngress'),
  ('ec2.amazonaws.com', 'UpdateSecurityGroupRuleDescriptionsEgress')
)
AND NOT EXISTS (
  SELECT 1
  FROM alert_rules ar
  WHERE ar.account_id = '*'
    AND COALESCE(ar.region_code, '*') = '*'
    AND ar.event_source = et.event_source
    AND ar.event_name = et.event_name
);

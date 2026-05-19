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

BEGIN;

TRUNCATE TABLE alert_events RESTART IDENTITY;
TRUNCATE TABLE alert_rules RESTART IDENTITY;
TRUNCATE TABLE event_types RESTART IDENTITY;

INSERT INTO event_types (resource_type_code, event_source, event_name, display_name, severity, description)
VALUES
  ('iam-user', 'iam.amazonaws.com', 'CreateAccessKey', '创建 IAM Access Key', 'high', 'IAM access key created'),
  ('ec2-instance', 'ec2.amazonaws.com', 'RunInstances', '创建 EC2 实例', 'high', 'EC2 instance created'),
  ('ec2-instance', 'ec2.amazonaws.com', 'TerminateInstances', '删除 EC2 实例', 'high', 'EC2 instance terminated'),
  ('security-group', 'ec2.amazonaws.com', 'CreateSecurityGroup', '创建安全组', 'medium', 'Security group created'),
  ('security-group', 'ec2.amazonaws.com', 'DeleteSecurityGroup', '删除安全组', 'high', 'Security group deleted'),
  ('security-group', 'ec2.amazonaws.com', 'AuthorizeSecurityGroupIngress', '开放安全组入站规则', 'high', 'Security group ingress allowed'),
  ('security-group', 'ec2.amazonaws.com', 'RevokeSecurityGroupIngress', '撤销安全组入站规则', 'medium', 'Security group ingress revoked'),
  ('security-group', 'ec2.amazonaws.com', 'AuthorizeSecurityGroupEgress', '开放安全组出站规则', 'high', 'Security group egress allowed'),
  ('security-group', 'ec2.amazonaws.com', 'RevokeSecurityGroupEgress', '撤销安全组出站规则', 'medium', 'Security group egress revoked');

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
  CONCAT('默认通知规则: ', et.display_name)
FROM event_types et;

COMMIT;

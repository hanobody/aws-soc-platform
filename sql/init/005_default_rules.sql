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
  ('ec2.amazonaws.com', 'RunInstances'),
  ('ec2.amazonaws.com', 'TerminateInstances'),
  ('ec2.amazonaws.com', 'CreateSecurityGroup'),
  ('ec2.amazonaws.com', 'DeleteSecurityGroup'),
  ('ec2.amazonaws.com', 'AuthorizeSecurityGroupIngress'),
  ('ec2.amazonaws.com', 'RevokeSecurityGroupIngress'),
  ('ec2.amazonaws.com', 'AuthorizeSecurityGroupEgress'),
  ('ec2.amazonaws.com', 'RevokeSecurityGroupEgress')
)
AND NOT EXISTS (
  SELECT 1
  FROM alert_rules ar
  WHERE ar.account_id = '*'
    AND COALESCE(ar.region_code, '*') = '*'
    AND ar.event_source = et.event_source
    AND ar.event_name = et.event_name
);

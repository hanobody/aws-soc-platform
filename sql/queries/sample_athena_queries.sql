-- 示例：后续在 Athena 中查询 CloudTrail 原始日志
-- 这里只放占位示例，真实表名要按 Glue/Athena 建表结果调整。

-- 查询最近 100 条高风险相关事件
SELECT *
FROM cloudtrail_logs
WHERE eventname IN (
  'CreateAccessKey',
  'DeleteTrail',
  'StopLogging',
  'AuthorizeSecurityGroupIngress',
  'CreateUser',
  'AttachUserPolicy',
  'PutUserPolicy',
  'TerminateInstances',
  'StopInstances'
)
ORDER BY eventtime DESC
LIMIT 100;

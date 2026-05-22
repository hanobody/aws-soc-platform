import "dotenv/config";
import express from "express";
import cors from "cors";
import pkg from "pg";
import fs from "fs";
import https from "https";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand
} from "@aws-sdk/client-athena";

const { Pool } = pkg;

const app = express();
const port = Number(process.env.PORT || 4000);
const databaseUrl = process.env.DATABASE_URL || "postgresql://soc_admin:soc_dev_password@localhost:5433/soc_platform";
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
const awsRegion = process.env.AWS_REGION || "ap-southeast-1";
const sqsQueueUrl = process.env.SQS_QUEUE_URL || "https://sqs.ap-southeast-1.amazonaws.com/809893975949/soc-cloudtrail-events";
const s3ObjectCreatedQueueUrl = process.env.S3_OBJECT_CREATED_QUEUE_URL || "https://sqs.ap-southeast-1.amazonaws.com/809893975949/cloudtrail-object-created-queue";
const athenaDatabase = process.env.ATHENA_DATABASE || "";
const athenaWorkGroup = process.env.ATHENA_WORKGROUP || "";
const athenaOutputLocation = process.env.ATHENA_OUTPUT_LOCATION || "";

const defaultIngestEventRules = [
  { eventSource: "iam.amazonaws.com", eventNames: ["*"] },
  { eventSource: "sts.amazonaws.com", eventNames: ["AssumeRole", "AssumeRoleWithSAML", "AssumeRoleWithWebIdentity"] },
  { eventSource: "ec2.amazonaws.com", eventNames: ["RunInstances", "StartInstances", "StopInstances", "RebootInstances", "TerminateInstances", "ModifyInstanceAttribute", "MonitorInstances", "UnmonitorInstances", "CreateSecurityGroup", "DeleteSecurityGroup", "AuthorizeSecurityGroupIngress", "RevokeSecurityGroupIngress", "AuthorizeSecurityGroupEgress", "RevokeSecurityGroupEgress", "ModifySecurityGroupRules", "UpdateSecurityGroupRuleDescriptionsIngress", "UpdateSecurityGroupRuleDescriptionsEgress"] }
];

const WORKER_POD_TARGETS = [
  { workerName: "ingest-worker-s3-event", workerType: "ingest-worker-s3-event", appLabel: "aws-soc-ingest-worker-s3-event" }
];

const ACTIVE_WORKER_TYPES = new Set(WORKER_POD_TARGETS.map((item) => item.workerType));

const pool = new Pool({ connectionString: databaseUrl });
const sqsClient = new SQSClient({ region: awsRegion });
const athenaClient = new AthenaClient({ region: awsRegion });

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: "2mb" }));

const resourceMap = {
  "aws-accounts": {
    table: "aws_accounts",
    fields: ["account_id", "account_name", "note"]
  },
  "aws-regions": {
    table: "aws_regions",
    fields: ["region_code", "display_name", "region_group"]
  },
  "resource-types": {
    table: "resource_types",
    fields: ["code", "display_name", "aws_service", "event_source", "description"]
  },
  "event-types": {
    table: "event_types",
    fields: ["resource_type_code", "event_source", "event_name", "display_name", "severity", "description"]
  },
  "alert-rules": {
    table: "alert_rules",
    fields: [
      "rule_name",
      "is_default",
      "account_id",
      "region_code",
      "event_source",
      "event_name",
      "resource_type",
      "resource_pattern",
      "user_arn_pattern",
      "source_ip_pattern",
      "severity",
      "enabled",
      "cooldown_seconds",
      "notification_route_id",
      "description",
      "created_by",
      "updated_by"
    ]
  },
  "notification-channels": {
    table: "notification_channels",
    fields: ["channel_name", "channel_type", "bot_token", "chat_id", "enabled"]
  },
  "account-routes": {
    table: "account_notification_routes",
    fields: ["account_id", "project_name", "environment", "channel_id", "enabled"]
  },
  "alert-events": {
    table: "alert_events",
    fields: [
      "account_id",
      "region_code",
      "event_name",
      "severity",
      "event_time",
      "resource_id",
      "resource_name",
      "user_arn",
      "source_ip",
      "raw_event_json",
      "alert_status"
    ]
  }
};

function toLower(value) {
  return String(value || "").toLowerCase();
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchPattern(value, pattern) {
  if (!pattern) return true;
  if (value === null || value === undefined) return false;
  const normalized = String(pattern).trim();
  if (!normalized) return true;

  return normalized
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .some((item) => wildcardToRegExp(item).test(String(value)));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function extractResource(detail) {
  const request = detail.requestParameters || {};
  const response = detail.responseElements || {};
  const resource = (detail.resources && detail.resources[0]) || {};
  const eventName = detail.eventName || "";
  const networkInterface = response.networkInterface || {};
  const groupItems = request.groupSet?.items || [];
  const firstGroup = groupItems[0] || {};
  const nestedPermission = request.CreateNetworkInterfacePermissionRequest || {};

  const networkInterfaceId = firstNonEmpty(
    networkInterface.networkInterfaceId,
    response.networkInterfaceId,
    nestedPermission.NetworkInterfaceId,
    request.networkInterfaceId,
    request.NetworkInterfaceId
  );
  const subnetId = firstNonEmpty(
    request.subnetId,
    networkInterface.subnetId,
    response.subnetId
  );
  const securityGroupId = firstNonEmpty(
    request.groupId,
    firstGroup.groupId,
    response.groupId
  );

  const resourceId = firstNonEmpty(
    eventName === "CreateNetworkInterface" || eventName === "CreateNetworkInterfacePermission" ? networkInterfaceId : null,
    eventName === "CreateNetworkInterface" || eventName === "CreateNetworkInterfacePermission" ? subnetId : null,
    eventName === "CreateNetworkInterface" || eventName === "CreateNetworkInterfacePermission" ? securityGroupId : null,
    request.allocationId,
    response.allocationId,
    request.publicIp,
    response.publicIp,
    request.groupId,
    firstGroup.groupId,
    response.groupId,
    request.instanceId,
    response.instanceId,
    networkInterfaceId,
    subnetId,
    request.bucketName,
    request.roleName,
    request.userName,
    request.policyArn,
    resource.ARN,
    resource.arn
  );

  const resourceName = firstNonEmpty(
    request.groupName,
    request.bucketName,
    request.roleName,
    request.userName,
    request.policyName,
    resource.type
  );

  return { resourceId, resourceName };
}

function inferResourceType(detail, eventType) {
  if (eventType?.resource_type_code) return eventType.resource_type_code;
  const request = detail.requestParameters || {};
  const response = detail.responseElements || {};
  const eventName = detail.eventName || "";
  const networkInterface = response.networkInterface || {};
  const groupItems = request.groupSet?.items || [];
  const nestedPermission = request.CreateNetworkInterfacePermissionRequest || {};
  if (
    eventName === "CreateNetworkInterface" ||
    eventName === "CreateNetworkInterfacePermission" ||
    networkInterface.networkInterfaceId ||
    response.networkInterfaceId ||
    request.networkInterfaceId ||
    nestedPermission.NetworkInterfaceId
  ) return "network-interface";
  if (request.groupId || request.groupName || groupItems.length) return "security-group";
  if (eventName.includes("Address") || request.allocationId || request.publicIp || request.domain === "vpc") return "elastic-ip";
  if (request.instanceId) return "ec2-instance";
  if (request.bucketName) return "s3-bucket";
  if (request.roleName) return "iam-role";
  if (request.userName) return "iam-user";
  return null;
}

function matchesRule(rule, context) {
  const accountMatch = rule.account_id === context.accountId || rule.account_id === "*";
  if (!accountMatch) return false;
  if (rule.region_code && rule.region_code !== "*" && toLower(rule.region_code) !== toLower(context.regionCode)) return false;
  if (toLower(rule.event_source) !== toLower(context.eventSource)) return false;
  if (toLower(rule.event_name) !== toLower(context.eventName)) return false;
  if (rule.resource_type && context.resourceType && toLower(rule.resource_type) !== toLower(context.resourceType)) return false;
  if (!matchPattern(context.resourceId, rule.resource_pattern) && !matchPattern(context.resourceName, rule.resource_pattern)) return false;
  if (!matchPattern(context.userArn, rule.user_arn_pattern)) return false;
  if (!matchPattern(context.sourceIp, rule.source_ip_pattern)) return false;
  return true;
}

function ruleSpecificity(rule) {
  let score = 0;
  if (rule.resource_pattern) score += 4;
  if (rule.user_arn_pattern) score += 2;
  if (rule.source_ip_pattern) score += 1;
  if (rule.account_id && rule.account_id !== "*") score += 1;
  if (rule.region_code && rule.region_code !== "*") score += 1;
  return score;
}

function buildInsert(resource, payload) {
  const allowed = resource.fields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  const columns = allowed.join(", ");
  const placeholders = allowed.map((_, index) => `$${index + 1}`).join(", ");
  const values = allowed.map((field) => payload[field]);
  return { columns, placeholders, values, allowed };
}

function buildUpdate(resource, payload) {
  const allowed = resource.fields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  const setClause = allowed.map((field, index) => `${field} = $${index + 1}`).join(", ");
  const values = allowed.map((field) => payload[field]);
  return { setClause, values, allowed };
}

function sanitizeResourceRow(path, row) {
  const sanitized = { ...row };

  if (path === "account-routes") delete sanitized.environment;

  return sanitized;
}

async function getWorkerPodSummary() {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT || "443";
  if (!host) return null;

  const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  const namespacePath = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
  const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
  if (!fs.existsSync(tokenPath) || !fs.existsSync(namespacePath) || !fs.existsSync(caPath)) return null;

  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const namespace = fs.readFileSync(namespacePath, "utf8").trim() || "default";
  const ca = fs.readFileSync(caPath, "utf8");
  if (!token) return null;

  const summary = new Map();
  for (const target of WORKER_POD_TARGETS) {
    const url = `https://${host}:${port}/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`app=${target.appLabel}`)}`;
    const payload = await getJSON(url, {
      headers: { Authorization: `Bearer ${token}` },
      ca
    });
    const items = Array.isArray(payload.items) ? payload.items : [];
    const desiredPods = items.length;
    const readyPods = items.filter((pod) => (pod.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True")).length;
    summary.set(target.appLabel, {
      desiredPods,
      readyPods,
      podNames: items.map((pod) => pod.metadata?.name).filter(Boolean)
    });
  }
  return summary;
}

function getJSON(url, { headers = {}, ca } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "GET",
      headers,
      ca
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          reject(new Error(`k8s api ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body || "{}"));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function ensureRuleConfigStateTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rule_config_state (
      scope VARCHAR(80) PRIMARY KEY,
      version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO rule_config_state (scope, version)
    VALUES ('alert_rules', 1)
    ON CONFLICT (scope) DO NOTHING
  `);
}

async function ensureAlertRulesMetadata() {
  await pool.query(`
    ALTER TABLE alert_rules
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await pool.query(`
    UPDATE alert_rules
    SET is_default = TRUE
    WHERE COALESCE(is_default, FALSE) = FALSE
      AND rule_name ILIKE '默认规则 - %'
  `);
  await pool.query(`
    ALTER TABLE alert_rules
    DROP COLUMN IF EXISTS rule_mode
  `);
}

async function ensureCloudtrailSqlTables() {
  await pool.query(`
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
    )
  `);

  await pool.query(`
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
    )
  `);

  await pool.query(`
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
    ),
    (
      'ec2_run_instances_recent',
      'EC2 实例创建 / 启动排查',
      '排查最近 RunInstances、StartInstances、StopInstances、TerminateInstances 操作。',
      'cloudtrail',
      'system',
      $$SELECT
  eventtime AS "事件时间",
  account AS "账号",
  region AS "区域",
  eventname AS "事件名称",
  useridentity.arn AS "操作主体ARN",
  sourceipaddress AS "源IP",
  json_extract_scalar(responseelements, '$.instancesSet.items[0].instanceId') AS "实例ID",
  requestparameters AS "请求参数"
FROM soc_logs.cloudtrail_logs
WHERE account = '809893975949'
  AND eventsource = 'ec2.amazonaws.com'
  AND eventname IN ('RunInstances', 'StartInstances', 'StopInstances', 'TerminateInstances')
  AND year = '2026'
  AND month = '05'
  AND day = '18'
ORDER BY eventtime DESC
LIMIT 100$$,
      'system',
      'system'
    ),
    (
      'iam_user_role_policy_changes',
      'IAM 用户 / 角色 / 策略变更',
      '排查 IAM 用户、角色、策略、策略绑定等敏感变更。',
      'cloudtrail',
      'system',
      $$SELECT
  eventtime AS "事件时间",
  account AS "账号",
  region AS "区域",
  eventname AS "事件名称",
  useridentity.arn AS "操作主体ARN",
  sourceipaddress AS "源IP",
  requestparameters AS "请求参数"
FROM soc_logs.cloudtrail_logs
WHERE account = '809893975949'
  AND eventsource = 'iam.amazonaws.com'
  AND eventname IN (
    'CreateUser', 'DeleteUser', 'CreateRole', 'DeleteRole',
    'AttachUserPolicy', 'DetachUserPolicy', 'AttachRolePolicy', 'DetachRolePolicy',
    'PutUserPolicy', 'PutRolePolicy', 'DeleteUserPolicy', 'DeleteRolePolicy',
    'CreatePolicy', 'CreatePolicyVersion', 'SetDefaultPolicyVersion', 'DeletePolicyVersion',
    'UpdateAssumeRolePolicy'
  )
  AND year = '2026'
  AND month = '05'
  AND day = '18'
ORDER BY eventtime DESC
LIMIT 100$$,
      'system',
      'system'
    ),
    (
      'iam_console_login_failures',
      'IAM 控制台登录失败 / Root 登录',
      '查看 ConsoleLogin 失败和 Root 用户登录行为。',
      'cloudtrail',
      'system',
      $$SELECT
  eventtime AS "事件时间",
  account AS "账号",
  region AS "区域",
  eventname AS "事件名称",
  useridentity.type AS "用户类型",
  useridentity.arn AS "操作主体ARN",
  sourceipaddress AS "源IP",
  errorcode AS "错误代码",
  errormessage AS "错误信息",
  additionaleventdata AS "附加事件数据"
FROM soc_logs.cloudtrail_logs
WHERE account = '809893975949'
  AND eventsource = 'signin.amazonaws.com'
  AND eventname = 'ConsoleLogin'
  AND (
    errorcode IS NOT NULL
    OR useridentity.type = 'Root'
    OR CAST(responseelements AS VARCHAR) LIKE '%Failure%'
  )
  AND year = '2026'
  AND month = '05'
  AND day = '18'
ORDER BY eventtime DESC
LIMIT 100$$,
      'system',
      'system'
    ),
    (
      'iam_access_key_changes',
      'IAM Access Key 变更',
      '排查访问密钥创建、更新、删除等敏感行为。',
      'cloudtrail',
      'system',
      $$SELECT
  eventtime AS "事件时间",
  account AS "账号",
  region AS "区域",
  eventname AS "事件名称",
  useridentity.arn AS "操作主体ARN",
  sourceipaddress AS "源IP",
  requestparameters AS "请求参数",
  responseelements AS "响应结果"
FROM soc_logs.cloudtrail_logs
WHERE account = '809893975949'
  AND eventsource = 'iam.amazonaws.com'
  AND eventname IN ('CreateAccessKey', 'UpdateAccessKey', 'DeleteAccessKey')
  AND year = '2026'
  AND month = '05'
  AND day = '18'
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
    ON CONFLICT (template_code) DO NOTHING
  `);
}

async function ensureAppSettingsTable() {
  await pool.query(`
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
    )
  `);

  const seeds = [
    {
      key: 'cloudtrail.historyRetentionLimit',
      value: '10',
      valueType: 'number',
      category: 'general',
      label: '最近查询历史保留次数',
      description: '查询中心最近执行历史最多保留多少条记录。',
      isPublic: false
    },
    {
      key: 'athena.database',
      value: athenaDatabase || 'soc_logs',
      valueType: 'string',
      category: 'general',
      label: 'Athena 数据库',
      description: '查询中心默认使用的 Athena Database。',
      isPublic: false
    },
    {
      key: 'athena.workgroup',
      value: athenaWorkGroup || '',
      valueType: 'string',
      category: 'general',
      label: 'Athena Workgroup',
      description: '可选，留空则使用默认 workgroup。',
      isPublic: false
    },
    {
      key: 'athena.outputLocation',
      value: athenaOutputLocation || 's3://central-cloudtrail-igcock/socresults/',
      valueType: 'string',
      category: 'general',
      label: 'Athena 结果输出路径',
      description: '例如 s3://bucket/prefix/，Athena 查询结果会输出到这里。',
      isPublic: false
    },
    {
      key: 'auth.keycloak.enabled',
      value: 'false',
      valueType: 'boolean',
      category: 'auth',
      label: '启用 Keycloak',
      description: '控制 Web 登录是否使用 Keycloak SSO。',
      isPublic: true
    },
    {
      key: 'auth.keycloak.url',
      value: '',
      valueType: 'string',
      category: 'auth',
      label: 'Keycloak 地址',
      description: '例如 https://keycloak.example.com',
      isPublic: true
    },
    {
      key: 'auth.keycloak.realm',
      value: '',
      valueType: 'string',
      category: 'auth',
      label: 'Keycloak Realm',
      description: '例如 master / soc',
      isPublic: true
    },
    {
      key: 'auth.keycloak.clientId',
      value: '',
      valueType: 'string',
      category: 'auth',
      label: 'Keycloak Client ID',
      description: '前端登录使用的客户端 ID。',
      isPublic: true
    },
    {
      key: 'ingest.enabled',
      value: 'true',
      valueType: 'boolean',
      category: 'ingest',
      label: '采集开关',
      description: '',
      isPublic: false
    },
    {
      key: 'ingest.queueUrl',
      value: s3ObjectCreatedQueueUrl,
      valueType: 'string',
      category: 'ingest',
      label: 'SQS 队列地址',
      description: 'S3 ObjectCreated 事件通知投递到的 SQS 队列 URL。',
      isPublic: false
    },
    {
      key: 'ingest.maxMessages',
      value: String(process.env.S3_EVENT_SQS_MAX_MESSAGES || '10'),
      valueType: 'number',
      category: 'ingest',
      label: 'SQS 单次拉取条数',
      description: '每次从 SQS 最多读取多少条消息。',
      isPublic: false
    },
    {
      key: 'ingest.waitSeconds',
      value: String(process.env.S3_EVENT_SQS_WAIT_SECONDS || '20'),
      valueType: 'number',
      category: 'ingest',
      label: 'SQS Long Poll 秒数',
      description: 'SQS long polling 等待时长，单位秒。',
      isPublic: false
    },
    {
      key: 'ingest.visibilityTimeout',
      value: String(process.env.S3_EVENT_SQS_VISIBILITY_TIMEOUT || '300'),
      valueType: 'number',
      category: 'ingest',
      label: 'SQS 可见性超时',
      description: '消息处理中的隐藏时间，单位秒。',
      isPublic: false
    },
    {
      key: 'ingest.targets',
      value: '[]',
      valueType: 'json',
      category: 'ingest',
      label: '采集目标 AWS 账号 / 区域',
      description: '',
      isPublic: false
    },
    {
      key: 'ingest.eventRules',
      value: JSON.stringify(defaultIngestEventRules),
      valueType: 'json',
      category: 'ingest',
      label: '采集规则',
      description: '支持任意 eventSource / eventNames JSON 数组，例如 [{"eventSource":"ec2.amazonaws.com","eventNames":["RunInstances","StopInstances"]}]。',
      isPublic: false
    }
  ];

  const obsoleteKeys = [
    'ingest.sourceMode',
    'ingest.sqs.queueUrl',
    'ingest.sqs.maxMessages',
    'ingest.sqs.waitSeconds',
    'ingest.sqs.visibilityTimeout',
    'ingest.s3.pollIntervalMinutes',
    'ingest.s3.targets',
    'ingest.s3.bucket',
    'ingest.s3.bucketUri',
    'ingest.s3.prefix',
    'ingest.s3.region',
    'ingest.s3.accountIds',
    'ingest.iam.captureAll',
    'ingest.sts.events',
    'ingest.ec2.instanceEvents',
    'ingest.ec2.securityGroupEvents'
  ];

  await pool.query(`DELETE FROM app_settings WHERE setting_key = ANY($1::text[])`, [obsoleteKeys]);

  for (const seed of seeds) {
    await pool.query(
      `INSERT INTO app_settings (setting_key, setting_value, value_type, category, label, description, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (setting_key) DO UPDATE SET
         value_type = EXCLUDED.value_type,
         category = EXCLUDED.category,
         label = EXCLUDED.label,
         description = EXCLUDED.description,
         is_public = EXCLUDED.is_public`,
      [seed.key, seed.value, seed.valueType, seed.category, seed.label, seed.description, seed.isPublic]
    );
  }
}

async function getAthenaRuntimeConfig() {
  const [database, workgroup, outputLocation] = await Promise.all([
    getAppSettingValue('athena.database', athenaDatabase || null),
    getAppSettingValue('athena.workgroup', athenaWorkGroup || null),
    getAppSettingValue('athena.outputLocation', athenaOutputLocation || null)
  ]);

  return {
    database: database || null,
    workgroup: workgroup || null,
    outputLocation: outputLocation || null
  };
}

async function getSqsRuntimeConfig() {
  const queueUrl = await getAppSettingValue('ingest.queueUrl', s3ObjectCreatedQueueUrl);
  return {
    queueUrl: queueUrl || s3ObjectCreatedQueueUrl
  };
}

function parseSettingValue(row) {
  const raw = row.setting_value;
  if (row.value_type === 'boolean') return String(raw).toLowerCase() === 'true';
  if (row.value_type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (row.value_type === 'json') {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  return raw ?? '';
}

async function getAppSettingsRows({ isPublic } = {}) {
  const clauses = [];
  const values = [];
  if (typeof isPublic === 'boolean') {
    values.push(isPublic);
    clauses.push(`is_public = $${values.length}`);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT *
     FROM app_settings
     ${whereSql}
     ORDER BY category, id`,
    values
  );
  return result.rows.map((row) => ({ ...row, parsed_value: parseSettingValue(row) }));
}

async function getAppSettingValue(key, fallback = null) {
  const result = await pool.query(
    `SELECT * FROM app_settings WHERE setting_key = $1`,
    [key]
  );
  if (!result.rows.length) return fallback;
  const parsed = parseSettingValue(result.rows[0]);
  return parsed ?? fallback;
}

async function enforceCloudtrailHistoryRetention() {
  const configured = await getAppSettingValue('cloudtrail.historyRetentionLimit', 10);
  const limit = Math.max(1, Math.min(Number(configured) || 10, 200));

  await pool.query(
    `DELETE FROM cloudtrail_sql_query_history
     WHERE id NOT IN (
       SELECT id
       FROM cloudtrail_sql_query_history
       ORDER BY submitted_at DESC, id DESC
       LIMIT $1
     )`,
    [limit]
  );
}

async function syncCloudtrailSqlQueryStatus(queryId) {
  const localResult = await pool.query(
    `SELECT *
     FROM cloudtrail_sql_query_history
     WHERE query_id = $1`,
    [queryId]
  );

  if (!localResult.rows.length) {
    const error = new Error("Query not found");
    error.statusCode = 404;
    throw error;
  }

  const local = localResult.rows[0];
  if (!local.athena_execution_id) return local;

  const execution = await athenaClient.send(new GetQueryExecutionCommand({
    QueryExecutionId: local.athena_execution_id
  }));

  const status = execution.QueryExecution?.Status || {};
  const statistics = execution.QueryExecution?.Statistics || {};
  const state = mapAthenaStateToLocal(status.State);
  const reason = status.StateChangeReason || null;
  const startedAt = status.SubmissionDateTime || local.started_at || null;
  const finishedAt = status.CompletionDateTime || local.finished_at || null;

  const updateResult = await pool.query(
    `UPDATE cloudtrail_sql_query_history
     SET status = $2,
         error_message = $3,
         started_at = COALESCE($4, started_at),
         finished_at = COALESCE($5, finished_at),
         execution_statistics_json = COALESCE($6::jsonb, execution_statistics_json),
         updated_at = NOW()
     WHERE query_id = $1
     RETURNING *`,
    [
      queryId,
      state,
      reason,
      startedAt,
      finishedAt,
      Object.keys(statistics).length ? JSON.stringify(statistics) : null
    ]
  );

  return updateResult.rows[0];
}

async function bumpRuleConfigVersion(client = pool) {
  await client.query(`
    INSERT INTO rule_config_state (scope, version, updated_at)
    VALUES ('alert_rules', 2, NOW())
    ON CONFLICT (scope) DO UPDATE
    SET version = rule_config_state.version + 1,
        updated_at = NOW()
  `);
}

function buildRuleSnapshot(rule) {
  return {
    id: rule.id,
    rule_name: rule.rule_name,
    is_default: rule.is_default,
    account_id: rule.account_id,
    region_code: rule.region_code,
    event_source: rule.event_source,
    event_name: rule.event_name,
    resource_type: rule.resource_type,
    resource_pattern: rule.resource_pattern,
    user_arn_pattern: rule.user_arn_pattern,
    source_ip_pattern: rule.source_ip_pattern,
    severity: rule.severity,
    cooldown_seconds: rule.cooldown_seconds,
    notification_route_id: rule.notification_route_id,
    description: rule.description,
    enabled: rule.enabled
  };
}

async function validateAlertRuleNotificationRoute(client, payload = {}, { existingRule = null } = {}) {
  const invalid = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
  };
  const hasRouteField = Object.prototype.hasOwnProperty.call(payload || {}, "notification_route_id");
  const nextRouteId = hasRouteField ? payload.notification_route_id : existingRule?.notification_route_id;
  const nextEnabled = Object.prototype.hasOwnProperty.call(payload || {}, "enabled")
    ? payload.enabled
    : (existingRule?.enabled ?? true);

  if (nextRouteId === null || nextRouteId === undefined || nextRouteId === "") {
    throw invalid("通知渠道为必填项，请先关联通知渠道。");
  }

  const routeResult = await client.query(
    `SELECT anr.id, anr.enabled AS route_enabled, nc.id AS channel_id, nc.enabled AS channel_enabled
     FROM account_notification_routes anr
     JOIN notification_channels nc ON nc.id = anr.channel_id
     WHERE anr.id = $1
     LIMIT 1`,
    [nextRouteId]
  );

  if (!routeResult.rows.length) {
    throw invalid("关联的通知渠道不存在，请重新选择。");
  }

  const route = routeResult.rows[0];
  if (nextEnabled && (!route.route_enabled || !route.channel_enabled)) {
    throw invalid("关联的通知渠道未启用，不能启用该规则。");
  }
}

async function ensureDefaultNotificationRoute(client = pool) {
  const channelResult = await client.query(
    `SELECT id
     FROM notification_channels
     WHERE enabled = TRUE
     ORDER BY id ASC
     LIMIT 1`
  );
  if (!channelResult.rows.length) {
    const error = new Error("没有可用的已启用通知渠道，无法创建默认通知路由。");
    error.statusCode = 400;
    throw error;
  }

  const channelId = channelResult.rows[0].id;
  const routeResult = await client.query(
    `INSERT INTO account_notification_routes (account_id, project_name, environment, channel_id, enabled)
     VALUES ('*', 'default', 'default', $1, TRUE)
     ON CONFLICT (account_id, channel_id)
     DO UPDATE SET enabled = TRUE, updated_at = NOW()
     RETURNING *`,
    [channelId]
  );
  return routeResult.rows[0];
}

function buildAlertEventsWhere(query = {}) {
  const clauses = [];
  const values = [];

  const addIlike = (column, value) => {
    if (!value || !String(value).trim()) return;
    values.push(`%${String(value).trim()}%`);
    clauses.push(`${column} ILIKE $${values.length}`);
  };

  addIlike("ae.event_id", query.eventId);
  addIlike("ae.event_name", query.eventName);
  addIlike("ae.resource_id", query.resourceId);
  addIlike("ae.user_arn", query.actorArn);
  addIlike("ae.source_ip", query.sourceIp);
  addIlike("ar.rule_name", query.ruleName);

  if (query.awsAccountId && String(query.awsAccountId).trim()) {
    values.push(String(query.awsAccountId).trim());
    clauses.push(`ae.account_id = $${values.length}`);
  }

  if (query.awsRegion && String(query.awsRegion).trim()) {
    values.push(String(query.awsRegion).trim());
    clauses.push(`ae.region_code = $${values.length}`);
  }

  if (query.alertStatus && String(query.alertStatus).trim()) {
    values.push(String(query.alertStatus).trim());
    clauses.push(`ae.alert_status = $${values.length}`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values
  };
}

function buildAlertRulesWhere(query = {}) {
  const clauses = [];
  const values = [];

  const addIlike = (column, value) => {
    if (!value || !String(value).trim()) return;
    values.push(`%${String(value).trim()}%`);
    clauses.push(`${column} ILIKE $${values.length}`);
  };

  addIlike("ar.rule_name", query.ruleName);
  addIlike("ar.event_name", query.eventName);
  addIlike("ar.event_source", query.eventSource);
  addIlike("ar.resource_type", query.resourceType);
  addIlike("ar.resource_pattern", query.resourcePattern);
  addIlike("nc.channel_name", query.notificationChannel);

  if (query.accountId && String(query.accountId).trim()) {
    values.push(String(query.accountId).trim());
    clauses.push(`ar.account_id = $${values.length}`);
  }

  if (query.regionCode && String(query.regionCode).trim()) {
    values.push(String(query.regionCode).trim());
    clauses.push(`ar.region_code = $${values.length}`);
  }

  if (query.severity && String(query.severity).trim()) {
    values.push(String(query.severity).trim());
    clauses.push(`ar.severity = $${values.length}`);
  }

  if (query.enabled !== undefined && query.enabled !== null && String(query.enabled).trim() !== "") {
    values.push(String(query.enabled).trim() === "true");
    clauses.push(`ar.enabled = $${values.length}`);
  }

  if (query.isDefault !== undefined && query.isDefault !== null && String(query.isDefault).trim() !== "") {
    values.push(String(query.isDefault).trim() === "true");
    clauses.push(`ar.is_default = $${values.length}`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values
  };
}

function buildSqlTemplatesWhere(query = {}) {
  const clauses = ["is_deleted = FALSE"];
  const values = [];

  const addIlike = (column, value) => {
    if (!value || !String(value).trim()) return;
    values.push(`%${String(value).trim()}%`);
    clauses.push(`${column} ILIKE $${values.length}`);
  };

  addIlike("name", query.keyword);
  addIlike("category", query.categoryKeyword);

  if (query.templateType && String(query.templateType).trim()) {
    values.push(String(query.templateType).trim());
    clauses.push(`template_type = $${values.length}`);
  }

  if (query.category && String(query.category).trim()) {
    values.push(String(query.category).trim());
    clauses.push(`category = $${values.length}`);
  }

  if (query.isActive !== undefined && query.isActive !== null && String(query.isActive).trim() !== "") {
    values.push(String(query.isActive).trim() === "true");
    clauses.push(`is_active = $${values.length}`);
  }

  return {
    whereSql: `WHERE ${clauses.join(" AND ")}`,
    values
  };
}

function normalizeAthenaSql(sqlText) {
  const text = String(sqlText || "").trim();
  if (!text) {
    const error = new Error("SQL 不能为空");
    error.statusCode = 400;
    throw error;
  }

  const withoutTrailingSemicolon = text.replace(/;+\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    const error = new Error("只允许执行单条 SQL");
    error.statusCode = 400;
    throw error;
  }

  if (!/^\s*(select|with)\b/i.test(withoutTrailingSemicolon)) {
    const error = new Error("当前仅支持 SELECT / WITH 查询");
    error.statusCode = 400;
    throw error;
  }

  return withoutTrailingSemicolon;
}

async function buildAthenaStartParams(queryString) {
  const athenaConfig = await getAthenaRuntimeConfig();
  const params = { QueryString: queryString };

  if (athenaConfig.database) {
    params.QueryExecutionContext = { Database: athenaConfig.database };
  }
  if (athenaConfig.workgroup) {
    params.WorkGroup = athenaConfig.workgroup;
  }
  if (athenaConfig.outputLocation) {
    params.ResultConfiguration = { OutputLocation: athenaConfig.outputLocation };
  }

  return params;
}

function mapAthenaStateToLocal(state) {
  if (!state) return "QUEUED";
  if (["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(state)) return state;
  return "QUEUED";
}

function parseAthenaRows(result, skipHeaderRow) {
  const columns = result.ResultSet?.ResultSetMetadata?.ColumnInfo?.map((column) => column.Name) || [];
  const rows = result.ResultSet?.Rows || [];
  const dataRows = skipHeaderRow ? rows.slice(1) : rows;
  const items = dataRows.map((row) => {
    const values = row.Data || [];
    return columns.reduce((acc, column, index) => {
      acc[column] = values[index]?.VarCharValue ?? null;
      return acc;
    }, {});
  });

  return { columns, items };
}

app.get("/health", async (_req, res) => {
  const athenaConfig = await getAthenaRuntimeConfig();
  const now = await pool.query("SELECT NOW() AS now");
  res.json({
    ok: true,
    dbTime: now.rows[0].now,
    athena: {
      region: awsRegion,
      database: athenaConfig.database,
      workgroup: athenaConfig.workgroup,
      outputLocationConfigured: !!athenaConfig.outputLocation
    }
  });
});

app.get('/settings', async (_req, res) => {
  const rows = await getAppSettingsRows();
  res.json({ data: rows });
});

app.get('/settings/public', async (_req, res) => {
  const rows = await getAppSettingsRows({ isPublic: true });
  res.json({
    data: rows.reduce((acc, row) => {
      acc[row.setting_key] = row.parsed_value;
      return acc;
    }, {})
  });
});

app.put('/settings', async (req, res) => {
  const items = Array.isArray(req.body?.items)
    ? req.body.items
    : Object.entries(req.body || {}).map(([setting_key, setting_value]) => ({ setting_key, setting_value }));

  if (!items.length) {
    return res.status(400).json({ message: 'No settings provided' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      if (!item?.setting_key) continue;
      const existing = await client.query(
        `SELECT value_type FROM app_settings WHERE setting_key = $1`,
        [item.setting_key]
      );
      if (!existing.rows.length) continue;
      const valueType = existing.rows[0].value_type;
      let settingValue = item.setting_value;
      if (valueType === 'boolean') settingValue = String(Boolean(settingValue));
      else if (valueType === 'number') settingValue = String(Number(settingValue));
      else if (valueType === 'json') settingValue = JSON.stringify(settingValue ?? null);
      else settingValue = settingValue == null ? '' : String(settingValue);

      await client.query(
        `UPDATE app_settings
         SET setting_value = $2, updated_at = NOW()
         WHERE setting_key = $1`,
        [item.setting_key, settingValue]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (items.some((item) => item?.setting_key === 'cloudtrail.historyRetentionLimit')) {
    await enforceCloudtrailHistoryRetention();
  }

  const rows = await getAppSettingsRows();
  res.json({ data: rows });
});

app.get("/cloudtrail-sql-templates", async (req, res) => {
  const current = Number(req.query.current || 1);
  const pageSize = Number(req.query.pageSize || 20);
  const offset = (current - 1) * pageSize;
  const filter = buildSqlTemplatesWhere(req.query || {});

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM cloudtrail_sql_templates ${filter.whereSql}`,
    filter.values
  );
  const dataResult = await pool.query(
    `SELECT *
     FROM cloudtrail_sql_templates
     ${filter.whereSql}
     ORDER BY template_type = 'system' DESC, updated_at DESC, id DESC
     LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`,
    [...filter.values, pageSize, offset]
  );

  res.json({ data: dataResult.rows, total: countResult.rows[0].count });
});

app.get("/cloudtrail-sql-templates/:id", async (req, res) => {
  const result = await pool.query(
    `SELECT *
     FROM cloudtrail_sql_templates
     WHERE id = $1 AND is_deleted = FALSE`,
    [req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ message: "Template not found" });
  }

  res.json({ data: result.rows[0] });
});

app.post("/cloudtrail-sql-templates", async (req, res) => {
  const payload = req.body || {};
  const name = String(payload.name || "").trim();
  const sqlText = String(payload.sql_text || "").trim();

  if (!name || !sqlText) {
    return res.status(400).json({ message: "name 和 sql_text 不能为空" });
  }

  const templateCode = String(payload.template_code || `tpl_${Date.now()}`).trim();
  const result = await pool.query(
    `INSERT INTO cloudtrail_sql_templates (
      template_code, name, description, category, template_type, sql_text, is_active, created_by, updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      templateCode,
      name,
      payload.description || null,
      payload.category || "general",
      payload.template_type || "personal",
      sqlText,
      payload.is_active !== undefined ? Boolean(payload.is_active) : true,
      payload.created_by || "web",
      payload.updated_by || payload.created_by || "web"
    ]
  );

  res.status(201).json({ data: result.rows[0] });
});

app.patch("/cloudtrail-sql-templates/:id", async (req, res) => {
  const allowedFields = ["name", "description", "category", "template_type", "sql_text", "is_active", "updated_by"];
  const payload = req.body || {};
  const fields = allowedFields.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));

  if (!fields.length) {
    return res.status(400).json({ message: "No valid fields provided" });
  }

  const values = fields.map((field) => payload[field]);
  const setClause = fields.map((field, index) => `${field} = $${index + 1}`).join(", ");
  const result = await pool.query(
    `UPDATE cloudtrail_sql_templates
     SET ${setClause}, updated_at = NOW()
     WHERE id = $${fields.length + 1} AND is_deleted = FALSE
     RETURNING *`,
    [...values, req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ message: "Template not found" });
  }

  res.json({ data: result.rows[0] });
});

app.delete("/cloudtrail-sql-templates/:id", async (req, res) => {
  const existing = await pool.query(
    `SELECT id, template_type
     FROM cloudtrail_sql_templates
     WHERE id = $1 AND is_deleted = FALSE`,
    [req.params.id]
  );

  if (!existing.rows.length) {
    return res.status(404).json({ message: "Template not found" });
  }
  if (existing.rows[0].template_type === "system") {
    return res.status(400).json({ message: "系统模板不允许删除" });
  }

  const result = await pool.query(
    `UPDATE cloudtrail_sql_templates
     SET is_deleted = TRUE, is_active = FALSE, updated_at = NOW()
     WHERE id = $1 AND is_deleted = FALSE
     RETURNING *`,
    [req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ message: "Template not found" });
  }

  res.json({ data: result.rows[0] });
});

app.get("/cloudtrail-sql-queries", async (req, res) => {
  const current = Number(req.query.current || 1);
  const pageSize = Number(req.query.pageSize || 20);
  const offset = (current - 1) * pageSize;
  const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM cloudtrail_sql_query_history");
  const dataResult = await pool.query(
    `SELECT q.*, t.name AS template_name
     FROM cloudtrail_sql_query_history q
     LEFT JOIN cloudtrail_sql_templates t ON t.id = q.template_id
     ORDER BY q.submitted_at DESC, q.id DESC
     LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  );

  res.json({ data: dataResult.rows, total: countResult.rows[0].count });
});

app.post("/cloudtrail-sql-queries/execute", async (req, res) => {
  const payload = req.body || {};
  const sqlText = normalizeAthenaSql(payload.sqlText || payload.sql_text);
  const queryId = `ctsql_${Date.now()}`;
  const querySource = payload.templateId ? (payload.isEdited ? "template_edited" : "template") : "raw_sql";

  await pool.query(
    `INSERT INTO cloudtrail_sql_query_history (
      query_id, template_id, query_name, query_source, sql_text, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      queryId,
      payload.templateId || null,
      payload.queryName || null,
      querySource,
      sqlText,
      "QUEUED",
      payload.createdBy || "web"
    ]
  );

  await enforceCloudtrailHistoryRetention();

  try {
    const startResult = await athenaClient.send(new StartQueryExecutionCommand(await buildAthenaStartParams(sqlText)));
    const updated = await pool.query(
      `UPDATE cloudtrail_sql_query_history
       SET athena_execution_id = $2,
           status = 'QUEUED',
           updated_at = NOW()
       WHERE query_id = $1
       RETURNING *`,
      [queryId, startResult.QueryExecutionId || null]
    );
    return res.status(202).json({ data: updated.rows[0] });
  } catch (error) {
    await pool.query(
      `UPDATE cloudtrail_sql_query_history
       SET status = 'FAILED', error_message = $2, finished_at = NOW(), updated_at = NOW()
       WHERE query_id = $1`,
      [queryId, error.message || "Athena query start failed"]
    );
    return res.status(500).json({ message: error.message || "Athena query start failed", queryId });
  }
});

app.get("/cloudtrail-sql-queries/:queryId", async (req, res) => {
  const query = await syncCloudtrailSqlQueryStatus(req.params.queryId);
  res.json({ data: query });
});

app.get("/cloudtrail-sql-queries/:queryId/results", async (req, res) => {
  const synced = await syncCloudtrailSqlQueryStatus(req.params.queryId);
  if (synced.status !== "SUCCEEDED") {
    return res.status(409).json({ message: `Query status is ${synced.status}`, data: synced });
  }

  const nextToken = req.query.nextToken ? String(req.query.nextToken) : undefined;
  const maxResults = Math.min(Number(req.query.maxResults || 100), 1000);
  const result = await athenaClient.send(new GetQueryResultsCommand({
    QueryExecutionId: synced.athena_execution_id,
    NextToken: nextToken,
    MaxResults: maxResults
  }));

  const parsed = parseAthenaRows(result, !nextToken);
  await pool.query(
    `UPDATE cloudtrail_sql_query_history
     SET result_columns_json = COALESCE($2::jsonb, result_columns_json), updated_at = NOW()
     WHERE query_id = $1`,
    [req.params.queryId, parsed.columns.length ? JSON.stringify(parsed.columns) : null]
  );

  res.json({
    data: {
      queryId: req.params.queryId,
      columns: parsed.columns,
      items: parsed.items,
      nextToken: result.NextToken || null,
      status: synced.status,
      executionStatistics: synced.execution_statistics_json || null
    }
  });
});

app.get("/dashboard/stats", async (_req, res) => {
  const [accounts, regions, rules, channels, routes, events] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM aws_accounts"),
    pool.query("SELECT COUNT(*)::int AS count FROM aws_regions"),
    pool.query("SELECT COUNT(*)::int AS count FROM alert_rules"),
    pool.query("SELECT COUNT(*)::int AS count FROM notification_channels"),
    pool.query("SELECT COUNT(*)::int AS count FROM account_notification_routes"),
    pool.query("SELECT COUNT(*)::int AS count FROM alert_events")
  ]);

  res.json({
    data: {
      awsAccounts: accounts.rows[0].count,
      awsRegions: regions.rows[0].count,
      alertRules: rules.rows[0].count,
      notificationChannels: channels.rows[0].count,
      accountRoutes: routes.rows[0].count,
      alertEvents: events.rows[0].count
    }
  });
});

app.get("/dashboard/recent-alerts", async (_req, res) => {
  const result = await pool.query(
    `SELECT id, account_id, event_name, severity, alert_status, event_time
     FROM alert_events
     ORDER BY event_time DESC
     LIMIT 10`
  );

  res.json({ data: result.rows });
});

app.get("/dashboard/top-accounts", async (_req, res) => {
  const result = await pool.query(
    `SELECT account_id, COUNT(*)::int AS count
     FROM alert_events
     GROUP BY account_id
     ORDER BY count DESC, account_id ASC
     LIMIT 5`
  );

  res.json({ data: result.rows });
});

app.get("/dashboard/top-events", async (_req, res) => {
  const result = await pool.query(
    `SELECT event_name, COUNT(*)::int AS count
     FROM alert_events
     GROUP BY event_name
     ORDER BY count DESC, event_name ASC
     LIMIT 5`
  );

  res.json({ data: result.rows });
});

app.get("/dashboard/workers", async (_req, res) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_status (
      worker_name VARCHAR(80) PRIMARY KEY,
      worker_type VARCHAR(80) NOT NULL,
      status VARCHAR(32) NOT NULL,
      last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingest_worker_checkpoints (
      worker_name VARCHAR(80) NOT NULL,
      source_mode VARCHAR(32) NOT NULL,
      target_key VARCHAR(200) NOT NULL,
      checkpoint_time TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (worker_name, source_mode, target_key)
    )
  `);

  const result = await pool.query(`
    WITH checkpoint_summary AS (
      SELECT
        worker_name,
        COUNT(*)::int AS s3_target_count,
        MAX(checkpoint_time) AS s3_last_checkpoint_at,
        MAX(updated_at) AS s3_last_checkpoint_updated_at,
        json_agg(
          json_build_object(
            'targetKey', target_key,
            'checkpointTime', checkpoint_time,
            'updatedAt', updated_at
          )
          ORDER BY target_key
        ) AS s3_checkpoints
      FROM ingest_worker_checkpoints
      WHERE source_mode = 's3'
      GROUP BY worker_name
    )
    SELECT
      ws.worker_name,
      ws.worker_type,
      ws.status,
      ws.last_heartbeat_at,
      ws.last_message,
      ws.updated_at,
      EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at))::int AS stale_seconds,
      CASE
        WHEN NOW() - last_heartbeat_at <= INTERVAL '45 seconds' THEN 'healthy'
        WHEN NOW() - last_heartbeat_at <= INTERVAL '120 seconds' THEN 'stale'
        ELSE 'offline'
      END AS health,
      cs.s3_target_count,
      cs.s3_last_checkpoint_at,
      cs.s3_last_checkpoint_updated_at,
      cs.s3_checkpoints
    FROM worker_status ws
    LEFT JOIN checkpoint_summary cs ON cs.worker_name = ws.worker_name
    ORDER BY ws.worker_type, ws.worker_name
  `);
  const dbRows = (result.rows || []).filter((row) => ACTIVE_WORKER_TYPES.has(row.worker_type));
  const podSummary = await getWorkerPodSummary().catch(() => null);
  if (!podSummary) {
    return res.json({ data: dbRows });
  }

  const byWorkerName = new Map(dbRows.map((row) => [row.worker_name, row]));
  const merged = WORKER_POD_TARGETS.map((target) => {
    const dbRow = byWorkerName.get(target.workerName) || {};
    const podRow = podSummary.get(target.appLabel) || { desiredPods: 0, readyPods: 0, podNames: [] };
    const healthy = podRow.desiredPods > 0 && podRow.readyPods === podRow.desiredPods;
    const partial = podRow.readyPods > 0 && podRow.readyPods < podRow.desiredPods;
    return {
      worker_name: target.workerName,
      worker_type: target.workerType,
      status: `${dbRow.status || (podRow.desiredPods > 0 ? "running" : "stopped")} · pods ${podRow.readyPods}/${podRow.desiredPods}`,
      last_heartbeat_at: dbRow.last_heartbeat_at || null,
      last_message: dbRow.last_message || null,
      updated_at: dbRow.updated_at || null,
      stale_seconds: dbRow.stale_seconds ?? null,
      health: healthy ? "healthy" : partial ? "stale" : "offline",
      desired_pods: podRow.desiredPods,
      ready_pods: podRow.readyPods,
      pod_names: podRow.podNames,
      s3_target_count: dbRow.s3_target_count ?? null,
      s3_last_checkpoint_at: dbRow.s3_last_checkpoint_at ?? null,
      s3_last_checkpoint_updated_at: dbRow.s3_last_checkpoint_updated_at ?? null,
      s3_checkpoints: dbRow.s3_checkpoints ?? null
    };
  });

  res.json({ data: merged });
});

app.get("/dashboard/queue", async (_req, res) => {
  try {
    const { queueUrl } = await getSqsRuntimeConfig();
    const response = await sqsClient.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
        "CreatedTimestamp",
        "LastModifiedTimestamp"
      ]
    }));

    const attributes = response.Attributes || {};
    res.json({
      data: {
        mode: 's3-event-sqs',
        queueUrl,
        visible: Number(attributes.ApproximateNumberOfMessages || 0),
        inFlight: Number(attributes.ApproximateNumberOfMessagesNotVisible || 0),
        delayed: Number(attributes.ApproximateNumberOfMessagesDelayed || 0),
        createdAt: attributes.CreatedTimestamp ? new Date(Number(attributes.CreatedTimestamp) * 1000).toISOString() : null,
        updatedAt: attributes.LastModifiedTimestamp ? new Date(Number(attributes.LastModifiedTimestamp) * 1000).toISOString() : null,
        ok: true
      }
    });
  } catch (error) {
    res.json({
      data: {
        mode: 's3-event-sqs',
        queueUrl: (await getSqsRuntimeConfig()).queueUrl,
        visible: null,
        inFlight: null,
        delayed: null,
        ok: false,
        error: error.message || "failed_to_read_queue"
      }
    });
  }
});

app.get("/dashboard/pipeline", async (_req, res) => {
  const [ingestSummary, alertSummary, minuteBuckets] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS matched_last_5m,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 minute')::int AS matched_last_1m
      FROM alert_events
      WHERE created_at >= NOW() - INTERVAL '5 minutes'
    `),
    pool.query(`
      SELECT
        COUNT(*)::int AS alerts_last_5m,
        COUNT(*) FILTER (WHERE alert_status = 'sent')::int AS sent_last_5m,
        COUNT(*) FILTER (WHERE alert_status = 'notify_failed')::int AS notify_failed_last_5m
      FROM alert_events
      WHERE created_at >= NOW() - INTERVAL '5 minutes'
    `),
    pool.query(`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc('minute', NOW() - INTERVAL '4 minutes'),
          date_trunc('minute', NOW()),
          INTERVAL '1 minute'
        ) AS bucket
      ),
      matched AS (
        SELECT date_trunc('minute', created_at) AS bucket, COUNT(*)::int AS count
        FROM alert_events
        WHERE created_at >= NOW() - INTERVAL '5 minutes'
        GROUP BY 1
      ),
      alerts AS (
        SELECT date_trunc('minute', created_at) AS bucket,
               COUNT(*)::int AS alerts_count,
               COUNT(*) FILTER (WHERE alert_status = 'sent')::int AS sent_count
        FROM alert_events
        WHERE created_at >= NOW() - INTERVAL '5 minutes'
        GROUP BY 1
      )
      SELECT
        to_char(b.bucket, 'HH24:MI') AS minute,
        COALESCE(m.count, 0) AS matched,
        COALESCE(a.alerts_count, 0) AS alerts,
        COALESCE(a.sent_count, 0) AS sent
      FROM buckets b
      LEFT JOIN matched m ON m.bucket = b.bucket
      LEFT JOIN alerts a ON a.bucket = b.bucket
      ORDER BY b.bucket
    `)
  ]);

  res.json({
    data: {
      ingest: ingestSummary.rows[0] || {},
      alerts: alertSummary.rows[0] || {},
      timeline: minuteBuckets.rows || []
    }
  });
});

app.get("/dashboard/severity-distribution", async (_req, res) => {
  const result = await pool.query(
    `SELECT severity, COUNT(*)::int AS count
     FROM alert_events
     GROUP BY severity
     ORDER BY count DESC, severity ASC`
  );

  res.json({ data: result.rows });
});

app.get("/alert-events/:id/raw", async (req, res) => {
  const result = await pool.query(
    `SELECT id, raw_event_json
     FROM alert_events
     WHERE id = $1`,
    [req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ message: "Not found" });
  }

  res.json({ data: result.rows[0] });
});

app.post("/ingest/cloudtrail", async (req, res) => {
  const event = req.body || {};
  const detail = event.detail || {};
  const accountId = String(event.account || detail.recipientAccountId || req.body.account_id || "unknown");
  const eventName = detail.eventName || req.body.event_name;
  const eventSource = detail.eventSource || req.body.event_source;
  const eventTime = event.time || detail.eventTime || new Date().toISOString();
  const regionCode = event.region || detail.awsRegion || req.body.region_code || null;
  const sourceIp = detail.sourceIPAddress || req.body.source_ip || null;
  const userArn = detail.userIdentity?.arn || req.body.user_arn || null;
  const { resourceId: extractedResourceId, resourceName: extractedResourceName } = extractResource(detail);
  const resourceId = extractedResourceId || req.body.resource_id || null;
  const resourceName = extractedResourceName || req.body.resource_name || null;

  if (!eventName || !eventSource) {
    return res.status(400).json({ message: "eventName and eventSource are required" });
  }

  const eventTypeResult = await pool.query(
    `SELECT *
     FROM event_types
     WHERE event_source = $1
       AND event_name = $2
     ORDER BY id ASC
     LIMIT 1`,
    [eventSource, eventName]
  );

  const eventType = eventTypeResult.rows[0];
  if (!eventType) {
    return res.json({ matched: false, reason: "event_type_not_configured" });
  }

  const resourceType = inferResourceType(detail, eventType);

  const ruleResult = await pool.query(
    `SELECT *
     FROM alert_rules
     WHERE enabled = TRUE
       AND account_id IN ($1, '*')
       AND event_source = $2
       AND event_name = $3
     ORDER BY id ASC`,
    [accountId, eventSource, eventName]
  );

  const matchedRule = ruleResult.rows
    .filter((rule) =>
      matchesRule(rule, {
        accountId,
        regionCode,
        eventSource,
        eventName,
        resourceType,
        resourceId,
        resourceName,
        userArn,
        sourceIp
      })
    )
    .sort((a, b) => ruleSpecificity(b) - ruleSpecificity(a) || Number(a.id) - Number(b.id))[0];

  if (!matchedRule) {
    return res.json({ matched: false, reason: "no_rule_matched" });
  }

  const insertResult = await pool.query(
    `INSERT INTO alert_events (
      account_id, region_code, event_source, event_name, severity, event_time, resource_id, resource_name, user_arn, source_ip, raw_event_json, alert_status, matched_rule_id, matched_rule_name_snapshot, matched_rule_snapshot_json, notification_route_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16)
     RETURNING *`,
    [
      accountId,
      regionCode,
      eventSource,
      eventName,
      matchedRule.severity || eventType.severity,
      eventTime,
      resourceId,
      resourceName,
      userArn,
      sourceIp,
      JSON.stringify(event),
      "sent",
      matchedRule.id,
      matchedRule.rule_name || null,
      JSON.stringify(buildRuleSnapshot(matchedRule)),
      matchedRule.notification_route_id || null
    ]
  );

  res.status(201).json({ matched: true, rule: matchedRule, data: insertResult.rows[0] });
});

app.post("/seed/catalog", async (_req, res) => {
  await pool.query(`
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
    ON CONFLICT (code) DO NOTHING
  `);

  await pool.query(`
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
    ON CONFLICT (event_source, event_name) DO NOTHING
  `);

  res.json({ ok: true });
});

app.post("/seed/accounts-regions", async (_req, res) => {
  await pool.query(`
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
    ON CONFLICT (account_id) DO UPDATE SET
      account_name = EXCLUDED.account_name,
      note = COALESCE(NULLIF(aws_accounts.note, ''), EXCLUDED.note)
  `);

  await pool.query(`
    INSERT INTO aws_regions (region_code, display_name, region_group)
    VALUES
      ('af-south-1', 'Africa (Cape Town)', 'Africa'),
      ('ap-east-1', 'Asia Pacific (Hong Kong)', 'Asia Pacific'),
      ('ap-east-2', 'Asia Pacific (Taipei)', 'Asia Pacific'),
      ('ap-south-2', 'Asia Pacific (Hyderabad)', 'Asia Pacific'),
      ('ap-southeast-3', 'Asia Pacific (Jakarta)', 'Asia Pacific'),
      ('ap-southeast-4', 'Asia Pacific (Melbourne)', 'Asia Pacific'),
      ('ap-southeast-5', 'Asia Pacific (Malaysia)', 'Asia Pacific'),
      ('ap-southeast-6', 'Asia Pacific (New Zealand)', 'Asia Pacific'),
      ('ap-southeast-7', 'Asia Pacific (Thailand)', 'Asia Pacific'),
      ('ca-west-1', 'Canada (Calgary)', 'Canada'),
      ('eu-central-2', 'Europe (Zurich)', 'Europe'),
      ('eu-south-1', 'Europe (Milan)', 'Europe'),
      ('eu-south-2', 'Europe (Spain)', 'Europe'),
      ('il-central-1', 'Israel (Tel Aviv)', 'Israel'),
      ('me-central-1', 'Middle East (UAE)', 'Middle East'),
      ('me-south-1', 'Middle East (Bahrain)', 'Middle East'),
      ('mx-central-1', 'Mexico (Central)', 'Mexico'),
      ('ap-northeast-1', 'Asia Pacific (Tokyo)', 'Asia Pacific'),
      ('ap-northeast-2', 'Asia Pacific (Seoul)', 'Asia Pacific'),
      ('ap-northeast-3', 'Asia Pacific (Osaka)', 'Asia Pacific'),
      ('ap-south-1', 'Asia Pacific (Mumbai)', 'Asia Pacific'),
      ('ap-southeast-1', 'Asia Pacific (Singapore)', 'Asia Pacific'),
      ('ap-southeast-2', 'Asia Pacific (Sydney)', 'Asia Pacific'),
      ('ca-central-1', 'Canada (Central)', 'Canada'),
      ('eu-central-1', 'Europe (Frankfurt)', 'Europe'),
      ('eu-north-1', 'Europe (Stockholm)', 'Europe'),
      ('eu-west-1', 'Europe (Ireland)', 'Europe'),
      ('eu-west-2', 'Europe (London)', 'Europe'),
      ('eu-west-3', 'Europe (Paris)', 'Europe'),
      ('sa-east-1', 'South America (São Paulo)', 'South America'),
      ('us-east-1', 'United States (N. Virginia)', 'United States'),
      ('us-east-2', 'United States (Ohio)', 'United States'),
      ('us-west-1', 'United States (N. California)', 'United States'),
      ('us-west-2', 'United States (Oregon)', 'United States')
    ON CONFLICT (region_code) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      region_group = EXCLUDED.region_group
  `);

  res.json({ ok: true });
});

app.post("/seed/default-rules", async (_req, res) => {
  const defaultRoute = await ensureDefaultNotificationRoute();
  await pool.query(`
    INSERT INTO alert_rules (
      rule_name, is_default, account_id, region_code, event_source, event_name, resource_type, severity, enabled, cooldown_seconds, notification_route_id, description
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
      $1,
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
    )
  `, [defaultRoute.id]);

  await bumpRuleConfigVersion();

  res.json({ ok: true });
});

Object.entries(resourceMap).forEach(([path, resource]) => {
  app.get(`/${path}`, async (req, res) => {
    const current = Number(req.query.current || 1);
    const pageSize = Number(req.query.pageSize || 20);
    const offset = (current - 1) * pageSize;

    if (path === "alert-events") {
      const filter = buildAlertEventsWhere(req.query || {});
      const baseFrom = `
        FROM alert_events ae
        LEFT JOIN alert_rules ar ON ar.id = ae.matched_rule_id
        LEFT JOIN notification_channels nc ON nc.id = ae.notification_channel_id
      `;
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count ${baseFrom} ${filter.whereSql}`,
        filter.values
      );
      const dataResult = await pool.query(
        `SELECT
           ae.*,
           COALESCE(ae.matched_rule_name_snapshot, ar.rule_name) AS matched_rule_name,
           nc.channel_name AS notification_channel_name
         ${baseFrom}
         ${filter.whereSql}
         ORDER BY ae.event_time DESC NULLS LAST, ae.id DESC
         LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`,
        [...filter.values, pageSize, offset]
      );

      return res.json({ data: dataResult.rows.map((row) => sanitizeResourceRow(path, row)), total: countResult.rows[0].count });
    }

    if (path === "alert-rules") {
      const filter = buildAlertRulesWhere(req.query || {});
      const baseFrom = `
        FROM alert_rules ar
        LEFT JOIN account_notification_routes anr ON anr.id = ar.notification_route_id
        LEFT JOIN notification_channels nc ON nc.id = anr.channel_id
      `;
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count ${baseFrom} ${filter.whereSql}`,
        filter.values
      );
      const dataResult = await pool.query(
        `SELECT ar.*, nc.channel_name AS notification_channel_name
         ${baseFrom}
         ${filter.whereSql}
         ORDER BY ar.id DESC
         LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`,
        [...filter.values, pageSize, offset]
      );

      return res.json({ data: dataResult.rows.map((row) => sanitizeResourceRow(path, row)), total: countResult.rows[0].count });
    }

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM ${resource.table}`);
    const dataResult = await pool.query(
      `SELECT * FROM ${resource.table} ORDER BY id DESC LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    res.json({ data: dataResult.rows.map((row) => sanitizeResourceRow(path, row)), total: countResult.rows[0].count });
  });

  app.get(`/${path}/:id`, async (req, res) => {
    const result = await pool.query(`SELECT * FROM ${resource.table} WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) {
      return res.status(404).json({ message: "Not found" });
    }
    res.json({ data: sanitizeResourceRow(path, result.rows[0]) });
  });

  app.post(`/${path}`, async (req, res) => {
    if (path === "alert-rules") {
      req.body = {
        ...req.body,
        is_default: false
      };
    }
    const insert = buildInsert(resource, req.body || {});
    if (!insert.allowed.length) {
      return res.status(400).json({ message: "No valid fields provided" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (path === "alert-rules") {
        await validateAlertRuleNotificationRoute(client, req.body || {});
      }
      const result = await client.query(
        `INSERT INTO ${resource.table} (${insert.columns}) VALUES (${insert.placeholders}) RETURNING *`,
        insert.values
      );
      if (path === "alert-rules") {
        await bumpRuleConfigVersion(client);
      }
      await client.query("COMMIT");
      return res.status(201).json({ data: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch(`/${path}/:id`, async (req, res) => {
    if (path === "alert-rules" && Object.prototype.hasOwnProperty.call(req.body || {}, "is_default")) {
      delete req.body.is_default;
    }
    const update = buildUpdate(resource, req.body || {});
    if (!update.allowed.length) {
      return res.status(400).json({ message: "No valid fields provided" });
    }

    const needsUpdatedAt = ["aws_accounts", "aws_regions", "resource_types", "event_types", "alert_rules", "notification_channels", "account_notification_routes"].includes(resource.table);
    const setClause = needsUpdatedAt ? `${update.setClause}, updated_at = NOW()` : update.setClause;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let existingRule = null;
      if (path === "alert-rules") {
        const existingResult = await client.query(`SELECT * FROM alert_rules WHERE id = $1`, [req.params.id]);
        if (!existingResult.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Not found" });
        }
        existingRule = existingResult.rows[0];
        await validateAlertRuleNotificationRoute(client, req.body || {}, { existingRule });
      }
      const result = await client.query(
        `UPDATE ${resource.table} SET ${setClause} WHERE id = $${update.values.length + 1} RETURNING *`,
        [...update.values, req.params.id]
      );

      if (!result.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Not found" });
      }
      if (path === "alert-rules") {
        await bumpRuleConfigVersion(client);
      }
      await client.query("COMMIT");
      return res.json({ data: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete(`/${path}/:id`, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (path === "alert-rules") {
        const guard = await client.query(`SELECT id, is_default FROM alert_rules WHERE id = $1`, [req.params.id]);
        if (!guard.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Not found" });
        }
        if (guard.rows[0].is_default) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "默认规则禁止删除，可改为禁用。" });
        }
      }
      const result = await client.query(`DELETE FROM ${resource.table} WHERE id = $1 RETURNING *`, [req.params.id]);
      if (!result.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Not found" });
      }
      if (path === "alert-rules") {
        await bumpRuleConfigVersion(client);
      }
      await client.query("COMMIT");
      return res.json({ data: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
});

app.post("/alert-rules/bulk-update", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0) : [];
  const patch = req.body?.patch || {};
  if (!ids.length) {
    return res.status(400).json({ message: "ids 不能为空" });
  }

  const allowedFields = ["enabled", "severity", "notification_route_id", "description", "updated_by"];
  const entries = Object.entries(patch).filter(([key]) => allowedFields.includes(key));
  if (!entries.length) {
    return res.status(400).json({ message: "patch 没有可更新字段" });
  }

  const values = [];
  const setClauses = entries.map(([key, value], index) => {
    values.push(value);
    return `${key} = $${index + 1}`;
  });
  values.push(ids);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (Object.prototype.hasOwnProperty.call(patch, "notification_route_id") || Object.prototype.hasOwnProperty.call(patch, "enabled")) {
      const existingRules = await client.query(
        `SELECT * FROM alert_rules WHERE id = ANY($1::bigint[])`,
        [ids]
      );
      for (const rule of existingRules.rows) {
        await validateAlertRuleNotificationRoute(client, patch, { existingRule: rule });
      }
    }
    const result = await client.query(
      `UPDATE alert_rules
       SET ${setClauses.join(", ")}, updated_at = NOW()
       WHERE id = ANY($${values.length}::bigint[])
       RETURNING *`,
      values
    );
    await bumpRuleConfigVersion(client);
    await client.query("COMMIT");
    return res.json({ updated: result.rows.length, data: result.rows });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/seed/demo", async (_req, res) => {
  await pool.query(
    `INSERT INTO alert_events (account_id, region_code, event_name, severity, event_time, resource_id, resource_name, user_arn, source_ip, raw_event_json, alert_status)
     VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,$9::jsonb,$10)`,
    [
      "516199268720",
      "ap-northeast-2",
      "AuthorizeSecurityGroupIngress",
      "high",
      "sg-0123456789abcdef0",
      "web-ingress-sg",
      "arn:aws:iam::516199268720:user/admin",
      "1.2.3.4",
      JSON.stringify({ source: "demo-seed", detail: { eventName: "AuthorizeSecurityGroupIngress" } }),
      "new"
    ]
  );

  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ message: error.message || "Internal Server Error" });
});

Promise.all([
  ensureRuleConfigStateTable(),
  ensureAlertRulesMetadata(),
  ensureCloudtrailSqlTables(),
  ensureAppSettingsTable()
])
  .then(() => {
    app.listen(port, () => {
      console.log(`AWS SOC API listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize API runtime state", error);
    process.exit(1);
  });

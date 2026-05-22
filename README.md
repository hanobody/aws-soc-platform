# aws-soc-platform

AWS 多账号 SOC 平台，当前保留的主链路只有一条：

`S3 ObjectCreated -> SQS -> ingest-worker-s3-event -> 规则匹配 -> alert_events -> 通知`

## 当前原则

- 不再保留 `ingested_events` 中间落库
- 只有 **匹配成功** 的事件才写入 `alert_events`
- 规则必须关联通知渠道（通过 `account_notification_routes`）
- 本仓库不再提供本机 `docker compose` 部署；以 EKS 集群验证为准

## 目录

- `apps/api`：后端 API
- `apps/web`：前端
- `apps/ingest-worker-s3-event-go`：S3 CloudTrail 文件消费、匹配、通知
- `k8s/eks`：EKS 部署清单
- `sql/init`：数据库初始化 / 迁移 SQL

## 关键表

- `alert_rules`
- `alert_events`
- `notification_channels`
- `account_notification_routes`
- `aws_accounts`
- `aws_regions`
- `resource_types`
- `event_types`
- `app_settings`
- `worker_status`
- `ingest_worker_checkpoints`
- `cloudtrail_sql_templates`
- `cloudtrail_sql_query_history`
- `rule_config_state`

## 开发

```bash
npm install --workspaces
npm run api:dev
npm run web:dev
npm run web:build
```

## 常用种子接口

```bash
curl -s -X POST http://localhost:4000/seed/accounts-regions
curl -s -X POST http://localhost:4000/seed/catalog
curl -s -X POST http://localhost:4000/seed/default-rules
```

## 部署

看：

- `docs/deployment-eks.md`
- `docs/operations.md`
- `docs/architecture.md`

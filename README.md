# aws-soc-platform

一个面向 **AWS 多账号安全审计** 的 SOC 平台。

当前版本已经收口为一条明确主链路：

```text
S3 ObjectCreated -> SQS -> ingest-worker-s3-event -> 规则匹配 -> alert_events -> 通知
```

## 当前状态

- 已移除旧的 `ingested_events -> matcher-worker -> alert_events` 双阶段链路
- 现在只保留 **命中规则的事件**，直接写入 `alert_events`
- 规则必须绑定通知渠道，避免“命中但无法送达”
- 验证与部署以 **EKS 集群** 为准，不再维护本地 `docker compose` 运行方式

## 核心组件

### `apps/api`
后端 API，提供：
- Dashboard
- 规则中心 / 资源配置 CRUD
- 系统设置
- 通知渠道与路由配置
- 公共运行时配置（如 Keycloak）
- Seed 接口

### `apps/web`
前端控制台，提供：
- Dashboard
- 规则中心
- 通知渠道管理
- 系统设置
- CloudTrail SQL Console

### `apps/ingest-worker-s3-event-go`
当前唯一保留的采集 worker，负责：
- 消费 S3 ObjectCreated 对应的 SQS 消息
- 从 S3 读取 CloudTrail `.json.gz`
- 在进程内完成过滤、匹配、冷却判断、告警落库、通知发送
- 更新 `worker_status` 与检查点信息

## 关键数据模型

### 业务核心表
- `alert_rules`
- `alert_events`
- `notification_channels`
- `account_notification_routes`

### 基础配置表
- `aws_accounts`
- `aws_regions`
- `resource_types`
- `event_types`
- `app_settings`

### 运行态表
- `worker_status`
- `ingest_worker_checkpoints`
- `rule_config_state`
- `cloudtrail_sql_templates`
- `cloudtrail_sql_query_history`

## 目录结构

```text
apps/
  api/
  web/
  ingest-worker-s3-event-go/
k8s/
  eks/
sql/
  init/
docs/
```

## 本地开发

安装依赖：

```bash
npm install --workspaces
```

启动 API：

```bash
npm run api:dev
```

启动前端：

```bash
npm run web:dev
```

构建前端：

```bash
npm run web:build
```

## 常用接口 / 脚本

初始化账号与区域：

```bash
npm run seed:accounts
```

初始化资源/事件目录：

```bash
npm run seed:catalog
```

初始化默认规则：

```bash
npm run seed:default-rules
```

一次性初始化：

```bash
npm run seed:all
```

查看运行态：

```bash
npm run dashboard:workers
npm run dashboard:queue
npm run dashboard:pipeline
```

## EKS 部署

当前生效的 EKS 清单：

- `k8s/eks/00-namespace.yaml`
- `k8s/eks/01-configmap.yaml`
- `k8s/eks/03-serviceaccounts.yaml`
- `k8s/eks/04-api-rbac.yaml`
- `k8s/eks/10-api-deployment.yaml`
- `k8s/eks/11-web-deployment.yaml`
- `k8s/eks/14-ingest-worker-s3-event-deployment.yaml`
- `k8s/eks/20-services.yaml`
- `k8s/eks/kustomization.yaml`

应用部署：

```bash
kubectl apply -k k8s/eks
```

## 文档

- 部署：`docs/deployment-eks.md`
- 运维：`docs/operations.md`
- 架构：`docs/architecture.md`

## 设计约束

- 不再恢复旧 matcher 链路
- 不再引入本地 compose 作为标准验证路径
- 新规则必须关联可用通知路由
- Dashboard 中 worker 状态应优先反映真实 pod 状态

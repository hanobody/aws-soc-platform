# AWS SOC Platform

AWS SOC Platform 是一个面向多账号 AWS 审计/告警场景的本地可运行 MVP，当前已经打通：

- CloudTrail / EventBridge
- Lambda Router
- SQS 标准队列
- ingest-worker 入库 `ingested_events`
- matcher-worker 规则匹配 / 冷却 / 告警事件落库
- Telegram 通知发送
- Web 管理后台（Dashboard / 规则中心 / 采集事件 / 告警事件 / 基础配置）

---

## 当前能力

### 数据链路

```text
CloudTrail / EventBridge
  -> Lambda Router
  -> SQS (soc-cloudtrail-events)
  -> ingest-worker-go
  -> ingested_events
  -> matcher-worker-go
  -> alert_events
  -> Telegram / Dashboard
```

### 管理后台

- Dashboard
  - worker 健康状态
  - SQS 队列积压
  - 最近 5 分钟吞吐
- 规则中心
  - 账号 / 区域 / 通知渠道关联选择
  - 资源类型 / 事件类型联动
  - 批量创建
  - 批量删除
- 采集事件
  - 分页 / 筛选 / 原始事件 JSON
- 告警事件
  - 分页 / 筛选 / 原始事件 JSON
  - 匹配规则详情
- 基础配置中心
  - AWS 账号
  - AWS 区域
  - 资源类型
  - 事件类型
  - 通知渠道

---

## 目录结构

```text
aws-soc-platform/
├── apps/
│   ├── api/                    # Node.js API + dashboard data API + seed API
│   ├── web/                    # React + Refine 管理后台
│   ├── ingest-worker-go/       # SQS -> ingested_events
│   └── matcher-worker-go/      # ingested_events -> alert_events -> notify
├── docs/
│   ├── architecture.md         # 当前架构说明
│   └── operations.md           # 本地运行 / 运维说明
├── lambda/
│   └── cloudtrail-event-router/
│       └── lambda_function.py  # EventBridge / CloudTrail -> SQS
├── sql/
│   └── init/                   # 初始化表结构与后续增量 SQL
├── docker-compose.yml
├── Makefile
├── package.json
└── .env.example
```

---

## 快速启动

### 1. 准备环境变量

```bash
cp .env.example .env
```

至少确认这些值：

- `DATABASE_URL`
- `AWS_REGION`
- `SQS_QUEUE_URL`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`（如有）

> 当前本地 compose 默认通过 `.env` 给 API / ingest-worker / matcher-worker 提供 AWS 和数据库配置。

### 2. 启动整套服务

```bash
make up
```

或：

```bash
docker compose up -d --build
```

### 3. 初始化基础数据

```bash
make seed-all
```

这会执行：

- 初始化账号/区域
- 初始化资源类型/事件类型
- 初始化默认规则

### 4. 打开后台

- Web: <http://localhost:3000>
- API: <http://localhost:4000>
- Health: <http://localhost:4000/health>

---

## 常用命令

### Docker Compose

```bash
make up                 # 启动全部服务
make down               # 停止全部服务
make rebuild            # 重建并启动全部服务
make logs               # 查看全部日志
make logs-api           # API 日志
make logs-ingest        # ingest-worker 日志
make logs-matcher       # matcher-worker 日志
make ps                 # 查看容器状态
```

### Seed / Dashboard

```bash
make seed-accounts
make seed-catalog
make seed-default-rules
make seed-all
make dashboard-workers
make dashboard-queue
make dashboard-pipeline
```

### NPM Workspace

```bash
npm run compose:up
npm run compose:down
npm run compose:rebuild
npm run seed:all
npm run dashboard:workers
```

---

## Docker Compose 服务

### `postgres`

- 端口：`5433`
- 数据库：`soc_platform`
- 用户：`soc_admin`

### `api`

- 端口：`4000`
- 提供：
  - CRUD API
  - Dashboard API
  - seed API
  - SQS 队列观测 API

### `web`

- 端口：`3000`
- 提供管理后台页面

### `ingest-worker`

- 负责从 SQS 拉取事件并写入 `ingested_events`
- 会向 `worker_status` 写心跳

### `matcher-worker`

- 负责消费 `ingested_events`，做规则匹配并写 `alert_events`
- 命中后发送通知
- 会向 `worker_status` 写心跳

---

## 当前关键数据表

- `aws_accounts`
- `aws_regions`
- `resource_types`
- `event_types`
- `alert_rules`
- `notification_channels`
- `account_notification_routes`
- `ingested_events`
- `alert_events`
- `worker_status`

---

## 已支持的重点事件类型

### 安全组

- `CreateSecurityGroup`
- `DeleteSecurityGroup`
- `AuthorizeSecurityGroupIngress`
- `RevokeSecurityGroupIngress`
- `AuthorizeSecurityGroupEgress`
- `RevokeSecurityGroupEgress`

### 弹性网卡

- `CreateNetworkInterface`
- `CreateNetworkInterfacePermission`
- `DeleteNetworkInterface`
- `AttachNetworkInterface`
- `DetachNetworkInterface`
- `ModifyNetworkInterfaceAttribute`

### 弹性公网 IP

- `AllocateAddress`
- `ReleaseAddress`
- `AssociateAddress`
- `DisassociateAddress`

---

## Dashboard 当前可见内容

- worker 状态（ingest / matcher）
- SQS 可见积压 / in-flight / delayed
- 最近 5 分钟：
  - 采集吞吐
  - matcher 处理吞吐
  - 告警生成 / 发送情况
- 最近通知
- Top 账号 / Top 事件

---

## 适合下一阶段产品化的方向

1. 规则中心批量编辑 / 批量启停
2. Dashboard 趋势图 / 事件排行图
3. 通知路由完善到账号 / 项目 / 环境维度
4. EKS / IRSA 部署清单
5. 历史 CloudTrail Athena 查询入口
6. 更完整的网络类资源自动识别
7. 告警去重 / 抑制 / 升级策略

---

## 相关文档

- 架构：`docs/architecture.md`
- 运维说明：`docs/operations.md`
- EKS 部署：`docs/deployment-eks.md`
- EKS 清单：`k8s/eks/`
- API：`apps/api/README.md`
- Web：`apps/web/README.md`
- Ingest Worker：`apps/ingest-worker-go/README.md`
- Matcher Worker：`apps/matcher-worker-go/README.md`

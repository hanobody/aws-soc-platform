# AWS SOC Platform 架构说明

## 1. 当前系统目标

把 AWS 审计事件从 CloudTrail / EventBridge 稳定接入本地 SOC 系统，完成：

- 可靠采集
- 原始事件留存
- 规则匹配
- 告警事件生成
- 通知发送
- 后台可视化与运行状态观察

---

## 2. 当前落地架构

```text
CloudTrail / EventBridge
  -> Lambda Router (Python)
  -> SQS Standard Queue
  -> ingest-worker-go
  -> PostgreSQL.ingested_events
  -> matcher-worker-go
  -> PostgreSQL.alert_events
  -> Telegram
  -> Web Dashboard / Rule Center
```

---

## 3. 组件职责

### 3.1 Lambda Router

位置：`lambda/cloudtrail-event-router/lambda_function.py`

职责：

- 接收 EventBridge / CloudTrail 事件
- 标准化为统一 JSON 结构
- 投递到 SQS
- 可选：发送轻量 Telegram 调试消息

设计原则：

- Lambda 只负责轻逻辑转发
- 复杂匹配不放在 Lambda 里长期演进
- 把可靠性和可回放能力交给 SQS + 数据库

---

### 3.2 SQS

当前使用：**Standard Queue**

原因：

- CloudTrail 场景更看重吞吐与简单性
- 顺序不是核心需求
- 事件去重和幂等由系统内部处理

核心队列：

- `soc-cloudtrail-events`

---

### 3.3 ingest-worker-go

位置：`apps/ingest-worker-go`

职责：

- 长轮询 SQS
- 解析标准化事件
- 写入 `ingested_events`
- 基于 `dedup_key` 幂等去重
- 成功入库后删除 SQS 消息
- 定期写入 `worker_status`

特点：

- 只做可靠消费与入库
- 不承担规则匹配逻辑
- 后续迁移 EKS 时适合作为独立 Deployment

---

### 3.4 matcher-worker-go

位置：`apps/matcher-worker-go`

职责：

- 从 `ingested_events` 领取 `new / failed` 事件
- 按 `alert_rules` 做匹配
- 处理冷却时间 `cooldown_seconds`
- 写入 `alert_events`
- 按规则路由发送 Telegram 通知
- 回写事件处理状态
- 定期写入 `worker_status`

匹配策略：

- SQL 粗筛：`account_id + event_source + event_name`
- 内存细筛：
  - `region_code`
  - `resource_type`
  - `resource_pattern`
  - `user_arn_pattern`
  - `source_ip_pattern`
- 多条命中时按具体度排序，取最佳一条

---

### 3.5 PostgreSQL

当前承担：

- 配置中心
- 事件入站存储
- 告警事件存储
- worker 状态心跳

核心表：

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

### 3.6 Web Admin

位置：`apps/web`

当前页面：

- Dashboard
- 规则中心
- 通知渠道
- 告警事件
- 采集事件
- AWS 账号
- 区域
- 资源类型
- 事件类型

Dashboard 当前能力：

- worker 健康状态
- SQS 队列积压
- 最近 5 分钟吞吐
- 最近通知
- Top 账号 / Top 事件

---

## 4. 数据流细节

### 4.1 入站事件流

```text
AWS EventBridge
  -> Lambda Router
  -> SQS
  -> ingest-worker-go
  -> ingested_events
```

`ingested_events` 保留：

- 事件 ID
- 账号 / 区域
- 事件源 / 事件名
- 资源信息
- 操作人 / 来源 IP
- 原始 JSON
- 处理状态与错误信息

目的：

- 可审计
- 可回放
- 可二次匹配
- 可排查问题

### 4.2 告警匹配流

```text
ingested_events
  -> matcher-worker-go
  -> alert_rules lookup
  -> alert_events
  -> notification_channels / account_notification_routes
  -> Telegram
```

### 4.3 可观测性流

```text
ingest-worker / matcher-worker
  -> worker_status
  -> API /dashboard/workers
  -> Dashboard

API
  -> SQS GetQueueAttributes
  -> /dashboard/queue
  -> Dashboard

PostgreSQL
  -> /dashboard/pipeline
  -> Dashboard
```

---

## 5. 当前配置模型

### 5.1 规则

`alert_rules` 当前支持：

- 账号匹配（支持 `*`）
- 区域匹配（支持 `*`）
- 资源类型
- 事件名
- 资源模式匹配
- 用户 ARN 匹配
- 源 IP 匹配
- 风险等级
- 启用状态
- 冷却时间
- 通知路由

### 5.2 通知路由

优先级：

1. `alert_rules.notification_route_id`
2. `account_notification_routes.account_id`
3. 第一个启用的 `notification_channels`

当前方向：

- 逐步减少兜底发送
- 让规则与通知路由显式绑定更完整

---

## 6. 产品化方向

### 6.1 本地 Compose 阶段

目标：

- 一键启动全栈
- 管理后台可操作
- 支持真实 CloudTrail 流量
- 可视化看到 worker / 队列 / 吞吐

### 6.2 EKS 阶段

建议：

- `api` Deployment
- `web` Deployment
- `ingest-worker` Deployment
- `matcher-worker` Deployment
- PostgreSQL 迁移托管或外部 RDS
- 使用 IRSA，淘汰静态 AK/SK
- 默认不创建公网 Ingress，先走 `ClusterIP` + 内网访问 / `kubectl port-forward`

### 6.3 后续增强

- Dashboard 图表化
- 历史 Athena 查询
- 告警分派 / 处理流程
- 多渠道通知（不只 Telegram）
- 规则模板与批量运维

---

## 7. 为什么当前架构适合继续推进

因为它已经满足产品化最重要的几个基础：

- **链路清晰**：采集、入库、匹配、通知分层明确
- **可观测**：worker、队列、吞吐已有基础可视化
- **可扩展**：worker 已独立，适合迁移到 EKS
- **可运营**：后台已能直接配置规则、看事件、查告警
- **可审计**：原始事件和处理状态都保留下来了

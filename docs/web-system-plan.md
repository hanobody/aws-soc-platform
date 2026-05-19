# AWS SOC Platform Web System Plan

## 1. 目标定位

这是一个面向多 AWS 账号的轻量 SOC / 敏感变更通知后台，不是 SIEM 全量替代品，也不是传统工单流转式运维告警系统。

核心目标：

1. 统一管理多账号敏感资源变更通知规则
2. 控制哪些事件值得进入告警链路，降低 EventBridge / Lambda / 日志成本
3. 将命中规则的事件路由到 Telegram 等通知渠道
4. 保存通知事件元数据，支持查询、审计、追溯
5. 提供历史 CloudTrail 查询入口（Athena）

---

## 2. 当前已有基础

### 当前实时链路

```text
CloudTrail
  -> EventBridge
  -> security-central-bus
  -> Lambda Router
  -> Telegram
```

### 当前本地系统骨架

- Web Admin（Refine + Ant Design）
- API（Express + PostgreSQL）
- PostgreSQL 表：
  - `notification_channels`
  - `account_notification_routes`
  - `alert_rules`
  - `alert_events`

---

## 3. 现阶段架构问题

当前链路能跑，但有几个明显问题：

1. 进入 `security-central-bus` 的事件范围偏大
2. Lambda 可能在处理大量“无需报警”的常规事件
3. 规则配置在 Web 后台，但运行时规则引擎职责还没完全成型
4. 告警链路、事件入库、通知投递还没有彻底分层
5. 未来账号数量变多后，成本和噪音会同步上升

---

## 4. 推荐的职责分层

## 4.1 第一层：EventBridge 粗过滤

职责：只放“值得进入平台进一步判断”的事件。

建议：

- 主账号 `forward-main-cloudtrail-events`：先按服务维度缩小（例如先收 EC2）
- 子账号 forward rule：只转发重点服务、重点 API 事件
- `security-central-bus` 上的 rule：再按事件类别拆分投递目标

这一层的目标不是做复杂业务规则，而是：

- 降低进入中心总线的事件量
- 降低 Lambda 调用次数
- 降低 CloudWatch Logs 噪音
- 给后续规则引擎减压

---

## 4.2 第二层：Lambda 细过滤 / 规则执行

Lambda 不应该承担“所有逻辑都写死”的角色，而应该是运行时匹配执行器。

Lambda 职责建议：

1. 解析 CloudTrail 事件
2. 提取标准字段（账号、事件源、事件名、操作者、资源、源 IP、时间）
3. 根据账号和事件类型读取启用中的规则
4. 判断是否命中规则
5. 做 cooldown / 去重 / 忽略名单判断
6. 命中后写入 `alert_events`
7. 调用通知渠道发送通知

也就是说：

- **Web 后台** = 规则配置中心
- **Lambda** = 规则执行器
- **EventBridge** = 流量入口过滤器

---

## 4.3 第三层：通知层

建议将通知发送与规则判断逐步解耦。

推荐演进：

```text
EventBridge
  -> Rule Engine Lambda
  -> SQS
  -> Notify Lambda
  -> Telegram
```

好处：

- 降低单个 Lambda 复杂度
- 更容易做失败重试
- 便于支持多通知渠道
- 便于后续加节流、聚合、批量发送

---

## 5. Web 系统产品定位

这个 Web 系统建议定位成：

**多账号 AWS 敏感资源变更通知与规则管理平台**

不是做“全量日志平台”，而是做：

- 通知规则管理
- 通知路由管理
- 敏感事件通知查询
- 历史事件检索入口
- 账号与环境资产映射
- 后续可加处置闭环

---

## 6. 推荐的功能模块设计

## 6.1 Dashboard

用途：让用户一眼看到当前系统状态。

建议指标：

- 今日事件进入量
- 今日命中规则数
- 今日已发送告警数
- 各 severity 分布
- 各账号告警 Top N
- 各事件类型 Top N
- 通知发送成功率
- 当前启用规则数

后续可加：

- 最近 24h 趋势图
- 冷却拦截次数
- 被忽略事件数

---

## 6.2 规则中心（核心模块）

这是整个系统的核心。

当前表 `alert_rules` 还偏简单，建议未来增强为：

基础字段：

- 规则名称
- 启用状态
- 账号范围（单账号 / 多账号 / 全部）
- 服务（EC2 / IAM / S3 / KMS ...）
- 事件源（`ec2.amazonaws.com`）
- 事件名（支持单个或多个）
- 风险等级
- 描述
- cooldown 秒数

建议新增字段：

- 匹配模式（精确 / 通配 / 条件组）
- 资源类型
- 资源 ID / 标签过滤
- 操作者白名单
- 源 IP 白名单
- 环境范围（prod / staging / dev）
- 项目范围
- 忽略条件 JSON
- 聚合窗口
- 告警模板
- 默认通知路由

建议 UI：

- 列表页
- 新建 / 编辑页
- 启停开关
- 复制规则
- 测试匹配
- 最近命中次数

---

## 6.3 通知渠道

当前有 `notification_channels`，方向是对的。

建议支持：

- Telegram
- 企业微信 / Slack（后续）
- Webhook（后续）

建议字段增强：

- 渠道名称
- 渠道类型
- 凭据（加密存储）
- 目标 chat/group id
- 启用状态
- 发送模板
- 测试发送按钮
- 失败重试策略

注意：

- `bot_token` 不建议长期明文直出在前端
- 最好后端加密存储或接 Secrets Manager

---

## 6.4 账号路由

当前 `account_notification_routes` 也合理，但还可以增强。

建议用途：

- 定义“哪个账号 / 项目 / 环境”的告警默认发到哪里

建议字段增强：

- AWS Account ID
- 项目名
- 环境
- 默认通知渠道
- Owner / Team
- 备注
- 启用状态

后续可支持优先级：

- 规则指定渠道优先
- 若规则未指定，则走账号路由默认渠道

---

## 6.5 通知事件中心

当前 `alert_events` 是重要基础，它更适合被当作“通知事件留痕表”，而不是工单流转表。

建议它承担：

- 命中规则后的通知留痕
- 安全审计与回溯
- 检索与审计

建议字段增强：

- rule_id
- route_id
- channel_id
- dedup_key
- fingerprint
- notify_status
- notified_at
- delivery_status
- delivered_at
- delivery_error
- event_source
- actor_name
- aws_region

建议状态字段更偏投递语义，而不是工单语义：

- `new`
- `sent`
- `failed`
- `suppressed`

建议页面能力：

- 列表筛选
- 点开查看原始 JSON
- 查看命中规则
- 查看通知发送记录

---

## 6.6 历史查询入口（Athena）

这一块不要和实时告警混在一起。

建议定位为：

**历史追溯与调查入口**

建议功能：

- 预置查询模板
- 时间范围选择
- 账号 / 服务 / 事件名过滤
- SQL 只读执行
- 结果预览
- 导出 CSV

预置模板示例：

- 最近 24h Security Group 变更
- 最近 7d IAM 高危操作
- 某账号某时间段所有 ConsoleLogin
- 某资源相关操作轨迹

---

## 6.7 账号资产管理（建议新增）

这是你系统后面会越来越需要的模块。

建议建：

- `aws_accounts`
- `projects`
- `environments`
- `account_aliases`

用途：

- 给账号打标签
- 标识生产 / 测试
- 标识归属团队
- 给告警页面显示更友好的业务名称

不然以后所有地方都只显示 12 位 account id，会越来越难维护。

---

## 6.8 系统设置 / 审计日志（建议新增）

建议增加：

- 用户管理（接 Keycloak）
- RBAC 角色权限
- 配置变更审计
- 规则发布记录
- 渠道测试记录

因为这是安全运营后台，谁改了规则、谁关闭了告警、谁改了路由，这些都值得留痕。

---

## 7. 建议的数据模型演进

在当前四张表基础上，建议逐步扩展为：

### 基础配置类

- `aws_accounts`
- `notification_channels`
- `account_notification_routes`
- `alert_rules`

### 运行时类

- `alert_events`
- `alert_notifications`
- `rule_match_logs`
- `event_ingest_logs`

### 安全与运营类

- `users`
- `roles`
- `audit_logs`

其中优先级最高的是：

1. `alert_rules` 增强
2. `alert_events` 增强
3. 新增 `alert_notifications`
4. 新增 `aws_accounts`

---

## 8. 推荐 API 设计

### 配置类 API

- `GET /dashboard/stats`
- `GET /alert-rules`
- `POST /alert-rules`
- `PATCH /alert-rules/:id`
- `GET /notification-channels`
- `POST /notification-channels`
- `GET /account-routes`
- `POST /account-routes`
- `GET /aws-accounts`
- `POST /aws-accounts`

### 运行时 API

- `POST /ingest/cloudtrail`
- `POST /alerts/:id/ack`
- `POST /alerts/:id/resolve`
- `POST /alerts/:id/ignore`
- `GET /alerts/:id/raw`
- `POST /channels/:id/test`

### 查询类 API

- `POST /athena/query`
- `GET /athena/templates`

---

## 9. 推荐的前端页面结构

### 第一阶段页面

1. Dashboard
2. 规则中心
3. 通知渠道
4. 账号路由
5. 告警事件

### 第二阶段页面

6. AWS 账号管理
7. Athena 查询中心
8. 系统设置 / 用户权限
9. 审计日志

### 页面导航建议

```text
Dashboard
规则中心
告警事件
通知渠道
账号路由
AWS 账号
Athena 查询
系统设置
```

---

## 10. 推荐的技术落地方式

### 前端

当前选型：Refine + Ant Design

结论：

- **适合当前阶段继续用**
- 很适合快速做 CRUD 后台
- 后面可逐步在关键页面上做定制化

### 后端

当前：Express + PostgreSQL

结论：

- 作为 MVP 足够
- 后面如果规则逻辑复杂，可以拆 service 层，不必急着换框架

### 身份认证

建议：

- 本地先保留简单登录
- 正式环境接 Keycloak
- 通过角色区分只读 / 运维 / 管理员

---

## 11. 推荐的实施阶段

## Phase 1：把 MVP 做实

目标：可真实管理规则并看到事件。

交付：

- 完整 CRUD：规则 / 渠道 / 路由 / 告警事件
- Dashboard 基础统计
- `POST /ingest/cloudtrail` 入库
- Lambda 按规则命中后写入 `alert_events`
- 告警事件详情页可看原始 JSON

## Phase 2：把规则引擎做成型

目标：让“只有符合规则的才报警”真正成立。

交付：

- 规则匹配逻辑
- cooldown / dedup
- 默认路由与覆盖路由
- 渠道测试发送
- 告警状态流转

## Phase 3：把架构拆稳

目标：降低成本、提高可维护性。

交付：

- Rule Engine Lambda / Notify Lambda 拆分
- 接 SQS
- 失败重试
- 通知投递记录
- 基础监控

## Phase 4：调查与治理能力增强

目标：从“告警平台”变成“安全运营平台”。

交付：

- Athena 查询页
- 账号资产管理
- 审计日志
- Keycloak + RBAC
- Dashboard 趋势与报表

---

## 12. 最终建议

对于你当前这个项目，最正确的推进方向不是继续把所有逻辑堆进 Lambda，而是：

1. **先用 EventBridge 做粗过滤，减少进入系统的事件量**
2. **把 Web 后台做成真正的规则配置中心**
3. **让 Lambda 成为规则执行器，而不是硬编码逻辑中心**
4. **只对命中规则的事件告警，常规操作默认静默**
5. **把实时告警与历史查询分成两条链路**

这是目前最符合你整体思路、也最能兼顾成本、扩展性和落地速度的方案。

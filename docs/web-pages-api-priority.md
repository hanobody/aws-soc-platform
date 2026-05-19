# AWS SOC Platform - Web 页面/API/开发优先级

## 1. 页面清单

### P0：第一批必须做

#### 1. 登录页
用途：
- 本地临时登录
- 后续切 Keycloak SSO

功能：
- 登录按钮
- 当前环境说明
- 登录态检测
- 退出登录

#### 2. Dashboard
用途：总览系统状态。

建议内容：
- 今日进入事件数
- 今日命中规则数
- 今日已发送告警数
- 各 severity 数量
- 各账号告警 Top 5
- 各事件类型 Top 5
- 最近告警列表
- 通知发送成功/失败数量

#### 3. 规则中心列表页
字段：
- 规则名
- 账号范围
- 服务
- 事件名
- severity
- 默认通知路由
- cooldown
- enabled
- 最近命中次数
- 更新时间

操作：
- 搜索
- 筛选
- 启用/停用
- 新建
- 编辑
- 复制规则
- 删除

#### 4. 规则中心新建/编辑页
字段建议：
- 规则名称
- 启用状态
- 账号范围
- 项目
- 环境
- event_source
- event_name（支持多选）
- resource_type
- severity
- cooldown_seconds
- notification_route_id
- description
- 操作者白名单
- 源 IP 白名单
- 忽略条件 JSON
- 告警模板

#### 5. 通知渠道列表页
字段：
- 渠道名称
- 类型
- chat_id / target
- enabled
- 最近测试结果
- 更新时间

操作：
- 新建
- 编辑
- 启用/停用
- 测试发送
- 删除

#### 6. 通知渠道新建/编辑页
字段：
- 渠道名称
- 渠道类型
- bot token / webhook
- chat_id
- enabled
- 模板名称
- 备注

#### 7. 账号路由列表页
字段：
- account_id
- account_alias
- project_name
- environment
- 默认通知渠道
- enabled
- 更新时间

操作：
- 新建
- 编辑
- 删除
- 启用/停用

#### 8. 账号路由新建/编辑页
字段：
- account_id
- project_name
- environment
- channel_id
- enabled
- 备注

#### 9. 通知事件中心列表页
字段：
- 时间
- account_id
- 事件名
- severity
- resource_id
- user_arn
- source_ip
- 通知状态
- 命中规则

操作：
- 搜索
- 筛选
- 查看详情

#### 10. 通知事件详情页
内容：
- 基本信息
- 命中规则
- 路由结果
- 通知发送记录
- 原始 CloudTrail JSON
- 重新发送通知（后续）

### P1：第二批建议做
- AWS 账号管理
- Athena 查询中心
- 审计日志页
- 系统设置页

---

## 2. API 清单

### P0 必做 API

#### 基础
- `GET /health`

#### Dashboard
- `GET /dashboard/stats`
- `GET /dashboard/recent-alerts`
- `GET /dashboard/top-accounts`
- `GET /dashboard/top-events`
- `GET /dashboard/severity-distribution`

#### 规则中心
- `GET /alert-rules`
- `GET /alert-rules/:id`
- `POST /alert-rules`
- `PATCH /alert-rules/:id`
- `DELETE /alert-rules/:id`
- `POST /alert-rules/:id/toggle`
- `POST /alert-rules/:id/clone`
- `POST /alert-rules/test-match`

#### 通知渠道
- `GET /notification-channels`
- `GET /notification-channels/:id`
- `POST /notification-channels`
- `PATCH /notification-channels/:id`
- `DELETE /notification-channels/:id`
- `POST /notification-channels/:id/test`
- `POST /notification-channels/:id/toggle`

#### 账号路由
- `GET /account-routes`
- `GET /account-routes/:id`
- `POST /account-routes`
- `PATCH /account-routes/:id`
- `DELETE /account-routes/:id`
- `POST /account-routes/:id/toggle`

#### 告警事件
- `GET /alert-events`
- `GET /alert-events/:id`
- `GET /alert-events/:id/raw`

#### 运行时入站
- `POST /ingest/cloudtrail`

### P1 API
- `GET /aws-accounts`
- `POST /aws-accounts`
- `PATCH /aws-accounts/:id`
- `DELETE /aws-accounts/:id`
- `GET /athena/templates`
- `POST /athena/query`
- `GET /audit-logs`
- `GET /system-settings`
- `PATCH /system-settings`

---

## 3. 开发优先级

### Phase 1：先把可运营闭环做出来
1. 完善 CRUD：规则 / 渠道 / 路由 / 告警事件
2. 补告警事件详情页
3. 实现 `POST /ingest/cloudtrail`
4. Lambda / ingest 按规则命中后写库
5. Dashboard 做真实统计

### Phase 2：把规则引擎做成型
6. 规则匹配逻辑
7. cooldown / dedup
8. 通知渠道测试发送
9. 规则复制 / toggle / test-match

### Phase 3：把链路做稳
10. 拆 Rule Engine / Notify Worker
11. 引入 SQS
12. 发送记录表
13. 失败重试 / 死信

### Phase 4：补治理能力
14. AWS 账号管理
15. Athena 查询中心
16. 审计日志
17. Keycloak + RBAC

---

## 4. 当前建议的立即开工顺序
1. 告警事件详情页
2. `POST /ingest/cloudtrail`
3. 规则匹配逻辑 MVP
4. 通知测试接口
5. Dashboard 真实统计
6. 规则复制 / toggle / test-match
7. AWS 账号管理
8. Athena 查询页

---

## 5. 第一阶段目标闭环

第一阶段最重要的是这条链路跑通：

```text
配置规则 -> 事件进入 -> 命中判断 -> 写入告警 -> 发通知 -> 页面可查可处理
```

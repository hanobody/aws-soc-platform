# API

Node.js + Express API，当前不再是预留目录，已经承担系统核心控制面能力。

## 当前职责

- 基础配置 CRUD
- 规则中心 CRUD
- 采集事件查询
- 告警事件查询
- Dashboard 数据接口
- seed 初始化接口
- SQS 队列观测接口

## 主要接口

### 基础

- `GET /health`

### Dashboard

- `GET /dashboard/stats`
- `GET /dashboard/recent-alerts`
- `GET /dashboard/top-accounts`
- `GET /dashboard/top-events`
- `GET /dashboard/workers`
- `GET /dashboard/queue`
- `GET /dashboard/pipeline`

### 事件与告警

- `GET /ingested-events`
- `GET /ingested-events/:id`
- `GET /alert-events`
- `GET /alert-events/:id`
- `GET /alert-events/:id/raw`

### 规则中心 / 配置中心

- `GET/POST/PATCH/DELETE /aws-accounts`
- `GET/POST/PATCH/DELETE /aws-regions`
- `GET/POST/PATCH/DELETE /resource-types`
- `GET/POST/PATCH/DELETE /event-types`
- `GET/POST/PATCH/DELETE /alert-rules`
- `GET/POST/PATCH/DELETE /notification-channels`
- `GET/POST/PATCH/DELETE /account-routes`

### Seed

- `POST /seed/accounts-regions`
- `POST /seed/catalog`
- `POST /seed/default-rules`

## 本地运行

```bash
npm install
npm run start
```

开发模式：

```bash
npm run dev
```

默认端口：`4000`

## 依赖环境变量

- `PORT`
- `DATABASE_URL`
- `CORS_ORIGIN`
- `AWS_REGION`
- `SQS_QUEUE_URL`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`

## 说明

- API 容器现在也需要 AWS 凭证，因为 Dashboard 要读取 SQS 队列属性。
- worker 健康状态来自数据库表 `worker_status`，不是临时内存状态。

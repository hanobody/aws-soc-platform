# AWS SOC Platform 运行与运维说明

## 1. 本地启动

### 1.1 准备环境变量

```bash
cp .env.example .env
```

至少确认：

- `DATABASE_URL`
- `AWS_REGION`
- `SQS_QUEUE_URL`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`（如有）

### 1.2 启动全部服务

```bash
make up
```

或：

```bash
docker compose up -d --build
```

### 1.3 初始化基础数据

```bash
make seed-all
```

---

## 2. 常用访问地址

- Web: <http://localhost:3000>
- API: <http://localhost:4000>
- Health: <http://localhost:4000/health>
- Dashboard Workers: <http://localhost:4000/dashboard/workers>
- Dashboard Queue: <http://localhost:4000/dashboard/queue>
- Dashboard Pipeline: <http://localhost:4000/dashboard/pipeline>

---

## 3. Makefile 常用命令

```bash
make up
make down
make rebuild
make ps
make logs
make logs-api
make logs-web
make logs-ingest
make logs-matcher
make seed-accounts
make seed-catalog
make seed-default-rules
make seed-all
make dashboard-workers
make dashboard-queue
make dashboard-pipeline
```

---

## 4. Worker 状态排查

### 4.1 后台查看

进入 Dashboard 看：

- worker health
- worker status
- last heartbeat
- last message

### 4.2 命令查看

```bash
make dashboard-workers
make logs-ingest
make logs-matcher
```

### 4.3 健康状态含义

- `healthy`：45 秒内有心跳
- `stale`：45~120 秒没有更新
- `offline`：超过 120 秒没有更新

---

## 5. SQS 队列排查

### 5.1 看积压

```bash
make dashboard-queue
```

关注：

- `visible`
- `inFlight`
- `delayed`

### 5.2 常见判断

#### visible 持续升高
说明：

- ingest-worker 拉取不及
- 或 AWS 凭证异常导致消费失败

建议检查：

```bash
make logs-ingest
```

#### inFlight 很高但不下降
说明：

- worker 拿到消息但处理慢
- 或 delete message 失败

#### queue 接口报错
说明：

- API 容器缺 AWS 权限
- 或 `SQS_QUEUE_URL` / `AWS_REGION` 配置不对

---

## 6. 规则与事件排查

### 6.1 某条采集事件为什么没命中
看 `ingested_events`：

- `process_status`
- `process_error`
- `event_source`
- `event_name`
- `resource_type`

常见情况：

- `process_error = no_rule_matched`
  - 说明事件正常入库、matcher 正常处理
  - 只是没有对应规则

### 6.2 告警为什么没通知
看 `alert_events`：

- `alert_status`
- `notification_channel_id`
- `notification_error`
- `notified_at`

常见情况：

- `pending`
  - 有命中，但没找到通知渠道
- `notify_failed`
  - 找到渠道了，但发送失败
- `sent`
  - 已正常通知

---

## 7. 基础初始化

### 初始化账号/区域

```bash
make seed-accounts
```

### 初始化资源类型/事件类型

```bash
make seed-catalog
```

### 初始化默认规则

```bash
make seed-default-rules
```

### 全部执行

```bash
make seed-all
```

---

## 8. 当前关键配置文件

- `docker-compose.yml`
- `.env.example`
- `.env`（本地私有，不提交）
- `apps/api/server.js`
- `lambda/cloudtrail-event-router/lambda_function.py`
- `docs/deployment-eks.md`
- `k8s/eks/`

---

## 9. 日志建议

### API

```bash
make logs-api
```

### ingest worker

```bash
make logs-ingest
```

### matcher worker

```bash
make logs-matcher
```

### 全部

```bash
make logs
```

---

## 10. 产品化前建议

在继续往生产方向推进前，建议优先补：

1. EKS / IRSA 配置方案
2. API / web / worker 镜像版本化
3. 通知渠道与账号路由治理
4. Dashboard 图形化趋势图
5. 更完整的网络资源自动识别

# matcher-worker-go

负责从 `ingested_events` 领取待处理事件，按规则匹配并生成 `alert_events`，命中后发送通知。

## 职责

- 批量领取 `new / failed` 事件
- 规则缓存 + 精确匹配
- 支持 `cooldown_seconds`
- 写入 `alert_events`
- 发送 Telegram 通知
- 回写 `ingested_events.process_status / process_error`
- 维护 `worker_status` 心跳

## 环境变量

- `DATABASE_URL`
- `WORKER_NAME`（默认 `matcher-worker`）
- `MATCHER_BATCH_SIZE`（默认 `100`）
- `MATCHER_POLL_INTERVAL_MS`（默认 `3000`）
- `MATCHER_RULE_CACHE_TTL_SECONDS`（默认 `15`）
- `MATCHER_MAX_ATTEMPTS`（默认 `10`）
- `MATCHER_DEFAULT_SEVERITY`（默认 `medium`）

## 运行方式

### compose

默认随 `docker compose up -d` 一起启动。

### 单独本地运行

```bash
cd apps/matcher-worker-go
go run ./cmd/matcher
```

## 匹配优先级

1. SQL 按 `account_id + event_source + event_name` 粗筛
2. 内存进一步匹配：
   - `region_code`
   - `resource_type`
   - `resource_pattern`
   - `user_arn_pattern`
   - `source_ip_pattern`
3. 多条命中时按具体度取最佳一条

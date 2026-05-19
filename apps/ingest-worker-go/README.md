# ingest-worker-go

负责从 SQS 拉取 CloudTrail 标准化事件并写入 PostgreSQL `ingested_events`。

## 职责

- 长轮询 SQS
- 解析标准化事件 JSON
- 幂等入库 `ingested_events`
- 成功入库后删除 SQS 消息
- 维护 `worker_status` 心跳

## 默认值

- AWS Region: `ap-southeast-1`
- SQS Queue URL: `https://sqs.ap-southeast-1.amazonaws.com/809893975949/soc-cloudtrail-events`
- PostgreSQL: `postgresql://soc_admin:soc_dev_password@localhost:5433/soc_platform`

## 环境变量

- `AWS_REGION`
- `SQS_QUEUE_URL`
- `DATABASE_URL`
- `WORKER_NAME`（默认 `ingest-worker`）
- `SQS_MAX_MESSAGES`（默认 `10`）
- `SQS_WAIT_SECONDS`（默认 `20`）
- `SQS_VISIBILITY_TIMEOUT`（默认 `120`）

## 运行方式

### compose

默认随 `docker compose up -d` 一起启动。

### 单独本地运行

```bash
cd apps/ingest-worker-go
go run ./cmd/sqs-consumer
```

## IAM 权限

至少需要：

- `sqs:ReceiveMessage`
- `sqs:DeleteMessage`
- `sqs:ChangeMessageVisibility`
- `sqs:GetQueueAttributes`
- `sqs:GetQueueUrl`

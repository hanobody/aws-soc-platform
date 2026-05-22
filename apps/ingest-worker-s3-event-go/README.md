# ingest-worker-s3-event-go

负责从 `cloudtrail-object-created-queue` 这类 **S3 ObjectCreated 事件 SQS** 中拉取通知，再去 S3 读取实际的 CloudTrail `.json.gz` 文件，解析后在进程内直接完成**规则匹配 / 冷却判断 / 告警落库 / 通知发送**。

## 数据流

```text
S3 ObjectCreated
  -> SQS (cloudtrail-object-created-queue)
  -> ingest-worker-s3-event-go
  -> S3 GetObject (.json.gz)
  -> rule match / cooldown
  -> alert_events
  -> notify
```

## 职责

- 长轮询 SQS，接收 S3 ObjectCreated 通知
- 根据通知中的 bucket/key 下载 CloudTrail 日志文件
- 仅处理 `AWSLogs/<account>/CloudTrail/.../*.json.gz`，自动跳过 `CloudTrail-Digest/`
- 解压 `.json.gz` 并解析 `Records`
- 过滤 SOC 当前关注的事件范围
- 在 worker 内直接做规则匹配、冷却判断、告警入库与通知发送
- 成功处理后删除 SQS 消息
- 维护 `worker_status` 心跳

## 环境变量

- `AWS_REGION`
- `S3_OBJECT_CREATED_QUEUE_URL`
- `DATABASE_URL`
- `WORKER_NAME`（默认 `ingest-worker-s3-event`）
- `S3_EVENT_SQS_MAX_MESSAGES`（默认 `10`）
- `S3_EVENT_SQS_WAIT_SECONDS`（默认 `20`）
- `S3_EVENT_SQS_VISIBILITY_TIMEOUT`（默认 `300`）

## IAM 权限

至少需要：

- `sqs:ReceiveMessage`
- `sqs:DeleteMessage`
- `sqs:ChangeMessageVisibility`
- `sqs:GetQueueAttributes`
- `sqs:GetQueueUrl`
- `s3:GetObject`

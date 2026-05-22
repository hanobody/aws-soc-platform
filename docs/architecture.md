# Architecture

## Current flow

```text
S3 CloudTrail object
  -> S3 ObjectCreated
  -> SQS
  -> ingest-worker-s3-event-go
  -> match alert_rules
  -> write alert_events (matched only)
  -> send notification
```

## Important decisions

- `ingested_events` has been retired
- old `ingest-worker-go` and `matcher-worker-go` are removed
- `alert_events` is now the only event persistence table for live detections
- `alert_rules.notification_route_id` is required

## Main components

### API (`apps/api`)

Provides:
- dashboard
- settings
- resource CRUD
- seed endpoints
- auth/public settings

### Web (`apps/web`)

Provides:
- dashboard
- rules center
- notification channels
- settings
- CloudTrail SQL console

### Worker (`apps/ingest-worker-s3-event-go`)

Responsibilities:
- consume S3 ObjectCreated messages from SQS
- read CloudTrail `.json.gz` files from S3
- filter by configured ingest targets / event rules
- match alert rules
- write matched results to `alert_events`
- send notifications
- update `worker_status` and `ingest_worker_checkpoints`

## Core tables

- `alert_rules`
- `alert_events`
- `notification_channels`
- `account_notification_routes`
- `app_settings`
- `worker_status`
- `ingest_worker_checkpoints`

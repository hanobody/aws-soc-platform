# Operations

## Rollout status

```bash
export KUBECONFIG=/home/doctor/devops-doctor.kubeconfig
kubectl -n soc get deploy,pod,svc
kubectl -n soc rollout status deploy/aws-soc-api
kubectl -n soc rollout status deploy/aws-soc-web
kubectl -n soc rollout status deploy/aws-soc-ingest-worker-s3-event
```

## Logs

```bash
kubectl -n soc logs deploy/aws-soc-api --tail=200
kubectl -n soc logs deploy/aws-soc-web --tail=200
kubectl -n soc logs deploy/aws-soc-ingest-worker-s3-event --tail=200
```

## Quick checks

### API

```bash
kubectl -n soc port-forward svc/aws-soc-api 14000:4000
curl -s http://127.0.0.1:14000/health
curl -s http://127.0.0.1:14000/dashboard/workers
curl -s http://127.0.0.1:14000/settings/public
```

### Web

```bash
kubectl -n soc port-forward svc/aws-soc-web 13000:80
```

## Current data model rules

- only matched events are written to `alert_events`
- `alert_rules` must link to a notification route
- `ingested_events` is retired

## Cleanup / reset

When revalidating from scratch:
- clear `alert_events`
- keep catalogs/settings/rules/channels/routes
- verify worker continues writing fresh matched alerts

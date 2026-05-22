# k8s/eks

EKS manifests for the current SOC deployment.

## Included

- namespace
- configmap
- serviceaccounts
- API RBAC
- API deployment
- Web deployment
- ingest-worker-s3-event deployment
- services

## Excluded

- legacy `ingest-worker`
- legacy `matcher-worker`

Apply with:

```bash
kubectl apply -k k8s/eks
```

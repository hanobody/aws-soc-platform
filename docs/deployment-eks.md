# EKS Deployment

## Active manifests

```text
k8s/eks/
├── 00-namespace.yaml
├── 01-configmap.yaml
├── 03-serviceaccounts.yaml
├── 04-api-rbac.yaml
├── 10-api-deployment.yaml
├── 11-web-deployment.yaml
├── 14-ingest-worker-s3-event-deployment.yaml
├── 20-services.yaml
└── kustomization.yaml
```

## Images

Deploy these three images:
- API
- Web
- ingest-worker-s3-event

## Apply

```bash
export KUBECONFIG=/home/doctor/devops-doctor.kubeconfig
kubectl apply -k k8s/eks
```

## Verify

```bash
kubectl -n soc get deploy,pod,svc
kubectl -n soc rollout status deploy/aws-soc-api
kubectl -n soc rollout status deploy/aws-soc-web
kubectl -n soc rollout status deploy/aws-soc-ingest-worker-s3-event
```

## Notes

- default namespace: `soc`
- no legacy matcher deployment anymore
- runtime validation should happen against the cluster, not local compose

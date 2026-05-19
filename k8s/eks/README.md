# AWS SOC Platform on EKS

这套清单默认面向 **内部部署**：

- **不创建公网 Ingress**
- `web` / `api` 默认都是 `ClusterIP`
- 通过以下方式访问：
  - 集群内访问
  - VPN / 堡垒机后经内网访问
  - `kubectl port-forward`

## 目录

- `00-namespace.yaml`
- `01-configmap.yaml`
- `02-secrets.example.yaml`
- `03-serviceaccounts.yaml`
- `10-api-deployment.yaml`
- `11-web-deployment.yaml`
- `12-ingest-worker-deployment.yaml`
- `13-matcher-worker-deployment.yaml`
- `20-services.yaml`
- `kustomization.yaml`

## 部署前准备

### 1. 推送镜像到你的镜像仓库

把下面镜像名替换成你自己的：

- `your-registry/aws-soc-api:latest`
- `your-registry/aws-soc-web:latest`
- `your-registry/aws-soc-ingest-worker:latest`
- `your-registry/aws-soc-matcher-worker:latest`

### 2. 准备数据库

推荐：

- 使用 **RDS PostgreSQL**
- 不建议在这套 EKS 产品化清单里继续内嵌 Postgres

把 RDS 连接串写入 `DATABASE_URL`。

### 3. 配置 IRSA

当前建议：

- `api` ServiceAccount：允许 `sqs:GetQueueAttributes`
- `ingest-worker` ServiceAccount：允许
  - `sqs:ReceiveMessage`
  - `sqs:DeleteMessage`
  - `sqs:ChangeMessageVisibility`
  - `sqs:GetQueueAttributes`
  - `sqs:GetQueueUrl`

在 `03-serviceaccounts.yaml` 里把：

- `arn:aws:iam::<account-id>:role/aws-soc-api-irsa`
- `arn:aws:iam::<account-id>:role/aws-soc-ingest-irsa`

替换成真实 ARN。

## 部署

```bash
kubectl apply -k k8s/eks
```

## 验证

```bash
kubectl -n aws-soc get pods
kubectl -n aws-soc get svc
```

## 访问方式（无公网 Ingress）

### Web

```bash
kubectl -n aws-soc port-forward svc/aws-soc-web 3000:80
```

打开：

- <http://localhost:3000>

### API

```bash
kubectl -n aws-soc port-forward svc/aws-soc-api 4000:4000
```

打开：

- <http://localhost:4000/health>

## 说明

- 这套清单刻意 **不包含 Ingress**。
- 如果后续你需要内网 ALB，也建议单独补一份 `internal ingress` 清单，而不是默认暴露公网。

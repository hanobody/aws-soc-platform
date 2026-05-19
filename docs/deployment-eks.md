# AWS SOC Platform EKS 部署说明

## 目标

提供一套适合当前项目状态的 EKS 基线部署方式：

- API、Web、ingest-worker、matcher-worker 独立 Deployment
- 数据库使用外部 PostgreSQL / RDS
- API 与 ingest-worker 使用 IRSA 访问 AWS
- **默认不暴露公网 Ingress**
- Web / API 默认只通过 `ClusterIP` 提供服务

---

## 为什么默认不做公网 Ingress

当前项目还在产品化过程中，默认不直接暴露公网更稳：

- 后台是运维/安全控制面，不适合默认裸露到公网
- API 同时承担 Dashboard 队列观测能力
- worker / 数据链路更偏内部系统

所以这次补的 EKS YAML 设计是：

- **不创建 Ingress**
- **不创建 LoadBalancer Service**
- 默认只允许：
  - 集群内访问
  - `kubectl port-forward`
  - 后续你自己补内网入口

---

## 清单位置

```text
k8s/eks/
├── 00-namespace.yaml
├── 01-configmap.yaml
├── 02-secrets.example.yaml
├── 03-serviceaccounts.yaml
├── 10-api-deployment.yaml
├── 11-web-deployment.yaml
├── 12-ingest-worker-deployment.yaml
├── 13-matcher-worker-deployment.yaml
├── 20-services.yaml
└── kustomization.yaml
```

---

## 部署模型

### 1. api

- Deployment
- ServiceAccount with IRSA annotation placeholder
- Service: `ClusterIP`
- 读取：
  - `DATABASE_URL`
  - `AWS_REGION`
  - `SQS_QUEUE_URL`

### 2. web

- Deployment
- Service: `ClusterIP`
- 不暴露公网入口

### 3. ingest-worker

- 独立 Deployment
- 独立 ServiceAccount
- 通过 IRSA 访问 SQS

### 4. matcher-worker

- 独立 Deployment
- 当前主要依赖 PostgreSQL

---

## Secrets / ConfigMap

### ConfigMap

放非敏感配置：

- region
- queue url
- worker 参数
- CORS

### Secret

当前至少需要：

- `DATABASE_URL`

如果未来要把 Telegram 发送配置从 DB 外移，也可以继续加 Secret。

---

## IRSA 建议

### api role

至少允许：

- `sqs:GetQueueAttributes`

因为 Dashboard 会读取 SQS 积压状态。

### ingest-worker role

至少允许：

- `sqs:ReceiveMessage`
- `sqs:DeleteMessage`
- `sqs:ChangeMessageVisibility`
- `sqs:GetQueueAttributes`
- `sqs:GetQueueUrl`

---

## 部署步骤

### 1. 准备镜像

先把本地镜像推到仓库，并替换 Deployment 里的：

- `your-registry/aws-soc-api:latest`
- `your-registry/aws-soc-web:latest`
- `your-registry/aws-soc-ingest-worker:latest`
- `your-registry/aws-soc-matcher-worker:latest`

### 2. 准备 Secret

基于 `02-secrets.example.yaml` 生成真实 Secret，例如：

```bash
cp k8s/eks/02-secrets.example.yaml /tmp/aws-soc-secrets.yaml
# 修改 DATABASE_URL
kubectl apply -f /tmp/aws-soc-secrets.yaml
```

### 3. 修改 ServiceAccount 注解

把 `03-serviceaccounts.yaml` 中的 IRSA role ARN 换成真实值。

### 4. 部署

```bash
kubectl apply -k k8s/eks
```

---

## 访问方式

### Web

```bash
kubectl -n aws-soc port-forward svc/aws-soc-web 3000:80
```

### API

```bash
kubectl -n aws-soc port-forward svc/aws-soc-api 4000:4000
```

---

## 后续如果要补“内网入口”

建议单独补一份 internal-only 入口，不要改掉这份默认基线：

### 可选方案 A
- 内网 ALB Ingress（`alb.ingress.kubernetes.io/scheme: internal`）

### 可选方案 B
- 仅在公司 VPN 内暴露 NLB / PrivateLink

### 可选方案 C
- 完全不暴露，继续只用 port-forward / 跳板机

---

## 当前结论

这套 EKS YAML 已经符合你现在的要求：

- 有部署清单
- worker 独立 Deployment
- 不带公网 Ingress
- 默认不暴露公网
- 适合继续往产品化推进

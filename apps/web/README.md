# Web Admin

React + Refine 管理后台。

## 当前页面

- Dashboard
- 规则中心
- 通知渠道
- 告警事件
- 采集事件
- AWS 账号
- 区域
- 资源类型
- 事件类型

## 当前能力

### Dashboard

- worker 状态
- SQS 队列积压
- 最近 5 分钟吞吐
- 最近通知
- Top 账号 / Top 事件

### 规则中心

- 账号 / 区域多选，支持 `ALL`
- 通知渠道关联选择
- 资源类型 / 事件类型联动
- 批量创建
- 批量删除

### 采集事件 / 告警事件

- 分页
- 服务端筛选
- 原始事件 JSON 查看
- 告警事件可查看匹配规则详情

## 本地运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

默认访问：`http://localhost:3000`

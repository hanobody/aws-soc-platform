import { useEffect, useState } from "react";
import axios from "axios";
import { Row, Col, Card, Statistic, Typography, Button, Space, List, Tag, Table } from "antd";

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function compactS3TargetList(checkpoints) {
  if (!Array.isArray(checkpoints) || !checkpoints.length) return "-";
  return checkpoints.slice(0, 3).map((item) => item.targetKey).join(" · ") + (checkpoints.length > 3 ? ` +${checkpoints.length - 3}` : "");
}

export function DashboardPage({ apiUrl }) {
  const [stats, setStats] = useState({ awsAccounts: 0, awsRegions: 0, alertRules: 0, notificationChannels: 0, accountRoutes: 0, alertEvents: 0 });
  const [recentAlerts, setRecentAlerts] = useState([]);
  const [topAccounts, setTopAccounts] = useState([]);
  const [topEvents, setTopEvents] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [queue, setQueue] = useState({ ok: false, visible: 0, inFlight: 0, delayed: 0 });
  const [pipeline, setPipeline] = useState({ ingest: {}, matcher: {}, alerts: {}, timeline: [] });
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [{ data }, { data: recent }, { data: accounts }, { data: events }, { data: workerData }, { data: queueData }, { data: pipelineData }] = await Promise.all([
      axios.get(`${apiUrl}/dashboard/stats`),
      axios.get(`${apiUrl}/dashboard/recent-alerts`),
      axios.get(`${apiUrl}/dashboard/top-accounts`),
      axios.get(`${apiUrl}/dashboard/top-events`),
      axios.get(`${apiUrl}/dashboard/workers`),
      axios.get(`${apiUrl}/dashboard/queue`),
      axios.get(`${apiUrl}/dashboard/pipeline`)
    ]);
    setStats(data.data);
    setRecentAlerts(recent.data || []);
    setTopAccounts(accounts.data || []);
    setTopEvents(events.data || []);
    setWorkers(workerData.data || []);
    setQueue(queueData.data || {});
    setPipeline(pipelineData.data || { ingest: {}, matcher: {}, alerts: {}, timeline: [] });
    setLoading(false);
  };

  const workerTagColor = (health) => {
    if (health === "healthy") return "green";
    if (health === "stale") return "orange";
    return "red";
  };

  useEffect(() => {
    load();
  }, []);

  const seedCatalog = async () => {
    await axios.post(`${apiUrl}/seed/catalog`);
    await load();
  };

  const seedAccountsRegions = async () => {
    await axios.post(`${apiUrl}/seed/accounts-regions`);
    await load();
  };

  const seedDefaultRules = async () => {
    await axios.post(`${apiUrl}/seed/default-rules`);
    await load();
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Typography.Title level={2}>Dashboard</Typography.Title>
        <Typography.Paragraph type="secondary">这是本地 MVP，已经连到你本机 PostgreSQL。</Typography.Paragraph>
        <Space>
          <Button onClick={seedAccountsRegions}>初始化账号/区域</Button>
          <Button onClick={seedCatalog}>初始化当前范围资源/事件类型</Button>
          <Button onClick={seedDefaultRules}>初始化当前范围默认规则</Button>
        </Space>
      </div>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} xl={4}><Card loading={loading}><Statistic title="AWS账号" value={stats.awsAccounts} /></Card></Col>
        <Col xs={24} md={12} xl={4}><Card loading={loading}><Statistic title="区域" value={stats.awsRegions} /></Card></Col>
        <Col xs={24} md={12} xl={6}><Card loading={loading}><Statistic title="规则数量" value={stats.alertRules} /></Card></Col>
        <Col xs={24} md={12} xl={6}><Card loading={loading}><Statistic title="通知渠道" value={stats.notificationChannels} /></Card></Col>
        <Col xs={24} md={12} xl={6}><Card loading={loading}><Statistic title="账号路由" value={stats.accountRoutes} /></Card></Col>
        <Col xs={24} md={12} xl={6}><Card loading={loading}><Statistic title="通知记录" value={stats.alertEvents} /></Card></Col>
        <Col xs={24} md={12} xl={6}><Card loading={loading}><Statistic title="在线 Worker" value={workers.filter((item) => item.health === "healthy").length} suffix={`/ ${workers.length || 2}`} /></Card></Col>
        {queue.mode !== "s3" ? <Col xs={24} md={12} xl={6}><Card loading={loading}><Statistic title="SQS 可见积压" value={queue.visible ?? 0} /></Card></Col> : null}
        {queue.mode !== "s3" ? <Col xs={24} md={12} xl={6}><Card loading={loading}><Statistic title="SQS 处理中" value={queue.inFlight ?? 0} /></Card></Col> : null}
        <Col xs={24} md={12} xl={6}><Card loading={loading}><Statistic title="近 5 分钟采集" value={pipeline.ingest?.ingested_last_5m ?? 0} /></Card></Col>
        <Col xs={24} md={12} xl={6}><Card loading={loading}><Statistic title="近 5 分钟已发送告警" value={pipeline.alerts?.sent_last_5m ?? 0} /></Card></Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title="Worker 状态" loading={loading} extra={<Button size="small" onClick={load}>刷新</Button>}>
            <Table
              dataSource={workers}
              rowKey="worker_name"
              size="small"
              pagination={false}
              locale={{ emptyText: "暂无 Worker 状态" }}
              columns={[
                {
                  title: "Worker",
                  key: "worker_name",
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Space wrap>
                        <Typography.Text strong>{item.worker_name}</Typography.Text>
                        <Tag>{item.worker_type}</Tag>
                        <Tag color={workerTagColor(item.health)}>{item.health}</Tag>
                        <Tag>{item.status}</Tag>
                        {item.worker_type === "ingest-worker" && item.ingest_source_mode ? <Tag color="blue">mode:{item.ingest_source_mode}</Tag> : null}
                      </Space>
                      <Typography.Text type="secondary">最后心跳：{formatDateTime(item.last_heartbeat_at)} · 延迟 {item.stale_seconds ?? "-"} 秒</Typography.Text>
                    </Space>
                  )
                },
                {
                  title: "最近执行/Checkpoint",
                  key: "checkpoint",
                  width: 320,
                  render: (_, item) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text type="secondary">最近状态更新时间：{formatDateTime(item.updated_at)}</Typography.Text>
                      {item.ingest_source_mode === "s3" ? (
                        <>
                          <Typography.Text type="secondary">最近 checkpoint：{formatDateTime(item.s3_last_checkpoint_at)}</Typography.Text>
                          <Typography.Text type="secondary">目标范围：{compactS3TargetList(item.s3_checkpoints)}</Typography.Text>
                        </>
                      ) : (
                        <Typography.Text type="secondary">SQS 模式无 Athena checkpoint</Typography.Text>
                      )}
                    </Space>
                  )
                },
                {
                  title: "消息",
                  dataIndex: "last_message",
                  key: "last_message",
                  render: (value) => <Typography.Text type="secondary">{value || "-"}</Typography.Text>
                }
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="最近通知" loading={loading}>
            <List
              dataSource={recentAlerts}
              locale={{ emptyText: "暂无数据" }}
              renderItem={(item) => (
                <List.Item>
                  <Space direction="vertical" size={0}>
                    <Space>
                      <Typography.Text strong>{item.event_name}</Typography.Text>
                      <Tag>{item.account_id}</Tag>
                      <Tag color={item.severity === "critical" ? "red" : item.severity === "high" ? "orange" : item.severity === "medium" ? "blue" : "default"}>{item.severity}</Tag>
                    </Space>
                    <Typography.Text type="secondary">{new Date(item.event_time).toLocaleString()} · {item.alert_status}</Typography.Text>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card title="Top 账号" loading={loading}>
            <List
              dataSource={topAccounts}
              locale={{ emptyText: "暂无数据" }}
              renderItem={(item) => <List.Item>{item.account_id} · {item.count}</List.Item>}
            />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="Top 事件" loading={loading}>
            <List
              dataSource={topEvents}
              locale={{ emptyText: "暂无数据" }}
              renderItem={(item) => <List.Item>{item.event_name} · {item.count}</List.Item>}
            />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        {queue.mode !== "s3" ? <Col xs={24} xl={12}>
          <Card title="队列状态" loading={loading}>
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Space wrap>
                <Tag color={queue.ok ? "green" : "red"}>{queue.ok ? "queue ok" : "queue unavailable"}</Tag>
                {queue.queueUrl ? <Typography.Text copyable>{queue.queueUrl}</Typography.Text> : null}
              </Space>
              {queue.error ? <Typography.Text type="danger">{queue.error}</Typography.Text> : null}
              <Typography.Text type="secondary">延迟消息：{queue.delayed ?? 0}</Typography.Text>
              <Typography.Text type="secondary">队列最近配置更新时间：{queue.updatedAt ? new Date(queue.updatedAt).toLocaleString() : "-"}</Typography.Text>
            </Space>
          </Card>
        </Col> : null}
        <Col xs={24} xl={queue.mode === "s3" ? 24 : 12}>
          <Card title="近 5 分钟流水线概览" loading={loading}>
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Typography.Text>采集：{pipeline.ingest?.ingested_last_5m ?? 0}（近 1 分钟 {pipeline.ingest?.ingested_last_1m ?? 0}）</Typography.Text>
              <Typography.Text>Matcher 已处理：{pipeline.matcher?.processed_last_5m ?? 0}</Typography.Text>
              <Typography.Text>Matcher 失败：{pipeline.matcher?.failed_last_5m ?? 0}</Typography.Text>
              <Typography.Text>当前待处理：{pipeline.matcher?.pending_now ?? 0}</Typography.Text>
              <Typography.Text>告警生成：{pipeline.alerts?.alerts_last_5m ?? 0}</Typography.Text>
              <Typography.Text>告警发送失败：{pipeline.alerts?.notify_failed_last_5m ?? 0}</Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card title="分钟级吞吐（最近 5 分钟）" loading={loading}>
            <Table
              dataSource={pipeline.timeline || []}
              rowKey="minute"
              size="small"
              pagination={false}
              columns={[
                { title: "时间", dataIndex: "minute", key: "minute" },
                { title: "采集入库", dataIndex: "ingested", key: "ingested" },
                { title: "告警生成", dataIndex: "alerts", key: "alerts" },
                { title: "告警已发送", dataIndex: "sent", key: "sent" }
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

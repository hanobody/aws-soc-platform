import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { Button, Card, Descriptions, Space, Tag, Typography } from "antd";

function severityColor(value) {
  if (value === "critical") return "red";
  if (value === "high") return "orange";
  if (value === "medium") return "blue";
  return "default";
}

export function AlertEventDetailPage({ apiUrl }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [event, setEvent] = useState(null);
  const [raw, setRaw] = useState(null);

  const load = async () => {
    setLoading(true);
    const [{ data: detail }, { data: rawData }] = await Promise.all([
      axios.get(`${apiUrl}/alert-events/${id}`),
      axios.get(`${apiUrl}/alert-events/${id}/raw`)
    ]);
    setEvent(detail.data);
    setRaw(rawData.data?.raw_event_json ?? null);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [id]);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Space>
        <Button onClick={() => navigate("/alert-events")}>返回通知记录</Button>
      </Space>

      <Card title={`通知记录 #${id}`} loading={loading}>
        {event && (
          <Descriptions bordered column={2} size="small">
            <Descriptions.Item label="账号">{event.account_id}</Descriptions.Item>
            <Descriptions.Item label="区域">{event.region_code || "-"}</Descriptions.Item>
            <Descriptions.Item label="事件名">{event.event_name}</Descriptions.Item>
            <Descriptions.Item label="风险等级">
              <Tag color={severityColor(event.severity)}>{event.severity}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="通知状态">{event.alert_status}</Descriptions.Item>
            <Descriptions.Item label="失败原因">{event.notification_error || "-"}</Descriptions.Item>
            <Descriptions.Item label="资源 ID">{event.resource_id || "-"}</Descriptions.Item>
            <Descriptions.Item label="资源名称">{event.resource_name || "-"}</Descriptions.Item>
            <Descriptions.Item label="操作人 ARN">{event.user_arn || "-"}</Descriptions.Item>
            <Descriptions.Item label="源 IP">{event.source_ip || "-"}</Descriptions.Item>
            <Descriptions.Item label="发生时间" span={2}>{new Date(event.event_time).toLocaleString()}</Descriptions.Item>
            <Descriptions.Item label="创建时间" span={2}>{new Date(event.created_at).toLocaleString()}</Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      <Card title="原始 CloudTrail JSON" loading={loading}>
        <Typography.Paragraph>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {JSON.stringify(raw, null, 2)}
          </pre>
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}

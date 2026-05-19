import { useEffect, useState } from "react";
import { useNavigation } from "@refinedev/core";
import axios from "axios";
import { List } from "@refinedev/antd";
import { Table, Space, Button, Tag, Popconfirm, Typography, message, Form, Input, Select, Row, Col, Modal, Descriptions } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { resourceConfig } from "./resourceConfig";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export function ResourceListPage({ resource }) {
  const config = resourceConfig[resource];
  const { edit, create } = useNavigation();
  const [form] = Form.useForm();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState({});
  const [eventPreview, setEventPreview] = useState(null);
  const [rulePreview, setRulePreview] = useState(null);
  const [rulePreviewLoading, setRulePreviewLoading] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchUpdating, setBatchUpdating] = useState(false);
  const [api, contextHolder] = message.useMessage();
  const readOnlyResources = ["alert-events", "ingested-events"];
  const isIngestedEvents = resource === "ingested-events";
  const isAlertEvents = resource === "alert-events";
  const isAlertRules = resource === "alert-rules";
  const notificationErrorToastKey = "alert-notification-error-hover";

  const load = async () => {
    setLoading(true);
    const { data } = await axios.get(`${API_URL}/${resource}`, {
      params: { current, pageSize, ...filters }
    });
    setRows(data.data || []);
    setTotal(data.total || 0);
    setLoading(false);
  };

  useEffect(() => {
    setCurrent(1);
    setPageSize(20);
    setFilters({});
    setEventPreview(null);
    setRulePreview(null);
    setSelectedRowKeys([]);
    form.resetFields();
  }, [resource]);

  useEffect(() => {
    load();
  }, [resource, current, pageSize, filters]);

  const deleteOne = async (id) => {
    await axios.delete(`${API_URL}/${resource}/${id}`);
    api.success("删除成功");
    await load();
  };

  const deleteSelected = async () => {
    if (!selectedRowKeys.length) return;
    const selectedRows = rows.filter((row) => selectedRowKeys.includes(row.id));
    const deletableIds = isAlertRules ? selectedRows.filter((row) => !row.is_default).map((row) => row.id) : selectedRowKeys;
    if (!deletableIds.length) {
      api.warning("已选规则都是默认规则，不能删除；可改为批量禁用。");
      return;
    }
    setBatchDeleting(true);
    try {
      await Promise.all(deletableIds.map((id) => axios.delete(`${API_URL}/${resource}/${id}`)));
      api.success(`已批量删除 ${deletableIds.length} 条规则${deletableIds.length !== selectedRowKeys.length ? '（默认规则已自动跳过）' : ''}`);
      setSelectedRowKeys([]);
      await load();
    } catch (error) {
      api.error(error?.response?.data?.message || "批量删除失败");
    } finally {
      setBatchDeleting(false);
    }
  };

  const bulkDisableSelected = async () => {
    if (!selectedRowKeys.length) return;
    setBatchUpdating(true);
    try {
      const { data } = await axios.post(`${API_URL}/alert-rules/bulk-update`, {
        ids: selectedRowKeys,
        patch: { enabled: false }
      });
      api.success(`已批量禁用 ${data.updated || selectedRowKeys.length} 条规则`);
      setSelectedRowKeys([]);
      await load();
    } catch (error) {
      api.error(error?.response?.data?.message || "批量禁用失败");
    } finally {
      setBatchUpdating(false);
    }
  };

  const bulkEnableSelected = async () => {
    if (!selectedRowKeys.length) return;
    setBatchUpdating(true);
    try {
      const { data } = await axios.post(`${API_URL}/alert-rules/bulk-update`, {
        ids: selectedRowKeys,
        patch: { enabled: true }
      });
      api.success(`已批量启用 ${data.updated || selectedRowKeys.length} 条规则`);
      setSelectedRowKeys([]);
      await load();
    } catch (error) {
      api.error(error?.response?.data?.message || "批量启用失败");
    } finally {
      setBatchUpdating(false);
    }
  };

  const openRulePreview = async (recordOrRuleId) => {
    const record = typeof recordOrRuleId === "object" && recordOrRuleId !== null ? recordOrRuleId : null;
    const ruleId = record ? record.matched_rule_id : recordOrRuleId;
    const snapshot = record?.matched_rule_snapshot_json || null;

    if (!ruleId && snapshot) {
      setRulePreview({ ...snapshot, snapshot_only: true });
      return;
    }
    if (!ruleId) return;

    setRulePreviewLoading(true);
    setRulePreview(snapshot ? { ...snapshot, id: ruleId, snapshot_only: true } : { id: ruleId });
    try {
      const { data } = await axios.get(`${API_URL}/alert-rules/${ruleId}`);
      setRulePreview(data.data || (snapshot ? { ...snapshot, id: ruleId, snapshot_only: true } : { id: ruleId }));
    } catch (error) {
      if (snapshot) {
        setRulePreview({ ...snapshot, id: ruleId, snapshot_only: true });
      } else {
        api.error(error?.response?.data?.message || "规则详情加载失败");
        setRulePreview(null);
      }
    } finally {
      setRulePreviewLoading(false);
    }
  };

  const renderCell = (column, value, record) => {
    if (column.key === "event_id" && value && (isIngestedEvents || isAlertEvents)) {
      return (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setEventPreview(record)}>
          {value}
        </Button>
      );
    }
    if (column.key === "matched_rule_name" && value && isAlertEvents) {
      return (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => openRulePreview(record)}>
          {value}
        </Button>
      );
    }
    if (column.key === "is_default") {
      return value ? <Tag color="gold">默认规则</Tag> : <Tag color="blue">自定义规则</Tag>;
    }
    if (typeof value === "boolean") return value ? <Tag color="green">是</Tag> : <Tag>否</Tag>;
    if (column.key === "severity" && value) return <Tag color={value === "critical" ? "red" : value === "high" ? "orange" : value === "medium" ? "blue" : "default"}>{value}</Tag>;
    if (column.key === "alert_status" && value) {
      const color = value === "sent" ? "green" : value === "notify_failed" ? "red" : value === "pending" ? "orange" : "default";
      if (value === "notify_failed" && record?.notification_error) {
        return (
          <span
            onMouseEnter={() => {
              api.open({
                key: notificationErrorToastKey,
                type: "error",
                duration: 0,
                content: record.notification_error
              });
            }}
            onMouseLeave={() => api.destroy(notificationErrorToastKey)}
          >
            <Tag color={color} style={{ cursor: "pointer" }}>{value}</Tag>
          </span>
        );
      }
      return <Tag color={color}>{value}</Tag>;
    }
    if ((column.key === "event_time" || column.key === "created_at" || column.key === "updated_at" || column.key === "notified_at") && value) return <Typography.Text>{new Date(value).toLocaleString()}</Typography.Text>;
    if (column.key === "raw_event_json" && value) return <Typography.Text code>{JSON.stringify(value)}</Typography.Text>;
    return <span>{String(value ?? "")}</span>;
  };

  const buildFilters = (values) => Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
  );

  const ingestedFilterBlock = isIngestedEvents ? (
    <Form
      form={form}
      layout="vertical"
      onFinish={(values) => {
        setCurrent(1);
        setFilters(buildFilters(values));
      }}
    >
      <Row gutter={12}>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="eventId" label="事件 ID"><Input allowClear placeholder="按事件 ID 查询" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="eventName" label="事件名"><Input allowClear placeholder="如 DeleteSecurityGroup / AssumeRole / RunInstances" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="awsAccountId" label="账号"><Input allowClear placeholder="精确匹配 AWS Account ID" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="awsRegion" label="区域"><Input allowClear placeholder="精确匹配区域，如 ap-southeast-1" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="resourceId" label="资源 ID"><Input allowClear placeholder="如 sg-xxxx / i-xxxx / arn:aws:iam::...:role/..." /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="actorArn" label="操作人"><Input allowClear placeholder="模糊搜索 ARN / 用户" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="sourceIp" label="源 IP"><Input allowClear placeholder="模糊搜索源 IP" /></Form.Item></Col>
        <Col xs={24} style={{ display: "flex", alignItems: "end", gap: 8 }}>
          <Button type="primary" htmlType="submit">查询</Button>
          <Button onClick={() => { form.resetFields(); setCurrent(1); setFilters({}); }}>重置</Button>
        </Col>
      </Row>
    </Form>
  ) : null;

  const alertFilterBlock = isAlertEvents ? (
    <Form
      form={form}
      layout="vertical"
      onFinish={(values) => {
        setCurrent(1);
        setFilters(buildFilters(values));
      }}
    >
      <Row gutter={12}>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="eventId" label="事件 ID"><Input allowClear placeholder="按事件 ID 查询" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="eventName" label="事件名"><Input allowClear placeholder="如 DeleteSecurityGroup / AssumeRole / RunInstances" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="awsAccountId" label="账号"><Input allowClear placeholder="精确匹配 AWS Account ID" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="awsRegion" label="区域"><Input allowClear placeholder="精确匹配区域，如 ap-southeast-1" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="resourceId" label="资源 ID"><Input allowClear placeholder="如 sg-xxxx / i-xxxx / arn:aws:iam::...:role/..." /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="ruleName" label="匹配规则"><Input allowClear placeholder="模糊搜索规则名" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="actorArn" label="操作人"><Input allowClear placeholder="模糊搜索 ARN / 用户" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="sourceIp" label="源 IP"><Input allowClear placeholder="模糊搜索源 IP" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}>
          <Form.Item name="alertStatus" label="通知状态">
            <Select allowClear placeholder="选择通知状态" options={[{ value: "new", label: "new" }, { value: "pending", label: "pending" }, { value: "sent", label: "sent" }, { value: "notify_failed", label: "notify_failed" }]} />
          </Form.Item>
        </Col>
        <Col xs={24} style={{ display: "flex", alignItems: "end", gap: 8 }}>
          <Button type="primary" htmlType="submit">查询</Button>
          <Button onClick={() => { form.resetFields(); setCurrent(1); setFilters({}); }}>重置</Button>
        </Col>
      </Row>
    </Form>
  ) : null;

  const alertRulesFilterBlock = resource === "alert-rules" ? (
    <Form
      form={form}
      layout="vertical"
      onFinish={(values) => {
        setCurrent(1);
        setFilters(buildFilters(values));
      }}
    >
      <Row gutter={12}>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="ruleName" label="规则名称"><Input allowClear placeholder="模糊搜索规则名" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="accountId" label="账号"><Input allowClear placeholder="精确匹配账号 ID / *" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="regionCode" label="区域"><Input allowClear placeholder="精确匹配区域 / *" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="eventName" label="事件名"><Input allowClear placeholder="如 DeleteSecurityGroup / AssumeRole / RunInstances" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="eventSource" label="事件源"><Input allowClear placeholder="如 ec2.amazonaws.com" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="resourceType" label="资源类型"><Input allowClear placeholder="如 security-group / ec2-instance / iam-role" /></Form.Item></Col>
        <Col xs={24} sm={12} md={8} lg={6}><Form.Item name="isDefault" label="规则来源"><Select allowClear options={[{ value: "true", label: "默认规则" }, { value: "false", label: "自定义规则" }]} /></Form.Item></Col>
        <Col xs={24} style={{ display: "flex", alignItems: "end", gap: 8 }}>
          <Button type="primary" htmlType="submit">查询</Button>
          <Button onClick={() => { form.resetFields(); setCurrent(1); setFilters({}); }}>重置</Button>
        </Col>
      </Row>
    </Form>
  ) : null;

  const filterBlock = ingestedFilterBlock || alertFilterBlock || alertRulesFilterBlock;
  const visibleColumns = isAlertRules
    ? config.columns.filter((column) => column.key !== "is_default")
    : config.columns;

  const headerButtons = () => {
    if (readOnlyResources.includes(resource)) return null;

    return (
      <Space>
        {isAlertRules ? (
          <>
            <Button onClick={bulkEnableSelected} disabled={!selectedRowKeys.length} loading={batchUpdating}>
              批量启用{selectedRowKeys.length ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Button onClick={bulkDisableSelected} disabled={!selectedRowKeys.length} loading={batchUpdating}>
              批量禁用{selectedRowKeys.length ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Popconfirm
              title={`确认批量删除已勾选的 ${selectedRowKeys.length} 条规则？`}
              description="默认规则不可删除；仅会删除自定义规则。"
              onConfirm={deleteSelected}
              okButtonProps={{ danger: true, loading: batchDeleting }}
              disabled={!selectedRowKeys.length}
            >
              <Button danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length} loading={batchDeleting}>
                批量删除{selectedRowKeys.length ? ` (${selectedRowKeys.length})` : ""}
              </Button>
            </Popconfirm>
          </>
        ) : null}
        <Button type="primary" icon={<PlusOutlined />} onClick={() => create(resource)}>新建</Button>
      </Space>
    );
  };

  return (
    <>
      {contextHolder}
      <List title={config.title} headerButtons={headerButtons}>
        {isAlertRules ? (
          <style>{`
            .alert-rules-row-default > td {
              background: #fff7e6 !important;
            }
            .alert-rules-row-custom > td {
              background: #f0f5ff !important;
            }
          `}</style>
        ) : null}
        {filterBlock}
        <Table
          dataSource={rows}
          loading={loading}
          rowKey="id"
          rowSelection={isAlertRules ? {
            selectedRowKeys,
            onChange: setSelectedRowKeys,
            preserveSelectedRowKeys: false
          } : undefined}
          rowClassName={isAlertRules ? (record) => (record?.is_default ? "alert-rules-row-default" : "alert-rules-row-custom") : undefined}
          scroll={{ x: true }}
          pagination={{
            current,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 条`,
            onChange: (page, size) => {
              setCurrent(page);
              setPageSize(size);
            }
          }}
        >
          {visibleColumns.map((column) => (
            <Table.Column
              key={column.key}
              dataIndex={column.key}
              title={column.title}
              render={(value, record) => renderCell(column, value, record)}
            />
          ))}
          {!readOnlyResources.includes(resource) ? (
            <Table.Column
              key="actions"
              title="操作"
              render={(_, record) => (
                <Space>
                  <Button size="small" onClick={() => edit(resource, record.id)}>编辑</Button>
                  {!(isAlertRules && record.is_default) ? (
                    <Popconfirm title="确认删除？" onConfirm={() => deleteOne(record.id)}>
                      <Button size="small" danger>删除</Button>
                    </Popconfirm>
                  ) : null}
                </Space>
              )}
            />
          ) : null}
        </Table>
      </List>

      <Modal
        title={eventPreview?.event_id ? `事件原文 · ${eventPreview.event_id}` : "事件原文"}
        open={!!eventPreview}
        onCancel={() => setEventPreview(null)}
        footer={<Button onClick={() => setEventPreview(null)}>关闭</Button>}
        width={960}
      >
        <Typography.Paragraph copyable style={{ marginBottom: 12 }}>
          {eventPreview?.event_id || ""}
        </Typography.Paragraph>
        <pre style={{ maxHeight: 560, overflow: "auto", margin: 0, padding: 12, background: "#f7f7f7", borderRadius: 8 }}>
{JSON.stringify(eventPreview?.raw_event_json ?? {}, null, 2)}
        </pre>
      </Modal>

      <Modal
        title={rulePreview?.rule_name ? `规则详情 · ${rulePreview.rule_name}${rulePreview?.snapshot_only ? "（快照）" : ""}` : "规则详情"}
        open={!!rulePreview}
        onCancel={() => setRulePreview(null)}
        footer={<Button onClick={() => setRulePreview(null)}>关闭</Button>}
        width={900}
      >
        <Descriptions bordered column={2} size="small">
          <Descriptions.Item label="规则名称">{rulePreview?.rule_name || "-"}</Descriptions.Item>
          <Descriptions.Item label="规则 ID">{rulePreview?.id || "-"}</Descriptions.Item>
          <Descriptions.Item label="账号">{rulePreview?.account_id || "-"}</Descriptions.Item>
          <Descriptions.Item label="区域">{rulePreview?.region_code || "-"}</Descriptions.Item>
          <Descriptions.Item label="事件源">{rulePreview?.event_source || "-"}</Descriptions.Item>
          <Descriptions.Item label="事件名">{rulePreview?.event_name || "-"}</Descriptions.Item>
          <Descriptions.Item label="资源类型">{rulePreview?.resource_type || "-"}</Descriptions.Item>
          <Descriptions.Item label="风险等级">{rulePreview?.severity || "-"}</Descriptions.Item>
          <Descriptions.Item label="启用">{rulePreview?.enabled ? "是" : "否"}</Descriptions.Item>
          <Descriptions.Item label="静默期秒数">{rulePreview?.cooldown_seconds ?? 0}</Descriptions.Item>
          <Descriptions.Item label="资源匹配" span={2}>{rulePreview?.resource_pattern || "-"}</Descriptions.Item>
          <Descriptions.Item label="用户 ARN 匹配" span={2}>{rulePreview?.user_arn_pattern || "-"}</Descriptions.Item>
          <Descriptions.Item label="源 IP 匹配" span={2}>{rulePreview?.source_ip_pattern || "-"}</Descriptions.Item>
          <Descriptions.Item label="说明" span={2}>{rulePreview?.description || "-"}</Descriptions.Item>
        </Descriptions>
      </Modal>
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message
} from "antd";
import { DeleteOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";

const { TextArea } = Input;
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

const templateTypeOptions = [
  { label: "系统", value: "system" },
  { label: "个人", value: "personal" },
  { label: "共享", value: "shared" }
];

function statusTag(status) {
  if (status === "SUCCEEDED") return <Tag color="green">SUCCEEDED</Tag>;
  if (status === "FAILED") return <Tag color="red">FAILED</Tag>;
  if (status === "RUNNING") return <Tag color="blue">RUNNING</Tag>;
  if (status === "CANCELLED") return <Tag color="orange">CANCELLED</Tag>;
  return <Tag>QUEUED</Tag>;
}

export function CloudTrailSqlConsolePage() {
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [sqlText, setSqlText] = useState("");
  const [queryName, setQueryName] = useState("");
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [resultColumns, setResultColumns] = useState([]);
  const [resultRows, setResultRows] = useState([]);
  const [resultLoading, setResultLoading] = useState(false);
  const [resultError, setResultError] = useState("");
  const [activeQuery, setActiveQuery] = useState(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveMode, setSaveMode] = useState("create");
  const [submitting, setSubmitting] = useState(false);
  const [saveForm] = Form.useForm();
  const [api, contextHolder] = message.useMessage();

  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === selectedTemplateId) || null,
    [templates, selectedTemplateId]
  );

  const loadTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const { data } = await axios.get(`${API_URL}/cloudtrail-sql-templates`, { params: { current: 1, pageSize: 200 } });
      setTemplates(data.data || []);
      if (!selectedTemplateId && data.data?.length) {
        const first = data.data[0];
        setSelectedTemplateId(first.id);
        setSqlText(first.sql_text || "");
      }
    } catch (error) {
      api.error(error?.response?.data?.message || "模板加载失败");
    } finally {
      setTemplatesLoading(false);
    }
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const { data } = await axios.get(`${API_URL}/cloudtrail-sql-queries`, { params: { current: 1, pageSize: 20 } });
      setHistory(data.data || []);
    } catch (error) {
      api.error(error?.response?.data?.message || "查询历史加载失败");
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    loadTemplates();
    loadHistory();
  }, []);

  useEffect(() => {
    if (!selectedTemplate) return;
    setSqlText(selectedTemplate.sql_text || "");
  }, [selectedTemplateId]);

  const handleSelectTemplate = (template) => {
    setSelectedTemplateId(template.id);
    setSqlText(template.sql_text || "");
    setQueryName(template.name || "");
  };

  const handleNew = () => {
    setSelectedTemplateId(null);
    setSqlText("");
    setQueryName("");
    setResultColumns([]);
    setResultRows([]);
    setResultError("");
    setActiveQuery(null);
  };

  const openSaveModal = (mode) => {
    setSaveMode(mode);
    saveForm.setFieldsValue({
      name: mode === "update" ? selectedTemplate?.name : "",
      description: mode === "update" ? selectedTemplate?.description : "",
      category: mode === "update" ? selectedTemplate?.category : "cloudtrail",
      template_type: mode === "update" ? selectedTemplate?.template_type : "personal",
      template_code: mode === "update" ? selectedTemplate?.template_code : "",
      is_active: mode === "update" ? selectedTemplate?.is_active : true
    });
    setSaveModalOpen(true);
  };

  const handleSaveTemplate = async () => {
    const values = await saveForm.validateFields();
    if (!sqlText.trim()) {
      api.error("请先输入 SQL");
      return;
    }

    setSubmitting(true);
    try {
      if (saveMode === "update" && selectedTemplateId) {
        const { data } = await axios.patch(`${API_URL}/cloudtrail-sql-templates/${selectedTemplateId}`, {
          ...values,
          sql_text: sqlText,
          updated_by: "web"
        });
        api.success("模板已更新");
        setSelectedTemplateId(data.data.id);
      } else {
        const { data } = await axios.post(`${API_URL}/cloudtrail-sql-templates`, {
          ...values,
          sql_text: sqlText,
          created_by: "web",
          updated_by: "web"
        });
        api.success("模板已创建");
        setSelectedTemplateId(data.data.id);
      }
      setSaveModalOpen(false);
      await loadTemplates();
    } catch (error) {
      api.error(error?.response?.data?.message || "模板保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteTemplate = async (id) => {
    try {
      await axios.delete(`${API_URL}/cloudtrail-sql-templates/${id}`);
      api.success("模板已删除");
      if (selectedTemplateId === id) {
        handleNew();
      }
      await loadTemplates();
    } catch (error) {
      api.error(error?.response?.data?.message || "模板删除失败");
    }
  };

  const handleRunQuery = async () => {
    if (!sqlText.trim()) {
      api.error("SQL 不能为空");
      return;
    }

    setSubmitting(true);
    setResultError("");
    setResultLoading(true);
    setResultRows([]);
    setResultColumns([]);

    try {
      const { data } = await axios.post(`${API_URL}/cloudtrail-sql-queries/execute`, {
        templateId: selectedTemplateId,
        queryName: queryName || selectedTemplate?.name || null,
        sqlText,
        isEdited: !!selectedTemplate && sqlText.trim() !== String(selectedTemplate.sql_text || "").trim(),
        createdBy: "web"
      });

      const query = data.data;
      setActiveQuery(query);
      api.success("查询已提交，正在等待 Athena 执行");

      let status = query.status;
      let attempts = 0;
      while (["QUEUED", "RUNNING"].includes(status) && attempts < 60) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResp = await axios.get(`${API_URL}/cloudtrail-sql-queries/${query.query_id}`);
        status = statusResp.data.data.status;
        setActiveQuery(statusResp.data.data);
        attempts += 1;
      }

      if (status !== "SUCCEEDED") {
        const latest = await axios.get(`${API_URL}/cloudtrail-sql-queries/${query.query_id}`);
        const messageText = latest.data.data.error_message || `查询状态：${latest.data.data.status}`;
        setResultError(messageText);
        api.error(messageText);
      } else {
        const resultResp = await axios.get(`${API_URL}/cloudtrail-sql-queries/${query.query_id}/results`, { params: { maxResults: 200 } });
        setResultColumns(resultResp.data.data.columns || []);
        setResultRows((resultResp.data.data.items || []).map((item, index) => ({ key: index, ...item })));
        api.success(`查询完成，返回 ${resultResp.data.data.items?.length || 0} 行`);
      }

      await loadHistory();
    } catch (error) {
      const messageText = error?.response?.data?.message || "查询执行失败";
      setResultError(messageText);
      api.error(messageText);
    } finally {
      setSubmitting(false);
      setResultLoading(false);
    }
  };

  const handleLoadHistoryResult = async (record) => {
    setActiveQuery(record);
    setResultError("");
    if (record.status !== "SUCCEEDED") {
      try {
        const { data } = await axios.get(`${API_URL}/cloudtrail-sql-queries/${record.query_id}`);
        setActiveQuery(data.data);
        setResultError(data.data.error_message || `当前状态：${data.data.status}`);
        await loadHistory();
      } catch (error) {
        api.error(error?.response?.data?.message || "状态刷新失败");
      }
      return;
    }

    setResultLoading(true);
    try {
      const { data } = await axios.get(`${API_URL}/cloudtrail-sql-queries/${record.query_id}/results`, { params: { maxResults: 200 } });
      setResultColumns(data.data.columns || []);
      setResultRows((data.data.items || []).map((item, index) => ({ key: index, ...item })));
    } catch (error) {
      setResultError(error?.response?.data?.message || "结果加载失败");
    } finally {
      setResultLoading(false);
    }
  };

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Row gutter={16} align="stretch">
          <Col xs={24} lg={6}>
            <Card
              title="SQL 模板"
              extra={<Button icon={<ReloadOutlined />} onClick={loadTemplates}>刷新</Button>}
              styles={{ body: { padding: 12 } }}
            >
              <Space style={{ marginBottom: 12 }}>
                <Button type="primary" icon={<PlusOutlined />} onClick={handleNew}>空白 SQL</Button>
              </Space>
              <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden" }}>
                <Table
                  rowKey="id"
                  size="small"
                  loading={templatesLoading}
                  dataSource={templates}
                  pagination={false}
                  onRow={(record) => ({ onClick: () => handleSelectTemplate(record) })}
                  rowClassName={(record) => (record.id === selectedTemplateId ? "ant-table-row-selected" : "")}
                  columns={[
                    {
                      title: "模板",
                      key: "name",
                      render: (_, record) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text strong>{record.name}</Typography.Text>
                          <Space size={6} wrap>
                            <Tag color={record.template_type === "system" ? "blue" : "default"}>{record.template_type}</Tag>
                            <Typography.Text type="secondary">{record.category}</Typography.Text>
                          </Space>
                        </Space>
                      )
                    },
                    {
                      title: "操作",
                      width: 72,
                      render: (_, record) => (
                        record.template_type === "system" ? null : (
                          <Popconfirm title="确认删除这个模板？" onConfirm={() => handleDeleteTemplate(record.id)}>
                            <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                          </Popconfirm>
                        )
                      )
                    }
                  ]}
                />
              </div>
            </Card>
          </Col>

          <Col xs={24} lg={18}>
            <Card
              title="CloudTrail SQL Console"
              extra={
                <Space>
                  <Button icon={<SaveOutlined />} onClick={() => openSaveModal(selectedTemplateId ? "update" : "create")} disabled={!sqlText.trim()}>
                    {selectedTemplateId ? "保存模板" : "另存模板"}
                  </Button>
                  <Button type="primary" icon={<PlayCircleOutlined />} loading={submitting} onClick={handleRunQuery}>
                    执行 SQL
                  </Button>
                </Space>
              }
            >
              <Space direction="vertical" style={{ width: "100%" }} size="middle">
                <Input
                  value={queryName}
                  onChange={(event) => setQueryName(event.target.value)}
                  placeholder="查询名称（可选）"
                />
                <TextArea
                  value={sqlText}
                  onChange={(event) => setSqlText(event.target.value)}
                  autoSize={{ minRows: 18, maxRows: 30 }}
                  placeholder="输入 Athena SQL，建议从左侧模板开始修改"
                />
                <Alert
                  type="info"
                  showIcon
                  message="当前后端仅允许 SELECT / WITH 查询；Athena 原始报错会直接回传。"
                />
                {resultError ? <Alert type="error" showIcon message={resultError} /> : null}
                {activeQuery ? (
                  <Card size="small" title="当前查询状态">
                    <Space wrap>
                      {statusTag(activeQuery.status)}
                      <Typography.Text copyable>{activeQuery.query_id}</Typography.Text>
                      {activeQuery.error_message ? <Typography.Text type="danger">{activeQuery.error_message}</Typography.Text> : null}
                    </Space>
                  </Card>
                ) : null}
              </Space>
            </Card>
          </Col>
        </Row>

        <Card title="查询结果">
          <Table
            rowKey="key"
            loading={resultLoading}
            dataSource={resultRows}
            scroll={{ x: true }}
            pagination={{ pageSize: 20 }}
            locale={{ emptyText: resultError ? "查询失败或暂无结果" : "执行 SQL 后在这里展示结果" }}
            columns={resultColumns.map((column) => ({
              title: column,
              dataIndex: column,
              key: column,
              render: (value) => {
                const text = value === null || value === undefined ? "" : String(value);
                return text.length > 200 ? <Typography.Text ellipsis={{ tooltip: text }}>{text}</Typography.Text> : text;
              }
            }))}
          />
        </Card>

        <Card title="最近查询历史" extra={<Button icon={<ReloadOutlined />} onClick={loadHistory}>刷新</Button>}>
          <Table
            rowKey="query_id"
            size="small"
            loading={historyLoading}
            dataSource={history}
            pagination={false}
            columns={[
              { title: "查询 ID", dataIndex: "query_id", key: "query_id", render: (value) => <Typography.Text copyable>{value}</Typography.Text> },
              { title: "名称", dataIndex: "query_name", key: "query_name", render: (value, record) => value || record.template_name || "-" },
              { title: "来源", dataIndex: "query_source", key: "query_source" },
              { title: "状态", dataIndex: "status", key: "status", render: (value) => statusTag(value) },
              { title: "提交时间", dataIndex: "submitted_at", key: "submitted_at", render: (value) => value ? new Date(value).toLocaleString() : "-" },
              {
                title: "操作",
                key: "actions",
                render: (_, record) => (
                  <Space>
                    <Button size="small" onClick={() => { setSqlText(record.sql_text || ""); setQueryName(record.query_name || ""); }}>带回编辑器</Button>
                    <Button size="small" onClick={() => handleLoadHistoryResult(record)}>查看结果</Button>
                  </Space>
                )
              }
            ]}
          />
        </Card>
      </Space>

      <Modal
        title={saveMode === "update" ? "保存模板" : "另存为模板"}
        open={saveModalOpen}
        onOk={handleSaveTemplate}
        okText="保存"
        confirmLoading={submitting}
        onCancel={() => setSaveModalOpen(false)}
      >
        <Form form={saveForm} layout="vertical" initialValues={{ category: "cloudtrail", template_type: "personal", is_active: true }}>
          <Form.Item name="name" label="模板名称" rules={[{ required: true, message: "请输入模板名称" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="category" label="分类">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="template_type" label="模板类型">
                <Select options={templateTypeOptions} />
              </Form.Item>
            </Col>
          </Row>
          {saveMode === "create" ? (
            <Form.Item name="template_code" label="模板编码（可选）">
              <Input placeholder="留空自动生成" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Typography,
  message
} from "antd";
import { SaveOutlined, ReloadOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { invalidatePublicSettings } from "../runtimeSettings";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

const TAB_LABELS = {
  general: "通用",
  ingest: "采集设置",
  auth: "认证设置"
};

const GENERAL_KEYS = new Set([
  "cloudtrail.historyRetentionLimit",
  "athena.database",
  "athena.workgroup",
  "athena.outputLocation"
]);

const AUTH_KEYS = new Set([
  "auth.keycloak.enabled",
  "auth.keycloak.url",
  "auth.keycloak.realm",
  "auth.keycloak.clientId"
]);

const INGEST_COMMON_KEYS = new Set(["ingest.sourceMode"]);
const INGEST_SQS_KEYS = new Set([
  "ingest.sqs.queueUrl",
  "ingest.sqs.maxMessages",
  "ingest.sqs.waitSeconds",
  "ingest.sqs.visibilityTimeout"
]);
const INGEST_S3_KEYS = new Set([
  "ingest.s3.pollIntervalMinutes",
  "ingest.s3.targets"
]);

function S3TargetsEditor({ accountOptions, regionOptions }) {
  return (
    <Form.List name="ingest.s3.targets">
      {(fields, { add, remove }) => (
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          {fields.map((field, index) => (
            <Card
              key={field.key}
              size="small"
              title={`目标 ${index + 1}`}
              extra={<Button danger type="text" icon={<DeleteOutlined />} onClick={() => remove(field.name)}>删除</Button>}
            >
              <Form.Item
                name={[field.name, "accountId"]}
                label="AWS 账号"
                rules={[{ required: true, message: "请选择 AWS 账号" }]}
              >
                <Select
                  showSearch
                  placeholder="选择一个 AWS 账号"
                  style={{ width: 420, maxWidth: "100%" }}
                  options={accountOptions}
                  optionFilterProp="label"
                />
              </Form.Item>
              <Form.Item
                name={[field.name, "regions"]}
                label="区域"
                rules={[{ required: true, type: "array", min: 1, message: "请至少选择一个区域" }]}
              >
                <Select
                  mode="multiple"
                  allowClear
                  showSearch
                  placeholder="选择这个账号要抓取的区域"
                  style={{ width: 520, maxWidth: "100%" }}
                  options={regionOptions}
                  optionFilterProp="label"
                />
              </Form.Item>
            </Card>
          ))}
          <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ accountId: undefined, regions: [] })}>
            添加账号与区域范围
          </Button>
          <Typography.Text type="secondary">
            按账号逐项配置区域范围，例如：账号 A 选择 2 个区域，账号 B 选择 3 个区域。
          </Typography.Text>
        </Space>
      )}
    </Form.List>
  );
}

function fieldForSetting(setting, { accountOptions = [] } = {}) {
  switch (setting.setting_key) {
    case "cloudtrail.historyRetentionLimit":
      return <InputNumber min={1} max={200} style={{ width: 260 }} />;
    case "ingest.sourceMode":
      return <Radio.Group optionType="button" buttonStyle="solid" options={[{ value: "sqs", label: "SQS" }, { value: "s3", label: "S3" }]} />;
    case "ingest.sqs.maxMessages":
      return <InputNumber min={1} max={10} style={{ width: 260 }} />;
    case "ingest.sqs.waitSeconds":
      return <InputNumber min={0} max={20} style={{ width: 260 }} />;
    case "ingest.sqs.visibilityTimeout":
      return <InputNumber min={0} max={43200} style={{ width: 260 }} />;
    case "ingest.s3.pollIntervalMinutes":
      return <InputNumber min={1} max={1440} style={{ width: 260 }} addonAfter="分钟" />;
    default:
      if (setting.value_type === "boolean") return <Switch />;
      return <Input style={{ width: 520, maxWidth: "100%" }} />;
  }
}

function SettingsSection({ title, description, items, form, accountOptions, regionOptions }) {
  if (!items.length) return null;

  return (
    <Card type="inner" title={title} style={{ marginBottom: 16 }}>
      {description ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          {description}
        </Typography.Paragraph>
      ) : null}
      {items.map((item) => {
        const rules = [];
        const keycloakEnabled = form.getFieldValue("auth.keycloak.enabled") === true;
        const sourceMode = form.getFieldValue("ingest.sourceMode") || "sqs";

        if (item.setting_key === "auth.keycloak.url" && keycloakEnabled) {
          rules.push({ required: true, message: "请输入 Keycloak 地址" });
        }
        if (item.setting_key === "auth.keycloak.realm" && keycloakEnabled) {
          rules.push({ required: true, message: "请输入 Keycloak Realm" });
        }
        if (item.setting_key === "auth.keycloak.clientId" && keycloakEnabled) {
          rules.push({ required: true, message: "请输入 Keycloak Client ID" });
        }
        if (item.setting_key === "ingest.sqs.queueUrl" && sourceMode === "sqs") {
          rules.push({ required: true, message: "请输入 SQS 队列地址" });
        }
        if (item.setting_key === "ingest.s3.bucket" && sourceMode === "s3") {
          rules.push({ required: true, message: "请输入 S3 Bucket" });
        }
        const isS3Targets = item.setting_key === "ingest.s3.targets";

        if (isS3Targets && sourceMode === "s3") {
          rules.push({
            validator: async (_, value) => {
              if (!Array.isArray(value) || value.length === 0) {
                throw new Error("请至少配置一个账号与区域范围");
              }
            }
          });
        }

        return (
          <Form.Item
            key={item.setting_key}
            name={item.setting_key}
            label={item.label}
            {...(item.value_type === "boolean" ? { valuePropName: "checked" } : {})}
            rules={rules}
            extra={item.description ? <Typography.Text type="secondary">{item.description}</Typography.Text> : null}
          >
            {isS3Targets ? <S3TargetsEditor accountOptions={accountOptions} regionOptions={regionOptions} /> : fieldForSetting(item, { accountOptions })}
          </Form.Item>
        );
      })}
    </Card>
  );
}

export function SettingsPage() {
  const [form] = Form.useForm();
  const [rows, setRows] = useState([]);
  const [accountOptions, setAccountOptions] = useState([]);
  const [regionOptions, setRegionOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("general");
  const [api, contextHolder] = message.useMessage();
  const ingestMode = Form.useWatch("ingest.sourceMode", form) || "sqs";

  const load = async () => {
    setLoading(true);
    try {
      const [{ data }, accountsResponse, regionsResponse] = await Promise.all([
        axios.get(`${API_URL}/settings`),
        axios.get(`${API_URL}/aws-accounts`, { params: { current: 1, pageSize: 500 } }),
        axios.get(`${API_URL}/aws-regions`, { params: { current: 1, pageSize: 500 } })
      ]);
      const items = data.data || [];
      const accounts = accountsResponse?.data?.data || [];
      const regions = regionsResponse?.data?.data || [];
      setRows(items);
      setAccountOptions(
        accounts.map((item) => ({
          value: item.account_id,
          label: item.account_name ? `${item.account_name} (${item.account_id})` : item.account_id
        }))
      );
      setRegionOptions(
        regions.map((item) => ({
          value: item.region_code,
          label: item.display_name ? `${item.display_name} (${item.region_code})` : item.region_code
        }))
      );
      form.setFieldsValue(Object.fromEntries(items.map((item) => [item.setting_key, item.parsed_value])));
    } catch (error) {
      api.error(error?.response?.data?.message || "设置加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const rowMap = useMemo(() => {
    const map = new Map();
    rows.forEach((row) => map.set(row.setting_key, row));
    return map;
  }, [rows]);

  const getRows = (keys) => [...keys].map((key) => rowMap.get(key)).filter(Boolean);

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await axios.put(`${API_URL}/settings`, {
        items: rows.map((row) => ({
          setting_key: row.setting_key,
          setting_value: values[row.setting_key]
        }))
      });
      invalidatePublicSettings();
      api.success("设置已保存");
      await load();
    } catch (error) {
      api.error(error?.response?.data?.message || "设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const tabItems = [
    {
      key: "general",
      label: TAB_LABELS.general,
      children: (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="这里集中放运行层面的通用配置。Athena 查询相关配置保存后，查询中心和健康检查会读取最新设置。"
          />
          <SettingsSection
            title="查询中心与通用配置"
            description="目前可直接在这里维护查询历史保留数，以及 Athena 默认 Database / Workgroup / 输出路径。"
            items={getRows(GENERAL_KEYS)}
            form={form}
            accountOptions={accountOptions}
            regionOptions={regionOptions}
          />
        </>
      )
    },
    {
      key: "ingest",
      label: TAB_LABELS.ingest,
      children: (
        <>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="采集设置已经集中到这里维护。SQS worker 已支持动态读取配置；S3 模式按 Athena 增量思路配置执行频率与账号-区域范围，不再需要直接填写 Bucket/Prefix。"
          />
          <SettingsSection
            title="采集模式"
            description="先选择当前采集来源模式，再填写对应模式的连接信息。"
            items={getRows(INGEST_COMMON_KEYS)}
            form={form}
            accountOptions={accountOptions}
            regionOptions={regionOptions}
          />
          {ingestMode === "sqs" ? (
            <SettingsSection
              title="SQS 采集配置"
              description="适用于当前默认模式。包括队列地址，以及 worker 拉取批次、等待时间、可见性超时等。"
              items={getRows(INGEST_SQS_KEYS)}
              form={form}
              accountOptions={accountOptions}
              regionOptions={regionOptions}
            />
          ) : (
            <SettingsSection
              title="Athena 增量采集配置"
              description="按账号逐项配置区域范围，支持账号 A 抓 2 个区域、账号 B 抓 3 个区域这类动态组合。"
              items={getRows(INGEST_S3_KEYS)}
              form={form}
              accountOptions={accountOptions}
              regionOptions={regionOptions}
            />
          )}
        </>
      )
    },
    {
      key: "auth",
      label: TAB_LABELS.auth,
      children: (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="认证设置走运行时配置。保存后，登录页会按最新 Keycloak 配置决定使用本地模式还是 SSO。"
          />
          <SettingsSection
            title="Keycloak 认证"
            description="启用后，需要补齐 Keycloak 地址、Realm 和 Client ID。"
            items={getRows(AUTH_KEYS)}
            form={form}
            accountOptions={accountOptions}
            regionOptions={regionOptions}
          />
        </>
      )
    }
  ];

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Card
          title="设置"
          extra={
            <Space>
              <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>保存设置</Button>
            </Space>
          }
        >
          {loading ? (
            <div style={{ padding: 40, textAlign: "center" }}><Spin /></div>
          ) : (
            <Form form={form} layout="vertical">
              <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
            </Form>
          )}
        </Card>
      </Space>
    </>
  );
}

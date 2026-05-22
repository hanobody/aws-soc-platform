import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tree,
  Typography,
  message
} from "antd";
import { PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { invalidatePublicSettings } from "../runtimeSettings";

const API_URL = import.meta.env.VITE_API_URL || "/api";

const TAB_LABELS = {
  ingest: "采集设置",
  general: "查询设置",
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

const INGEST_RUNTIME_KEYS = new Set([
  "ingest.queueUrl",
  "ingest.maxMessages",
  "ingest.waitSeconds",
  "ingest.visibilityTimeout"
]);

const INGEST_TARGET_KEYS = new Set(["ingest.targets"]);
const INGEST_FILTER_KEYS = new Set(["ingest.eventRules"]);

function normalizeEventRules(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      eventSource: String(item?.eventSource || "").trim(),
      eventNames: Array.isArray(item?.eventNames)
        ? Array.from(new Set(item.eventNames.map((name) => String(name || "").trim()).filter(Boolean)))
        : []
    }))
    .filter((item) => item.eventSource && item.eventNames.length);
}

function normalizeTargets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      accountId: item?.accountId,
      regions: Array.isArray(item?.regions) ? item.regions.filter(Boolean) : []
    }))
    .filter((item) => item.accountId && item.regions.length)
    .sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));
}

function TargetsTree({ value, onChange, accountOptions, regionOptions }) {
  const treeData = accountOptions.map((account) => ({
    title: account.label,
    key: `account:${account.value}`,
    children: regionOptions.map((region) => ({
      title: region.label,
      key: `region:${account.value}:${region.value}`
    }))
  }));

  const checkedKeys = normalizeTargets(value).flatMap((item) => item.regions.map((region) => `region:${item.accountId}:${region}`));

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Tree
        checkable
        checkedKeys={checkedKeys}
        treeData={treeData}
        onCheck={(nextCheckedKeys) => {
          const keys = Array.isArray(nextCheckedKeys) ? nextCheckedKeys : nextCheckedKeys.checked;
          const grouped = new Map();

          keys.forEach((key) => {
            if (typeof key !== "string" || !key.startsWith("region:")) return;
            const [, accountId, regionCode] = key.split(":");
            if (!grouped.has(accountId)) grouped.set(accountId, new Set());
            grouped.get(accountId).add(regionCode);
          });

          onChange?.(
            Array.from(grouped.entries())
              .map(([accountId, regions]) => ({ accountId, regions: Array.from(regions).sort() }))
              .sort((a, b) => a.accountId.localeCompare(b.accountId))
          );
        }}
      />
    </Space>
  );
}

function EventRulesEditor({ value, onChange }) {
  const rules = normalizeEventRules(value);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(rules, null, 2));
  const [jsonError, setJsonError] = useState("");

  useEffect(() => {
    setJsonText(JSON.stringify(rules, null, 2));
    setJsonError("");
  }, [value]);

  const emitRules = (next) => {
    const normalized = normalizeEventRules(next);
    onChange?.(normalized);
  };

  const updateRule = (index, patch) => {
    const next = rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule);
    emitRules(next);
  };

  const handleJsonChange = (nextText) => {
    setJsonText(nextText);
    try {
      const parsed = JSON.parse(nextText || "[]");
      emitRules(parsed);
      setJsonError("");
    } catch (error) {
      setJsonError("JSON 格式有误，修正前不会覆盖当前规则。");
    }
  };

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      {rules.map((rule, index) => (
        <Card
          key={`${rule.eventSource}-${index}`}
          size="small"
          extra={<Button danger type="link" onClick={() => emitRules(rules.filter((_, i) => i !== index))}>删除</Button>}
        >
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Input
              placeholder="event source，例如 iam.amazonaws.com"
              value={rule.eventSource}
              onChange={(e) => updateRule(index, { eventSource: e.target.value })}
            />
            <Select
              mode="tags"
              style={{ width: "100%" }}
              tokenSeparators={[",", " "]}
              placeholder="输入一个或多个 event name；支持 *"
              value={rule.eventNames}
              onChange={(next) => updateRule(index, { eventNames: next })}
            />
          </Space>
        </Card>
      ))}
      <Space>
        <Button onClick={() => emitRules([...rules, { eventSource: "", eventNames: [] }])}>新增规则</Button>
        <Button onClick={() => setJsonText(JSON.stringify(rules, null, 2))}>回填 JSON</Button>
      </Space>
      <Input.TextArea
        rows={10}
        value={jsonText}
        onChange={(e) => handleJsonChange(e.target.value)}
        placeholder={'[{"eventSource":"ec2.amazonaws.com","eventNames":["RunInstances","StopInstances"]}]'}
      />
      {jsonError ? <Typography.Text type="danger">{jsonError}</Typography.Text> : <Typography.Text type="secondary">可直接编辑 JSON，支持更灵活的 eventSource / eventNames 组合。</Typography.Text>}
    </Space>
  );
}

function fieldForSetting(setting) {
  switch (setting.setting_key) {
    case "cloudtrail.historyRetentionLimit":
      return <InputNumber min={1} max={200} style={{ width: 260 }} />;
    case "ingest.maxMessages":
      return <InputNumber min={1} max={10} style={{ width: 260 }} />;
    case "ingest.waitSeconds":
      return <InputNumber min={0} max={20} style={{ width: 260 }} />;
    case "ingest.visibilityTimeout":
      return <InputNumber min={0} max={43200} style={{ width: 260 }} />;
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
        const ingestEnabled = form.getFieldValue("ingest.enabled") !== false;
        const isTargets = item.setting_key === "ingest.targets";
        const isEventRules = item.setting_key === "ingest.eventRules";

        if (item.setting_key === "auth.keycloak.url" && keycloakEnabled) {
          rules.push({ required: true, message: "请输入 Keycloak 地址" });
        }
        if (item.setting_key === "auth.keycloak.realm" && keycloakEnabled) {
          rules.push({ required: true, message: "请输入 Keycloak Realm" });
        }
        if (item.setting_key === "auth.keycloak.clientId" && keycloakEnabled) {
          rules.push({ required: true, message: "请输入 Keycloak Client ID" });
        }
        if (item.setting_key === "ingest.queueUrl") {
          rules.push({ required: true, message: "请输入 SQS 队列地址" });
        }
        if (isTargets && ingestEnabled) {
          rules.push({
            validator: async (_, value) => {
              if (!Array.isArray(value) || value.length === 0) {
                throw new Error("请至少选择一个账号 / 区域");
              }
            }
          });
        }
        if (isEventRules && ingestEnabled) {
          rules.push({
            validator: async (_, value) => {
              if (!Array.isArray(value) || value.length === 0) {
                throw new Error("请至少配置一条采集规则");
              }
            }
          });
        }

        let fieldNode = fieldForSetting(item);
        if (isTargets) {
          fieldNode = <TargetsTree accountOptions={accountOptions} regionOptions={regionOptions} />;
        } else if (isEventRules) {
          fieldNode = <EventRulesEditor />;
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
            {fieldNode}
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
  const [toggling, setToggling] = useState(false);
  const [activeTab, setActiveTab] = useState("ingest");
  const [api, contextHolder] = message.useMessage();
  const ingestEnabled = Form.useWatch("ingest.enabled", form) !== false;

  const normalizeValues = (values) => ({
    ...values,
    "ingest.targets": normalizeTargets(values["ingest.targets"]),
    "ingest.eventRules": normalizeEventRules(values["ingest.eventRules"])
  });

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
      form.setFieldsValue(normalizeValues(Object.fromEntries(items.map((item) => [item.setting_key, item.parsed_value]))));
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

  const persistSettings = async (overrideValues = {}) => {
    const values = normalizeValues({ ...form.getFieldsValue(true), ...overrideValues });
    await form.setFieldsValue(values);
    await form.validateFields();
    await axios.put(`${API_URL}/settings`, {
      items: rows.map((row) => ({
        setting_key: row.setting_key,
        setting_value: values[row.setting_key]
      }))
    });
    invalidatePublicSettings();
    await load();
    return values;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await persistSettings();
      api.success("设置已保存");
    } catch (error) {
      api.error(error?.response?.data?.message || error?.message || "设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleIngest = async (enabled) => {
    setToggling(true);
    try {
      await persistSettings({ "ingest.enabled": enabled });
      api.success(enabled ? "采集已开始" : "采集已暂停");
    } catch (error) {
      api.error(error?.response?.data?.message || error?.message || "采集状态切换失败");
    } finally {
      setToggling(false);
    }
  };

  const tabItems = [
    {
      key: "ingest",
      label: TAB_LABELS.ingest,
      children: (
        <>
          <Alert
            type={ingestEnabled ? "success" : "warning"}
            showIcon
            style={{ marginBottom: 16 }}
            message={ingestEnabled ? "当前采集状态：运行中" : "当前采集状态：已暂停"}
          />
          <Card type="inner" title="采集控制" style={{ marginBottom: 16 }}>
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Typography.Text type="secondary">
                点击“开始采集 / 暂停采集”会立即保存当前采集设置，并由 worker 动态读取最新配置。
              </Typography.Text>
              <Space>
                <Button type="primary" icon={<PlayCircleOutlined />} loading={toggling} disabled={ingestEnabled} onClick={() => handleToggleIngest(true)}>
                  开始采集
                </Button>
                <Button danger icon={<PauseCircleOutlined />} loading={toggling} disabled={!ingestEnabled} onClick={() => handleToggleIngest(false)}>
                  暂停采集
                </Button>
              </Space>
            </Space>
          </Card>
          <SettingsSection
            title="运行参数"
            description="控制新 worker 如何从 object-created 队列拉取消息。"
            items={getRows(INGEST_RUNTIME_KEYS)}
            form={form}
            accountOptions={accountOptions}
            regionOptions={regionOptions}
          />
          <SettingsSection
            title="采集目标 AWS 账号 / 区域"
            items={getRows(INGEST_TARGET_KEYS)}
            form={form}
            accountOptions={accountOptions}
            regionOptions={regionOptions}
          />
          <SettingsSection
            title="事件采集规则"
            description="支持卡片编辑，也支持直接改 JSON。"
            items={getRows(INGEST_FILTER_KEYS)}
            form={form}
            accountOptions={accountOptions}
            regionOptions={regionOptions}
          />
        </>
      )
    },
    {
      key: "general",
      label: TAB_LABELS.general,
      children: (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="这里集中放查询相关配置。Athena 查询相关配置保存后，查询中心和健康检查会读取最新设置。"
          />
          <SettingsSection
            title="查询配置"
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
            <div style={{ padding: 40, textAlign: "center" }}>
              <Spin />
            </div>
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

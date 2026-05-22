import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useForm } from "@refinedev/antd";
import { Create, Edit } from "@refinedev/antd";
import { Alert, Card, Checkbox, Col, Divider, Empty, Form, Input, InputNumber, Row, Select, Space, Spin, Switch, Tag, Typography, message } from "antd";
import axios from "axios";
import { resourceConfig } from "./resourceConfig";

const API_URL = import.meta.env.VITE_API_URL || "/api";

function renderBasicField(field) {
  if (field.type === "number") return <InputNumber style={{ width: "100%" }} />;
  if (field.type === "textarea") return <Input.TextArea rows={4} />;
  if (field.type === "switch") return <Switch />;
  if (field.type === "select") return <Select options={field.options.map((value) => ({ label: value, value }))} />;
  if (field.type === "password") return <Input.Password />;
  return <Input />;
}

function matchesKeyword(item, keyword, fields) {
  if (!keyword) return true;
  const haystack = fields.map((field) => item?.[field]).filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(keyword.toLowerCase());
}

function SelectionList({ items, selectedValue, selectedValues, multiple = false, onSelect, renderTitle, renderDescription, getValue, getTags, emptyText }) {
  if (!items.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} style={{ margin: "24px 0" }} />;
  }

  return (
    <div style={{ display: "grid", gap: 12, maxHeight: 420, overflow: "auto", paddingRight: 4 }}>
      {items.map((item) => {
        const value = getValue(item);
        const active = multiple ? (selectedValues || []).includes(value) : value === selectedValue;

        return (
          <Card
            key={value}
            size="small"
            hoverable
            onClick={() => onSelect(item)}
            style={{
              cursor: "pointer",
              borderColor: active ? "#1677ff" : undefined,
              boxShadow: active ? "0 0 0 2px rgba(22,119,255,0.15)" : undefined
            }}
          >
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Space align="start" style={{ width: "100%", justifyContent: "space-between" }}>
                <Typography.Text strong>{renderTitle(item)}</Typography.Text>
                {active ? <Tag color="blue">已选中</Tag> : null}
              </Space>
              {getTags?.(item)?.length ? <Space size={[6, 6]} wrap>{getTags(item).map((tag) => tag)}</Space> : null}
              {renderDescription ? <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>{renderDescription(item)}</Typography.Paragraph> : null}
            </Space>
          </Card>
        );
      })}
    </div>
  );
}

function buildScopedMultiOptions(items, allLabel, valueKey, labelBuilder, extraSearchKeys = []) {
  return [
    { label: allLabel, value: "*", searchText: allLabel },
    ...items.map((item) => ({
      label: labelBuilder(item),
      value: item[valueKey],
      searchText: [item[valueKey], ...extraSearchKeys.map((key) => item[key])].filter(Boolean).join(" ")
    }))
  ];
}

function LinkedRuleFields({ form, catalogsLoading, resourceTypes, eventTypes, accounts = [], regions = [], channels = [] }) {
  const selectedResourceType = Form.useWatch("resource_type", form);
  const selectedEventNames = Form.useWatch("event_names", form) || [];
  const selectedAccountIds = Form.useWatch("account_ids", form) || ["*"];
  const selectedRegionCodes = Form.useWatch("region_codes", form) || ["*"];
  const selectedChannelId = Form.useWatch("notification_channel_id", form);
  const allAccounts = selectedAccountIds.includes("*") || selectedAccountIds.length === 0;
  const allRegions = selectedRegionCodes.includes("*") || selectedRegionCodes.length === 0;
  const [resourceKeyword, setResourceKeyword] = useState("");
  const [eventKeyword, setEventKeyword] = useState("");
  const [accountKeyword, setAccountKeyword] = useState("");
  const [regionKeyword, setRegionKeyword] = useState("");

  const filteredResourceTypes = useMemo(
    () => resourceTypes.filter((item) => matchesKeyword(item, resourceKeyword, ["code", "display_name", "aws_service", "event_source", "description"])),
    [resourceTypes, resourceKeyword]
  );

  const filteredEventTypes = useMemo(() => {
    return eventTypes
      .filter((item) => !selectedResourceType || item.resource_type_code === selectedResourceType)
      .filter((item) => matchesKeyword(item, eventKeyword, ["event_name", "display_name", "resource_type_code", "event_source", "severity", "description"]));
  }, [eventKeyword, eventTypes, selectedResourceType]);

  const selectedResourceMeta = resourceTypes.find((item) => item.code === selectedResourceType);
  const selectedEventMetas = eventTypes.filter((item) => selectedEventNames.includes(item.event_name) && (!selectedResourceType || item.resource_type_code === selectedResourceType));
  const selectedEventMeta = selectedEventMetas[0];

  const filteredAccounts = useMemo(
    () => accounts.filter((item) => matchesKeyword(item, accountKeyword, ["account_id", "account_name", "note"])),
    [accounts, accountKeyword]
  );

  const filteredRegions = useMemo(
    () => regions.filter((item) => matchesKeyword(item, regionKeyword, ["region_code", "display_name", "region_group"])),
    [regions, regionKeyword]
  );

  const accountOptions = useMemo(
    () => buildScopedMultiOptions(filteredAccounts, "ALL 全部账号", "account_id", (item) => `${item.account_name || item.account_id} (${item.account_id})`, ["account_name", "note"]),
    [filteredAccounts]
  );

  const regionOptions = useMemo(
    () => buildScopedMultiOptions(filteredRegions, "ALL 全部区域", "region_code", (item) => `${item.display_name} (${item.region_code})`, ["display_name", "region_group"]),
    [filteredRegions]
  );

  const channelOptions = useMemo(
    () => channels.filter((item) => item.enabled).map((channel) => ({
      label: `${channel.channel_name} (${channel.channel_type})`,
      value: channel.id,
      searchText: [channel.channel_name, channel.channel_type, channel.chat_id].filter(Boolean).join(" ")
    })),
    [channels]
  );

  return (
    <>
      <Card size="small" title="规则基础信息" style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item label="规则名称" name="rule_name">
              <Input placeholder="例如：生产账号 - 安全组开放告警" />
            </Form.Item>
          </Col>
          <Col xs={24} md={6}>
            <Card size="small" type="inner" title="账号 ID">
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Input allowClear value={accountKeyword} onChange={(event) => setAccountKeyword(event.target.value)} placeholder="搜索账号 ID / 名称" />
                <Form.Item name="account_ids" noStyle>
                  <Select
                    mode="multiple"
                    style={{ width: "100%" }}
                    placeholder="选择账号，可多选"
                    optionFilterProp="searchText"
                    value={selectedAccountIds}
                    options={accountOptions}
                    onChange={(values) => {
                      const nextValues = values.includes("*") ? ["*"] : values.filter((value) => value !== "*");
                      form.setFieldsValue({ account_ids: nextValues.length ? nextValues : [] });
                    }}
                  />
                </Form.Item>
                <Typography.Text type="secondary">{allAccounts ? "当前：ALL 全部账号" : `已选 ${selectedAccountIds.length} 个账号`}</Typography.Text>
              </Space>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card size="small" type="inner" title="区域编码">
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Input allowClear value={regionKeyword} onChange={(event) => setRegionKeyword(event.target.value)} placeholder="搜索区域编码 / 名称" />
                <Form.Item name="region_codes" noStyle>
                  <Select
                    mode="multiple"
                    style={{ width: "100%" }}
                    placeholder="选择区域，可多选"
                    optionFilterProp="searchText"
                    value={selectedRegionCodes}
                    options={regionOptions}
                    onChange={(values) => {
                      const nextValues = values.includes("*") ? ["*"] : values.filter((value) => value !== "*");
                      form.setFieldsValue({ region_codes: nextValues.length ? nextValues : [] });
                    }}
                  />
                </Form.Item>
                <Typography.Text type="secondary">{allRegions ? "当前：ALL 全部区域" : `已选 ${selectedRegionCodes.length} 个区域`}</Typography.Text>
              </Space>
            </Card>
          </Col>
        </Row>
      </Card>

      <Card size="small" title="资源 / 事件联动选择" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="双栏联动选择"
            description="当前只维护三类范围：EC2 实例、Security Group、IAM。左边选资源类型，右边只会联动显示该范围内事件。"
          />

          <Row gutter={16}>
            <Col xs={24} lg={12}>
              <Card size="small" type="inner" title="1. 资源类型">
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Input
                    allowClear
                    value={resourceKeyword}
                    disabled={catalogsLoading}
                    onChange={(event) => setResourceKeyword(event.target.value)}
                    placeholder="搜索 EC2 / Security Group / IAM 资源类型"
                  />
                  <SelectionList
                    items={filteredResourceTypes}
                    selectedValue={selectedResourceType}
                    getValue={(item) => item.code}
                    onSelect={(item) => {
                      const currentEventNames = form.getFieldValue("event_names") || [];
                      const nextEventNames = currentEventNames.filter((eventName) => eventTypes.some((eventType) => eventType.resource_type_code === item.code && eventType.event_name === eventName));

                      form.setFieldsValue({
                        resource_type: item.code,
                        event_source: item.event_source || undefined,
                        event_names: nextEventNames
                      });
                    }}
                    renderTitle={(item) => `${item.display_name || item.code} (${item.code})`}
                    renderDescription={(item) => item.description || "暂无说明"}
                    getTags={(item) => [
                      item.aws_service ? <Tag key="service">{item.aws_service}</Tag> : null,
                      item.event_source ? <Tag key="source">{item.event_source}</Tag> : null
                    ].filter(Boolean)}
                    emptyText="没有匹配的资源类型"
                  />
                </Space>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" type="inner" title="2. 事件类型">
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Input
                    allowClear
                    value={eventKeyword}
                    disabled={catalogsLoading}
                    onChange={(event) => setEventKeyword(event.target.value)}
                    placeholder={selectedResourceType ? "搜索该资源类型下的事件" : "先选资源类型，或直接搜索当前范围内全部事件"}
                  />
                  <SelectionList
                    items={filteredEventTypes}
                    selectedValues={selectedEventNames}
                    multiple
                    getValue={(item) => item.event_name}
                    onSelect={(item) => {
                      const currentValues = form.getFieldValue("event_names") || [];
                      const exists = currentValues.includes(item.event_name);
                      const nextValues = exists ? currentValues.filter((value) => value !== item.event_name) : [...currentValues, item.event_name];
                      form.setFieldsValue({
                        event_names: nextValues,
                        event_source: item.event_source,
                        resource_type: item.resource_type_code
                      });
                    }}
                    renderTitle={(item) => `${item.display_name || item.event_name} (${item.event_name})`}
                    renderDescription={(item) => item.description || "暂无说明"}
                    getTags={(item) => [
                      <Tag key="type" color="purple">{item.resource_type_code}</Tag>,
                      item.event_source ? <Tag key="source">{item.event_source}</Tag> : null,
                      item.severity ? <Tag key="severity" color={item.severity === "critical" ? "red" : item.severity === "high" ? "orange" : item.severity === "medium" ? "blue" : "default"}>{item.severity}</Tag> : null
                    ].filter(Boolean)}
                    emptyText={selectedResourceType ? "该资源类型下没有匹配事件" : "没有匹配的事件类型"}
                  />
                </Space>
              </Card>
            </Col>
          </Row>

          <Form.Item name="resource_type" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="account_ids" hidden rules={[{ required: true, type: "array", min: 1, message: "请选择账号 ID" }]}> 
            <Select mode="multiple" />
          </Form.Item>
          <Form.Item name="region_codes" hidden rules={[{ required: true, type: "array", min: 1, message: "请选择区域编码" }]}> 
            <Select mode="multiple" />
          </Form.Item>
          <Form.Item name="event_source" hidden rules={[{ required: true, message: "请选择资源类型" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="severity" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="event_names" hidden rules={[{ required: true, type: "array", min: 1, message: "请至少选择一个事件类型" }]}>
            <Select mode="multiple" />
          </Form.Item>

          {(selectedResourceMeta || selectedEventMeta) && (
            <Card size="small" type="inner" title="当前选择摘要">
              <Space size={[8, 8]} wrap>
                {selectedResourceMeta && <Tag color="blue">资源类型：{selectedResourceMeta.display_name || selectedResourceMeta.code}</Tag>}
                {selectedResourceMeta?.aws_service && <Tag>AWS 服务：{selectedResourceMeta.aws_service}</Tag>}
                {selectedEventMetas.map((eventItem) => <Tag key={eventItem.event_name} color="purple">事件：{eventItem.display_name || eventItem.event_name}</Tag>)}
              </Space>
              {(selectedResourceMeta?.description || selectedEventMeta?.description) && (
                <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                  {selectedEventMeta?.description || selectedResourceMeta?.description}
                </Typography.Paragraph>
              )}
            </Card>
          )}
        </Space>
      </Card>

      <Card size="small" title="匹配条件" style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col xs={24} md={12}>
            <Form.Item label="敏感资源匹配" name="resource_pattern">
              <Input.TextArea rows={4} placeholder="支持换行 / 逗号分隔 / * 通配，例如 sg-*prod*、i-*、arn:aws:iam::*:role/*" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item label="用户 ARN 匹配" name="user_arn_pattern">
              <Input.TextArea rows={4} placeholder="例如 arn:aws:iam::*:user/admin" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item label="源 IP 匹配" name="source_ip_pattern">
              <Input.TextArea rows={4} placeholder="支持 CIDR / 通配文本（按你当前后端规则写）" />
            </Form.Item>
          </Col>
          <Col xs={24} md={12}>
            <Form.Item label="说明" name="description">
              <Input.TextArea rows={4} placeholder="补充这个规则的用途和边界" />
            </Form.Item>
          </Col>
        </Row>
      </Card>

      <Card size="small" title="策略与元信息">
        <Row gutter={16}>
          <Col xs={24} md={8}>
            <Form.Item label="启用" name="enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item label="静默期秒数" name="cooldown_seconds">
              <InputNumber style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col xs={24} md={8}>
            <Form.Item
              label="通知渠道"
              name="notification_channel_id"
              rules={[{ required: true, message: "请选择通知渠道" }]}
              extra={channelOptions.length ? "规则必须关联一个已启用的通知渠道。" : "当前没有可用的已启用通知渠道，请先去通知渠道里启用一个。"}
            >
              <Select
                showSearch
                allowClear={false}
                placeholder="选择通知渠道"
                optionFilterProp="label"
                filterOption={(input, option) => String(option?.searchText || option?.label || "").toLowerCase().includes(input.toLowerCase())}
                options={channelOptions}
                notFoundContent="没有可用的已启用通知渠道"
              />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="created_by" hidden>
          <Input />
        </Form.Item>
        <Form.Item name="updated_by" hidden>
          <Input />
        </Form.Item>
      </Card>
    </>
  );
}

function EventTypeFields({ form, catalogsLoading, resourceTypes }) {
  const selectedResourceType = Form.useWatch("resource_type_code", form);
  const selectedResourceMeta = resourceTypes.find((item) => item.code === selectedResourceType);
  const [resourceKeyword, setResourceKeyword] = useState("");

  const filteredResourceTypes = useMemo(
    () => resourceTypes.filter((item) => matchesKeyword(item, resourceKeyword, ["code", "display_name", "aws_service", "event_source", "description"])),
    [resourceKeyword, resourceTypes]
  );

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="资源类型用搜索面板选择"
        description="当前前端已同步收口，只维护 EC2 实例、Security Group、IAM 相关资源类型。"
      />

      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Card size="small" type="inner" title="资源类型选择">
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Input
                allowClear
                value={resourceKeyword}
                disabled={catalogsLoading}
                onChange={(event) => setResourceKeyword(event.target.value)}
                placeholder="搜索资源类型"
              />
              <SelectionList
                items={filteredResourceTypes}
                selectedValue={selectedResourceType}
                getValue={(item) => item.code}
                onSelect={(item) => {
                  form.setFieldsValue({
                    resource_type_code: item.code,
                    event_source: form.getFieldValue("event_source") || item.event_source
                  });
                }}
                renderTitle={(item) => `${item.display_name || item.code} (${item.code})`}
                renderDescription={(item) => item.description || "暂无说明"}
                getTags={(item) => [
                  item.aws_service ? <Tag key="service">{item.aws_service}</Tag> : null,
                  item.event_source ? <Tag key="source">{item.event_source}</Tag> : null
                ].filter(Boolean)}
                emptyText="没有匹配的资源类型"
              />
            </Space>
          </Card>
          <Form.Item name="resource_type_code" hidden rules={[{ required: true, message: "请选择资源类型" }]}>
            <Input />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="事件源" name="event_source" rules={[{ required: true, message: "请填写事件源" }]}>
            <Input placeholder="通常可自动带出，也可手动调整" />
          </Form.Item>
        </Col>
      </Row>

      {selectedResourceMeta && (
        <Card size="small" type="inner" style={{ marginBottom: 16 }}>
          <Space size={[8, 8]} wrap>
            <Tag color="blue">{selectedResourceMeta.display_name || selectedResourceMeta.code}</Tag>
            {selectedResourceMeta.aws_service && <Tag>{selectedResourceMeta.aws_service}</Tag>}
            {selectedResourceMeta.event_source && <Tag>{selectedResourceMeta.event_source}</Tag>}
          </Space>
          {selectedResourceMeta.description && (
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              {selectedResourceMeta.description}
            </Typography.Paragraph>
          )}
        </Card>
      )}

      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="事件名" name="event_name" rules={[{ required: true, message: "请填写事件名" }]}> 
            <Input placeholder="例如 AuthorizeSecurityGroupIngress / RunInstances / AssumeRole" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="显示名称" name="display_name" rules={[{ required: true, message: "请填写显示名称" }]}>
            <Input placeholder="例如 开放安全组入站规则" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="默认等级" name="severity" rules={[{ required: true, message: "请选择默认等级" }]}>
            <Select options={["low", "medium", "high", "critical"].map((value) => ({ label: value, value }))} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="说明" name="description">
            <Input.TextArea rows={4} />
          </Form.Item>
        </Col>
      </Row>
    </>
  );
}

export function ResourceFormPage({ resource, mode }) {
  const { id } = useParams();
  const config = resourceConfig[resource];
  const { formProps, saveButtonProps } = useForm({
    resource,
    action: mode,
    id,
    redirect: "list"
  });
  const [resourceTypes, setResourceTypes] = useState([]);
  const [eventTypes, setEventTypes] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [regions, setRegions] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [channels, setChannels] = useState([]);
  const [catalogsLoading, setCatalogsLoading] = useState(false);
  const [api, contextHolder] = message.useMessage();

  useEffect(() => {
    if (!["event-types", "alert-rules"].includes(resource)) return;

    let active = true;
    setCatalogsLoading(true);

    const requests = [
      axios.get(`${API_URL}/resource-types`, { params: { current: 1, pageSize: 500 } }),
      axios.get(`${API_URL}/event-types`, { params: { current: 1, pageSize: 1000 } })
    ];

    if (resource === "alert-rules") {
      requests.push(
        axios.get(`${API_URL}/aws-accounts`, { params: { current: 1, pageSize: 500 } }),
        axios.get(`${API_URL}/aws-regions`, { params: { current: 1, pageSize: 500 } }),
        axios.get(`${API_URL}/account-routes`, { params: { current: 1, pageSize: 500 } }),
        axios.get(`${API_URL}/notification-channels`, { params: { current: 1, pageSize: 500 } })
      );
    }

    Promise.all(requests)
      .then((responses) => {
        if (!active) return;
        const [resourceTypeRes, eventTypeRes, accountsRes, regionsRes, routesRes, channelsRes] = responses;
        setResourceTypes(resourceTypeRes.data.data || []);
        setEventTypes(eventTypeRes.data.data || []);
        setAccounts(accountsRes?.data?.data || []);
        setRegions(regionsRes?.data?.data || []);
        setRoutes(routesRes?.data?.data || []);
        setChannels(channelsRes?.data?.data || []);
      })
      .finally(() => {
        if (active) setCatalogsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [resource]);

  useEffect(() => {
    if (resource !== "alert-rules") return;
    const form = formProps.form;
    if (!form) return;

    if (mode === "create") {
      form.setFieldsValue({
        account_ids: form.getFieldValue("account_ids") ?? ["*"],
        region_codes: form.getFieldValue("region_codes") ?? ["*"],
        enabled: form.getFieldValue("enabled") ?? true,
        cooldown_seconds: form.getFieldValue("cooldown_seconds") ?? 0,
        event_names: form.getFieldValue("event_names") ?? []
      });
    } else {
      const accountId = form.getFieldValue("account_id");
      const regionCode = form.getFieldValue("region_code");
      const routeId = form.getFieldValue("notification_route_id");
      const selectedRoute = routes.find((item) => item.id === routeId);
      form.setFieldsValue({
        account_ids: accountId ? [accountId] : ["*"],
        region_codes: regionCode ? [regionCode] : ["*"],
        notification_channel_id: selectedRoute?.channel_id
      });
    }

    const currentEventName = form.getFieldValue("event_name");
    const currentEventNames = form.getFieldValue("event_names");
    if (currentEventName && (!currentEventNames || !currentEventNames.length)) {
      form.setFieldsValue({ event_names: [currentEventName] });
    }
  }, [formProps.form, mode, resource, routes]);

  const routesByAccountAndChannel = useMemo(() => {
    const map = new Map();
    for (const route of routes) {
      map.set(`${route.account_id}|${route.channel_id}`, route);
    }
    return map;
  }, [routes]);

  const ensureRoute = async (accountId, channelId) => {
    const key = `${accountId}|${channelId}`;
    const existing = routesByAccountAndChannel.get(key);
    if (existing) return existing;

    const { data } = await axios.post(`${API_URL}/account-routes`, {
      account_id: accountId,
      channel_id: channelId,
      enabled: true
    });
    const created = data.data;
    setRoutes((current) => [...current, created]);
    return created;
  };

  const handleAlertRulesFinish = async (values) => {
    const selectedNames = values.event_names || [];
    const selectedAccounts = values.account_ids?.length ? values.account_ids : ["*"];
    const selectedRegions = values.region_codes?.length ? values.region_codes : ["*"];
    const selectedChannelId = values.notification_channel_id || null;
    if (!selectedChannelId) {
      api.error("通知渠道为必填项，请先选择通知渠道");
      return;
    }
    if (!selectedNames.length) {
      api.error("请至少选择一个事件类型");
      return;
    }

    if (mode === "edit" && selectedNames.length > 1) {
      api.error("当前编辑模式暂只支持单个事件；多事件请新建批量规则");
      return;
    }

    const selectedEvents = eventTypes.filter((item) => selectedNames.includes(item.event_name));
    if (!selectedEvents.length) {
      api.error("未找到对应事件类型");
      return;
    }

    const commonPayload = {
      rule_name: values.rule_name,
      is_default: false,
      resource_type: values.resource_type,
      resource_pattern: values.resource_pattern,
      user_arn_pattern: values.user_arn_pattern,
      source_ip_pattern: values.source_ip_pattern,
      enabled: values.enabled ?? true,
      cooldown_seconds: values.cooldown_seconds ?? 0,
      description: values.description,
      created_by: values.created_by,
      updated_by: values.updated_by
    };

    try {
      if (mode === "create") {
        let createdCount = 0;
        for (const accountId of selectedAccounts) {
          const route = selectedChannelId ? await ensureRoute(accountId, selectedChannelId) : null;
          for (const regionCode of selectedRegions) {
            for (const eventType of selectedEvents) {
              await axios.post(`${API_URL}/alert-rules`, {
                ...commonPayload,
                account_id: accountId || "*",
                region_code: regionCode || "*",
                notification_route_id: route?.id || null,
                event_source: eventType.event_source,
                event_name: eventType.event_name,
                severity: eventType.severity
              });
              createdCount += 1;
            }
          }
        }
        api.success(`已创建 ${createdCount} 条规则`);
      } else {
        const eventType = selectedEvents[0];
        if (selectedAccounts.length > 1 || selectedRegions.length > 1) {
          api.error("编辑模式暂只支持单账号/单区域；多选请新建批量规则");
          return;
        }
        const route = selectedChannelId ? await ensureRoute(selectedAccounts[0] || "*", selectedChannelId) : null;
        await axios.patch(`${API_URL}/alert-rules/${id}`, {
          ...commonPayload,
          account_id: selectedAccounts[0] || "*",
          region_code: selectedRegions[0] || "*",
          notification_route_id: route?.id || null,
          event_source: eventType.event_source,
          event_name: eventType.event_name,
          severity: eventType.severity
        });
        api.success("规则已更新");
      }

      window.location.assign("/alert-rules");
    } catch (error) {
      api.error(error?.response?.data?.message || error.message || "保存失败");
    }
  };

  const Wrapper = mode === "create" ? Create : Edit;

  return (
    <Wrapper title={`${mode === "create" ? "新建" : "编辑"}${config.title}`} saveButtonProps={resource === "alert-rules" ? { ...saveButtonProps, onClick: () => formProps.form?.submit() } : saveButtonProps}>
      {contextHolder}
      <Spin spinning={catalogsLoading && ["event-types", "alert-rules"].includes(resource)}>
        <Form {...formProps} layout="vertical" onFinish={resource === "alert-rules" ? handleAlertRulesFinish : formProps.onFinish}>
          {resource === "alert-rules" ? (
            <LinkedRuleFields form={formProps.form} catalogsLoading={catalogsLoading} resourceTypes={resourceTypes} eventTypes={eventTypes} accounts={accounts} regions={regions} channels={channels} />
          ) : resource === "event-types" ? (
            <EventTypeFields form={formProps.form} catalogsLoading={catalogsLoading} resourceTypes={resourceTypes} />
          ) : (
            config.fields.map((field, index) => (
              <div key={field.name}>
                <Form.Item
                  label={field.label}
                  name={field.name}
                  valuePropName={field.type === "switch" ? "checked" : "value"}
                  rules={field.required ? [{ required: true, message: `请填写${field.label}` }] : undefined}
                >
                  {renderBasicField(field)}
                </Form.Item>
                {index < config.fields.length - 1 && field.type === "textarea" ? <Divider style={{ margin: "12px 0 20px" }} /> : null}
              </div>
            ))
          )}
        </Form>
      </Spin>
    </Wrapper>
  );
}

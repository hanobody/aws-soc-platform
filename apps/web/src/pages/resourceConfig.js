export const resourceConfig = {
  "aws-accounts": {
    title: "AWS 账号",
    columns: [
      { key: "id", title: "ID" },
      { key: "account_id", title: "账号 ID" },
      { key: "account_name", title: "账号名称" },
      { key: "note", title: "备注" }
    ],
    fields: [
      { name: "account_id", label: "账号 ID", type: "text", required: true },
      { name: "account_name", label: "账号名称", type: "text" },
      { name: "note", label: "备注", type: "textarea" }
    ]
  },
  "aws-regions": {
    title: "区域",
    columns: [
      { key: "id", title: "ID" },
      { key: "region_code", title: "区域编码" },
      { key: "display_name", title: "名称" },
      { key: "region_group", title: "区域组" }
    ],
    fields: [
      { name: "region_code", label: "区域编码", type: "text", required: true },
      { name: "display_name", label: "显示名称", type: "text", required: true },
      { name: "region_group", label: "区域组", type: "text", required: true }
    ]
  },
  "resource-types": {
    title: "资源类型（当前范围）",
    columns: [
      { key: "id", title: "ID" },
      { key: "code", title: "编码" },
      { key: "display_name", title: "名称" },
      { key: "aws_service", title: "AWS 服务" },
      { key: "event_source", title: "事件源" }
    ],
    fields: [
      { name: "code", label: "资源类型编码", type: "text", required: true },
      { name: "display_name", label: "显示名称", type: "text", required: true },
      { name: "aws_service", label: "AWS 服务", type: "text", required: true },
      { name: "event_source", label: "事件源", type: "text", required: true },
      { name: "description", label: "说明", type: "textarea" }
    ]
  },
  "event-types": {
    title: "事件类型（当前范围）",
    columns: [
      { key: "id", title: "ID" },
      { key: "resource_type_code", title: "资源类型" },
      { key: "event_source", title: "事件源" },
      { key: "event_name", title: "事件名" },
      { key: "display_name", title: "显示名称" },
      { key: "severity", title: "默认等级" }
    ],
    fields: [
      { name: "resource_type_code", label: "资源类型编码", type: "text", required: true },
      { name: "event_source", label: "事件源", type: "text", required: true },
      { name: "event_name", label: "事件名", type: "text", required: true },
      { name: "display_name", label: "显示名称", type: "text", required: true },
      { name: "severity", label: "默认等级", type: "select", options: ["low", "medium", "high", "critical"], required: true },
      { name: "description", label: "说明", type: "textarea" }
    ]
  },
  "alert-rules": {
    title: "规则中心",
    columns: [
      { key: "id", title: "ID" },
      { key: "rule_name", title: "规则名" },
      { key: "is_default", title: "规则来源" },
      { key: "account_id", title: "账号" },
      { key: "region_code", title: "区域" },
      { key: "resource_type", title: "资源类型" },
      { key: "event_name", title: "动作" },
      { key: "resource_pattern", title: "敏感资源匹配" },
      { key: "notification_channel_name", title: "通知渠道" },
      { key: "severity", title: "风险等级" },
      { key: "enabled", title: "启用" }
    ],
    fields: [
      { name: "rule_name", label: "规则名称", type: "text" },
      { name: "is_default", label: "系统默认规则", type: "switch" },
      { name: "account_id", label: "账号 ID", type: "text", required: true },
      { name: "region_code", label: "区域编码", type: "text" },
      { name: "event_source", label: "事件源", type: "text", required: true },
      { name: "event_name", label: "动作 / 事件名", type: "text", required: true },
      { name: "resource_type", label: "资源类型", type: "text" },
      { name: "resource_pattern", label: "敏感资源匹配", type: "textarea" },
      { name: "user_arn_pattern", label: "用户 ARN 匹配", type: "textarea" },
      { name: "source_ip_pattern", label: "源 IP 匹配", type: "textarea" },
      { name: "severity", label: "风险等级", type: "select", options: ["low", "medium", "high", "critical"], required: true },
      { name: "enabled", label: "启用", type: "switch" },
      { name: "cooldown_seconds", label: "静默期秒数", type: "number" },
      { name: "notification_route_id", label: "通知路由 ID", type: "number" },
      { name: "description", label: "说明", type: "textarea" },
      { name: "created_by", label: "创建人", type: "text" },
      { name: "updated_by", label: "更新人", type: "text" }
    ]
  },
  "notification-channels": {
    title: "通知渠道",
    columns: [
      { key: "id", title: "ID" },
      { key: "channel_name", title: "渠道名" },
      { key: "channel_type", title: "类型" },
      { key: "chat_id", title: "Chat ID" },
      { key: "enabled", title: "启用" }
    ],
    fields: [
      { name: "channel_name", label: "渠道名", type: "text", required: true },
      { name: "channel_type", label: "渠道类型", type: "text", required: true },
      { name: "bot_token", label: "Bot Token", type: "password" },
      { name: "chat_id", label: "Chat ID", type: "text" },
      { name: "enabled", label: "启用", type: "switch" }
    ]
  },
  "account-routes": {
    title: "账号路由",
    columns: [
      { key: "id", title: "ID" },
      { key: "account_id", title: "账号" },
      { key: "project_name", title: "项目" },
      { key: "environment", title: "环境" },
      { key: "channel_id", title: "渠道 ID" },
      { key: "enabled", title: "启用" }
    ],
    fields: [
      { name: "account_id", label: "账号 ID", type: "text", required: true },
      { name: "project_name", label: "项目名", type: "text" },
      { name: "environment", label: "环境", type: "text" },
      { name: "channel_id", label: "渠道 ID", type: "number", required: true },
      { name: "enabled", label: "启用", type: "switch" }
    ]
  },
  "alert-events": {
    title: "告警事件",
    columns: [
      { key: "id", title: "ID" },
      { key: "event_id", title: "事件 ID" },
      { key: "event_source", title: "事件源" },
      { key: "event_name", title: "事件名" },
      { key: "resource_type", title: "资源类型" },
      { key: "resource_id", title: "资源 ID" },
      { key: "matched_rule_name", title: "匹配规则" },
      { key: "severity", title: "等级" },
      { key: "alert_status", title: "通知状态" },
      { key: "notification_channel_name", title: "通知渠道" },
      { key: "event_time", title: "发生时间" }
    ],
    fields: []
  },
  "ingested-events": {
    title: "采集事件",
    columns: [
      { key: "id", title: "ID" },
      { key: "event_id", title: "事件 ID" },
      { key: "aws_account_id", title: "账号" },
      { key: "aws_region", title: "区域" },
      { key: "event_source", title: "事件源" },
      { key: "event_name", title: "事件名" },
      { key: "resource_type", title: "资源类型" },
      { key: "event_time", title: "事件时间" }
    ],
    fields: []
  }
};

import { Layout, Typography, Space, Tag } from "antd";
import { useGetIdentity } from "@refinedev/core";

export function HeaderTitle() {
  const { data } = useGetIdentity();

  return (
    <Layout.Header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", padding: "0 16px", borderBottom: "1px solid #f0f0f0" }}>
      <Typography.Title level={4} style={{ margin: 0 }}>AWS SOC Platform</Typography.Title>
      <Space>
        <Tag color="blue">Refine</Tag>
        <Tag color="purple">Keycloak Ready</Tag>
        <Typography.Text type="secondary">{data?.name || "Guest"}</Typography.Text>
      </Space>
    </Layout.Header>
  );
}

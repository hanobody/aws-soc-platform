import { Layout, Typography, Dropdown, Avatar, Space } from "antd";
import { DownOutlined, LogoutOutlined, UserOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { useGetIdentity, useLogout } from "@refinedev/core";
import { APP_VERSION } from "../version";

export function HeaderTitle() {
  const { data } = useGetIdentity();
  const { mutate: logout } = useLogout();

  const items = [
    {
      key: "about",
      label: `关于 · 版本 ${APP_VERSION}`,
      icon: <InfoCircleOutlined />,
      disabled: true
    },
    {
      key: "logout",
      label: "退出登录",
      icon: <LogoutOutlined />,
      onClick: () => logout()
    }
  ];

  return (
    <Layout.Header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", padding: "0 16px", borderBottom: "1px solid #f0f0f0" }}>
      <div />
      <Dropdown menu={{ items }} trigger={["click"]}>
        <Space style={{ cursor: "pointer" }}>
          <Avatar size="small" icon={<UserOutlined />} />
          <Typography.Text type="secondary">{data?.name || "Guest"}</Typography.Text>
          <DownOutlined style={{ fontSize: 12, color: "#8c8c8c" }} />
        </Space>
      </Dropdown>
    </Layout.Header>
  );
}

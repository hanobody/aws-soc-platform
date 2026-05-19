import { useLogin } from "@refinedev/core";
import { useEffect, useState } from "react";
import { Card, Button, Typography, Space } from "antd";
import { getPublicSettings } from "../runtimeSettings";

export function LoginPage() {
  const { mutate: login, isLoading } = useLogin();
  const [keycloakEnabled, setKeycloakEnabled] = useState(false);

  useEffect(() => {
    getPublicSettings().then((settings) => {
      setKeycloakEnabled(settings["auth.keycloak.enabled"] === true);
    });
  }, []);

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f5f7fb" }}>
      <Card style={{ width: 420 }}>
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <div>
            <Typography.Title level={3}>AWS SOC Platform</Typography.Title>
            <Typography.Paragraph type="secondary">
              {keycloakEnabled ? "使用 Keycloak SSO 登录" : "当前为本地演示登录模式，后续切 Keycloak 只要改环境变量。"}
            </Typography.Paragraph>
          </div>
          <Button type="primary" size="large" block loading={isLoading} onClick={() => login()}>
            {keycloakEnabled ? "使用 Keycloak 登录" : "本地进入后台"}
          </Button>
        </Space>
      </Card>
    </div>
  );
}

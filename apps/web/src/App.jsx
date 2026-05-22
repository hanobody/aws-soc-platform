import { Refine, Authenticated } from "@refinedev/core";
import routerBindings, { NavigateToResource, CatchAllNavigate } from "@refinedev/react-router";
import { ThemedLayout, ErrorComponent } from "@refinedev/antd";
import { ConfigProvider, App as AntdApp } from "antd";
import { Routes, Route, Outlet } from "react-router-dom";
import { DashboardOutlined, AlertOutlined, BellOutlined, ApartmentOutlined, AppstoreOutlined, TagsOutlined, CloudServerOutlined, GlobalOutlined, CodeOutlined, SettingOutlined } from "@ant-design/icons";
import { authProvider } from "./authProvider";
import { dataProvider } from "./dataProvider";
import { HeaderTitle } from "./components/HeaderTitle";
import { AlwaysOpenSider } from "./components/AlwaysOpenSider";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ResourceListPage } from "./pages/ResourceListPage";
import { ResourceFormPage } from "./pages/ResourceFormPage";
import { AlertEventDetailPage } from "./pages/AlertEventDetailPage";
import { CloudTrailSqlConsolePage } from "./pages/CloudTrailSqlConsolePage";
import { SettingsPage } from "./pages/SettingsPage";

const API_URL = import.meta.env.VITE_API_URL || "/api";

export function App() {
  return (
    <ConfigProvider>
      <AntdApp>
        <Refine
          authProvider={authProvider}
          dataProvider={dataProvider(API_URL)}
          routerProvider={routerBindings}
          resources={[
            {
              name: "dashboard",
              list: "/dashboard",
              meta: { label: "Dashboard", icon: <DashboardOutlined /> }
            },
            {
              name: "basic-config-center",
              list: "/aws-accounts",
              meta: { label: "基础配置中心", icon: <ApartmentOutlined /> }
            },
            {
              name: "alert-center",
              list: "/alert-rules",
              meta: { label: "告警中心", icon: <AlertOutlined /> }
            },
            {
              name: "aws-accounts",
              list: "/aws-accounts",
              create: "/aws-accounts/create",
              edit: "/aws-accounts/edit/:id",
              meta: { label: "AWS 账号", icon: <CloudServerOutlined />, parent: "basic-config-center" }
            },
            {
              name: "aws-regions",
              list: "/aws-regions",
              create: "/aws-regions/create",
              edit: "/aws-regions/edit/:id",
              meta: { label: "区域", icon: <GlobalOutlined />, parent: "basic-config-center" }
            },
            {
              name: "resource-types",
              list: "/resource-types",
              create: "/resource-types/create",
              edit: "/resource-types/edit/:id",
              meta: { label: "资源类型", icon: <AppstoreOutlined />, parent: "basic-config-center" }
            },
            {
              name: "event-types",
              list: "/event-types",
              create: "/event-types/create",
              edit: "/event-types/edit/:id",
              meta: { label: "事件类型", icon: <TagsOutlined />, parent: "basic-config-center" }
            },
            {
              name: "alert-rules",
              list: "/alert-rules",
              create: "/alert-rules/create",
              edit: "/alert-rules/edit/:id",
              meta: { label: "规则中心", icon: <AlertOutlined />, parent: "alert-center" }
            },
            {
              name: "notification-channels",
              list: "/notification-channels",
              create: "/notification-channels/create",
              edit: "/notification-channels/edit/:id",
              meta: { label: "通知渠道", icon: <BellOutlined />, parent: "basic-config-center" }
            },
            {
              name: "alert-events",
              list: "/alert-events",
              meta: { label: "告警事件", icon: <DashboardOutlined />, parent: "alert-center" }
            },
            {
              name: "cloudtrail-sql-console",
              list: "/cloudtrail-sql-console",
              meta: { label: "查询中心", icon: <CodeOutlined /> }
            },
            {
              name: "settings",
              list: "/settings",
              meta: { label: "设置", icon: <SettingOutlined /> }
            }
          ]}
          options={{ syncWithLocation: true, warnWhenUnsavedChanges: false, projectId: "aws-soc-platform" }}
        >
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <Authenticated key="authenticated-routes" fallback={<CatchAllNavigate to="/login" />}>
                  <ThemedLayout Header={() => <HeaderTitle />} Sider={(props) => <AlwaysOpenSider {...props} />}>
                    <Outlet />
                    <div style={{ position: "fixed", right: 16, bottom: 12, color: "#999", fontSize: 12, zIndex: 1000 }}>
                      版权所有 @dr414
                    </div>
                  </ThemedLayout>
                </Authenticated>
              }
            >
              <Route index element={<NavigateToResource resource="dashboard" />} />
              <Route path="/dashboard" element={<DashboardPage apiUrl={API_URL} />} />
              <Route path="/aws-accounts" element={<ResourceListPage resource="aws-accounts" />} />
              <Route path="/aws-accounts/create" element={<ResourceFormPage resource="aws-accounts" mode="create" />} />
              <Route path="/aws-accounts/edit/:id" element={<ResourceFormPage resource="aws-accounts" mode="edit" />} />
              <Route path="/aws-regions" element={<ResourceListPage resource="aws-regions" />} />
              <Route path="/aws-regions/create" element={<ResourceFormPage resource="aws-regions" mode="create" />} />
              <Route path="/aws-regions/edit/:id" element={<ResourceFormPage resource="aws-regions" mode="edit" />} />
              <Route path="/resource-types" element={<ResourceListPage resource="resource-types" />} />
              <Route path="/resource-types/create" element={<ResourceFormPage resource="resource-types" mode="create" />} />
              <Route path="/resource-types/edit/:id" element={<ResourceFormPage resource="resource-types" mode="edit" />} />
              <Route path="/event-types" element={<ResourceListPage resource="event-types" />} />
              <Route path="/event-types/create" element={<ResourceFormPage resource="event-types" mode="create" />} />
              <Route path="/event-types/edit/:id" element={<ResourceFormPage resource="event-types" mode="edit" />} />
              <Route path="/alert-rules" element={<ResourceListPage resource="alert-rules" />} />
              <Route path="/alert-rules/create" element={<ResourceFormPage resource="alert-rules" mode="create" />} />
              <Route path="/alert-rules/edit/:id" element={<ResourceFormPage resource="alert-rules" mode="edit" />} />
              <Route path="/notification-channels" element={<ResourceListPage resource="notification-channels" />} />
              <Route path="/notification-channels/create" element={<ResourceFormPage resource="notification-channels" mode="create" />} />
              <Route path="/notification-channels/edit/:id" element={<ResourceFormPage resource="notification-channels" mode="edit" />} />
              <Route path="/alert-events" element={<ResourceListPage resource="alert-events" />} />
              <Route path="/alert-events/:id" element={<AlertEventDetailPage apiUrl={API_URL} />} />
              <Route path="/cloudtrail-sql-console" element={<CloudTrailSqlConsolePage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            <Route
              path="*"
              element={
                <Authenticated fallback={<CatchAllNavigate to="/login" />}>
                  <ErrorComponent />
                </Authenticated>
              }
            />
          </Routes>
        </Refine>
      </AntdApp>
    </ConfigProvider>
  );
}

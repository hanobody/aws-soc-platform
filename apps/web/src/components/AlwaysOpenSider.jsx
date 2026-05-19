import { useContext, useMemo, useState } from "react";
import {
  Layout,
  Menu,
  Grid,
  Drawer,
  Button,
  theme,
  ConfigProvider
} from "antd";
import {
  LogoutOutlined,
  UnorderedListOutlined,
  BarsOutlined,
  LeftOutlined,
  RightOutlined
} from "@ant-design/icons";
import {
  ThemedTitle,
  useThemedLayoutContext
} from "@refinedev/antd";
import {
  CanAccess,
  useTranslate,
  useLogout,
  useIsExistAuthentication,
  useMenu,
  useLink,
  useWarnAboutChange
} from "@refinedev/core";

const ALWAYS_OPEN_KEY = "alert-center";

export function AlwaysOpenSider({
  Title: TitleFromProps,
  render,
  meta,
  fixed,
  activeItemDisabled = false,
  siderItemsAreCollapsed = true
}) {
  const { token } = theme.useToken();
  const {
    siderCollapsed,
    setSiderCollapsed,
    mobileSiderOpen,
    setMobileSiderOpen
  } = useThemedLayoutContext();

  const isExistAuthentication = useIsExistAuthentication();
  const direction = useContext(ConfigProvider.ConfigContext)?.direction;
  const Link = useLink();
  const { warnWhen, setWarnWhen } = useWarnAboutChange();
  const translate = useTranslate();
  const { menuItems, selectedKey, defaultOpenKeys } = useMenu({ meta });
  const breakpoint = Grid.useBreakpoint();
  const { mutate: mutateLogout } = useLogout();
  const [extraOpenKeys, setExtraOpenKeys] = useState([ALWAYS_OPEN_KEY]);

  const isMobile = typeof breakpoint.lg === "undefined" ? false : !breakpoint.lg;
  const RenderToTitle = TitleFromProps ?? ThemedTitle;

  const combinedOpenKeys = useMemo(() => {
    const defaultExpandMenuItems = siderItemsAreCollapsed ? [] : menuItems.map(({ key }) => key);
    return [...new Set([ALWAYS_OPEN_KEY, ...defaultOpenKeys, ...defaultExpandMenuItems, ...extraOpenKeys])];
  }, [defaultOpenKeys, extraOpenKeys, menuItems, siderItemsAreCollapsed]);

  const renderTreeView = (tree, currentSelectedKey) => tree.map((item) => {
    const { key, name, children, meta: itemMeta, list } = item;
    const parentName = itemMeta?.parent;
    const label = item?.label ?? itemMeta?.label ?? name;
    const icon = itemMeta?.icon;
    const route = list;

    if (children.length > 0) {
      return (
        <CanAccess
          key={item.key}
          resource={name}
          action="list"
          params={{ resource: item }}
        >
          <Menu.SubMenu key={item.key} icon={icon ?? <UnorderedListOutlined />} title={label}>
            {renderTreeView(children, currentSelectedKey)}
          </Menu.SubMenu>
        </CanAccess>
      );
    }

    const isSelected = key === currentSelectedKey;
    const isRoute = !(parentName !== undefined && children.length === 0);
    const linkStyle = activeItemDisabled && isSelected ? { pointerEvents: "none" } : {};

    return (
      <CanAccess
        key={item.key}
        resource={name}
        action="list"
        params={{ resource: item }}
      >
        <Menu.Item key={item.key} icon={icon ?? (isRoute && <UnorderedListOutlined />)} style={linkStyle}>
          <Link to={route ?? ""} style={linkStyle}>
            {label}
          </Link>
          {!siderCollapsed && isSelected && <div className="ant-menu-tree-arrow" />}
        </Menu.Item>
      </CanAccess>
    );
  });

  const handleLogout = () => {
    if (warnWhen) {
      const confirm = window.confirm(
        translate("warnWhenUnsavedChanges", "Are you sure you want to leave? You have unsaved changes.")
      );

      if (confirm) {
        setWarnWhen(false);
        mutateLogout();
      }
    } else {
      mutateLogout();
    }
  };

  const logout = isExistAuthentication && (
    <Menu.Item key="logout" onClick={() => handleLogout()} icon={<LogoutOutlined />}>
      {translate("buttons.logout", "Logout")}
    </Menu.Item>
  );

  const items = renderTreeView(menuItems, selectedKey);

  const renderSider = () => {
    if (render) {
      return render({ items, logout, collapsed: siderCollapsed });
    }
    return [...items, logout].filter(Boolean);
  };

  const handleOpenChange = (keys) => {
    setExtraOpenKeys([...new Set([ALWAYS_OPEN_KEY, ...keys])]);
  };

  const renderMenu = () => (
    <Menu
      selectedKeys={selectedKey ? [selectedKey] : []}
      openKeys={combinedOpenKeys}
      onOpenChange={handleOpenChange}
      mode="inline"
      style={{
        paddingTop: "8px",
        border: "none",
        overflow: "auto",
        height: "calc(100% - 72px)"
      }}
      onClick={() => {
        setMobileSiderOpen(false);
      }}
    >
      {renderSider()}
    </Menu>
  );

  if (isMobile) {
    return (
      <>
        <Drawer
          open={mobileSiderOpen}
          onClose={() => setMobileSiderOpen(false)}
          placement={direction === "rtl" ? "right" : "left"}
          closable={false}
          width={200}
          styles={{ body: { padding: 0 } }}
          maskClosable
        >
          <Layout>
            <Layout.Sider
              style={{
                height: "100vh",
                backgroundColor: token.colorBgContainer,
                borderRight: `1px solid ${token.colorBgElevated}`
              }}
            >
              <div
                style={{
                  width: "200px",
                  padding: "0 16px",
                  display: "flex",
                  justifyContent: "flex-start",
                  alignItems: "center",
                  height: "64px",
                  backgroundColor: token.colorBgElevated
                }}
              >
                <RenderToTitle collapsed={false} />
              </div>
              {renderMenu()}
            </Layout.Sider>
          </Layout>
        </Drawer>
        <Button
          style={{
            borderStartStartRadius: 0,
            borderEndStartRadius: 0,
            position: "fixed",
            top: 64,
            zIndex: 999
          }}
          size="large"
          onClick={() => setMobileSiderOpen(true)}
          icon={<BarsOutlined />}
        />
      </>
    );
  }

  const siderStyles = {
    backgroundColor: token.colorBgContainer,
    borderRight: `1px solid ${token.colorBgElevated}`
  };

  if (fixed) {
    siderStyles.position = "fixed";
    siderStyles.top = 0;
    siderStyles.height = "100vh";
    siderStyles.zIndex = 999;
  }

  const iconProps = { style: { color: token.colorPrimary } };
  const OpenIcon = direction === "rtl" ? RightOutlined : LeftOutlined;
  const CollapsedIcon = direction === "rtl" ? LeftOutlined : RightOutlined;
  const IconComponent = siderCollapsed ? CollapsedIcon : OpenIcon;

  return (
    <>
      {fixed && (
        <div
          style={{
            width: siderCollapsed ? "80px" : "200px",
            transition: "all 0.2s"
          }}
        />
      )}
      <Layout.Sider
        style={siderStyles}
        collapsible
        collapsed={siderCollapsed}
        onCollapse={(collapsed, type) => {
          if (type === "clickTrigger") {
            setSiderCollapsed(collapsed);
          }
        }}
        collapsedWidth={80}
        breakpoint="lg"
        trigger={
          <Button
            type="text"
            style={{
              borderRadius: 0,
              height: "100%",
              width: "100%",
              backgroundColor: token.colorBgElevated
            }}
          >
            <IconComponent {...iconProps} />
          </Button>
        }
      >
        <div
          style={{
            width: siderCollapsed ? "80px" : "200px",
            padding: siderCollapsed ? "0" : "0 16px",
            display: "flex",
            justifyContent: siderCollapsed ? "center" : "flex-start",
            alignItems: "center",
            height: "64px",
            backgroundColor: token.colorBgElevated,
            fontSize: "14px"
          }}
        >
          <RenderToTitle collapsed={siderCollapsed} />
        </div>
        {renderMenu()}
      </Layout.Sider>
    </>
  );
}

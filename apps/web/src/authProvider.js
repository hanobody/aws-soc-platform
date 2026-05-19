import Keycloak from "keycloak-js";
import { getPublicSettings } from "./runtimeSettings";

let keycloak;
let keycloakSignature;

async function getAuthSettings() {
  const settings = await getPublicSettings();
  return {
    enabled: settings["auth.keycloak.enabled"] === true,
    url: settings["auth.keycloak.url"] || "",
    realm: settings["auth.keycloak.realm"] || "",
    clientId: settings["auth.keycloak.clientId"] || ""
  };
}

async function getKeycloakInstance() {
  const settings = await getAuthSettings();
  if (!settings.enabled) return { enabled: false, keycloak: null };

  const signature = JSON.stringify(settings);
  if (!keycloak || keycloakSignature !== signature) {
    keycloak = new Keycloak({
      url: settings.url,
      realm: settings.realm,
      clientId: settings.clientId,
    });
    keycloakSignature = signature;
  }

  return { enabled: true, keycloak };
}

async function ensureKeycloak() {
  const { enabled, keycloak } = await getKeycloakInstance();
  if (!enabled || !keycloak) return true;
  if (!keycloak.authenticated) {
    await keycloak.init({ onLoad: "check-sso", pkceMethod: "S256" });
  }
  return !!keycloak.authenticated;
}

export const authProvider = {
  login: async () => {
    const { enabled, keycloak } = await getKeycloakInstance();
    if (!enabled) {
      localStorage.setItem("soc_demo_login", "true");
      return { success: true, redirectTo: "/dashboard" };
    }
    await keycloak.login({ redirectUri: window.location.origin + "/dashboard" });
    return { success: true };
  },
  logout: async () => {
    const { enabled, keycloak } = await getKeycloakInstance();
    if (!enabled) {
      localStorage.removeItem("soc_demo_login");
      return { success: true, redirectTo: "/login" };
    }
    await keycloak.logout({ redirectUri: window.location.origin + "/login" });
    return { success: true };
  },
  check: async () => {
    const { enabled } = await getKeycloakInstance();
    if (!enabled) {
      const loggedIn = localStorage.getItem("soc_demo_login") === "true";
      return loggedIn ? { authenticated: true } : { authenticated: false, redirectTo: "/login" };
    }
    const ok = await ensureKeycloak();
    return ok ? { authenticated: true } : { authenticated: false, redirectTo: "/login" };
  },
  getIdentity: async () => {
    const { enabled, keycloak } = await getKeycloakInstance();
    if (!enabled) {
      return { id: "local-admin", name: "Local Admin" };
    }
    return {
      id: keycloak.subject,
      name: keycloak.tokenParsed?.preferred_username || keycloak.tokenParsed?.name || "Keycloak User"
    };
  },
  getPermissions: async () => null,
  onError: async (error) => {
    console.error(error);
    return { error };
  }
};

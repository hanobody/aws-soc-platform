const API_URL = import.meta.env.VITE_API_URL || "/api";

let publicSettingsCache = null;
let publicSettingsPromise = null;

export async function getPublicSettings(force = false) {
  if (!force && publicSettingsCache) return publicSettingsCache;
  if (!force && publicSettingsPromise) return publicSettingsPromise;

  publicSettingsPromise = fetch(`${API_URL}/settings/public`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`load public settings failed: ${response.status}`);
      }
      const payload = await response.json();
      publicSettingsCache = payload.data || {};
      return publicSettingsCache;
    })
    .catch((error) => {
      console.error(error);
      publicSettingsCache = {
        "auth.keycloak.enabled": false,
        "auth.keycloak.url": "",
        "auth.keycloak.realm": "",
        "auth.keycloak.clientId": ""
      };
      return publicSettingsCache;
    })
    .finally(() => {
      publicSettingsPromise = null;
    });

  return publicSettingsPromise;
}

export function invalidatePublicSettings() {
  publicSettingsCache = null;
}

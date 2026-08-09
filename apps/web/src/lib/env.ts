const defaultServerBaseUrl = "http://localhost:3001";

export function getServerBaseUrl() {
  // Must access process.env.NEXT_PUBLIC_* directly — webpack DefinePlugin
  // only replaces direct references, not indirect access via a variable.
  const configuredUrl = process.env.NEXT_PUBLIC_SERVER_BASE_URL?.trim();
  return configuredUrl || defaultServerBaseUrl;
}

export type WebEnv = {
  serverBaseUrl: string;
};

export function loadWebEnv(
  overrides: Partial<WebEnv> = {},
  source: NodeJS.ProcessEnv = process.env,
): WebEnv {
  return {
    serverBaseUrl:
      overrides.serverBaseUrl ??
      source.NEXT_PUBLIC_SERVER_BASE_URL?.trim() ??
      defaultServerBaseUrl,
  };
}

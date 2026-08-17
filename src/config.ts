import { redactUrlCredentials } from './redact.js';

export interface Config {
  /**
   * Base URL of the FreshRSS instance, e.g. `https://rss.example.com` — the
   * root of the web UI, *not* the API path. May be undefined together with the
   * credentials: the server still starts and lists its tools, every API call
   * then fails with {@link missingConfigMessage}.
   */
  url: string | undefined;
  user: string | undefined;
  /**
   * The **API password** from the FreshRSS user profile, not the web login
   * password. FreshRSS stores it separately (`apiPasswordHash`) and the
   * Google Reader compatible API only ever checks that one.
   */
  apiPassword: string | undefined;
  insecureTls: boolean;
  readOnly: boolean;
}

/** Shown when the configuration is incomplete — at startup and on every API call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: FRESHRSS_URL (e.g. https://rss.example.com), FRESHRSS_USER, FRESHRSS_API_PASSWORD\n' +
    'FRESHRSS_API_PASSWORD is the API password from the FreshRSS profile page ' +
    '(Settings → Profile → API management), not the web login password. The ' +
    'instance also needs the API enabled (Settings → Authentication → ' +
    '"Allow API access").\n' +
    'Optional: FRESHRSS_READ_ONLY=true to expose only read tools, ' +
    'FRESHRSS_INSECURE_TLS=true to accept self-signed certificates'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return [
    !config.url && 'FRESHRSS_URL',
    !config.user && 'FRESHRSS_USER',
    !config.apiPassword && 'FRESHRSS_API_PASSWORD',
  ].filter((v): v is string => Boolean(v));
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. A malformed URL still
 * exits — that one could send the credentials to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.FRESHRSS_URL;
  const user = env.FRESHRSS_USER;
  const apiPassword = env.FRESHRSS_API_PASSWORD;
  const insecureTls = env.FRESHRSS_INSECURE_TLS === 'true';
  const readOnly = env.FRESHRSS_READ_ONLY === 'true';

  const missing = [
    !url && 'FRESHRSS_URL',
    !user && 'FRESHRSS_USER',
    !apiPassword && 'FRESHRSS_API_PASSWORD',
  ].filter((v): v is string => Boolean(v));

  if (missing.length > 0) {
    console.error(`freshrss-mcp: ${missingConfigMessage(missing)}`);
  }

  // Don't keep the password in the environment for the process lifetime — it is
  // visible to child processes and in /proc/<pid>/environ.
  delete env.FRESHRSS_API_PASSWORD;

  if (!url) {
    return { url: undefined, user, apiPassword, insecureTls, readOnly };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Redacted, and deliberately so: the userinfo check below only runs once the
    // URL parses, so a value that does not parse at all but still carries
    // credentials — "https://admin:s3cret@host:99999", an out-of-range port —
    // would otherwise print the API password into the MCP client's log file.
    console.error(
      `freshrss-mcp: FRESHRSS_URL is not a valid URL: ${redactUrlCredentials(url)}`
    );
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(
      `freshrss-mcp: FRESHRSS_URL must use http:// or https:// (got ${parsed.protocol})`
    );
    process.exit(1);
  }
  // Credentials embedded in the URL would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    console.error(
      'freshrss-mcp: FRESHRSS_URL must not contain credentials — use FRESHRSS_USER and FRESHRSS_API_PASSWORD'
    );
    process.exit(1);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    console.error(
      'freshrss-mcp: WARNING: FRESHRSS_URL uses plain http to a non-local host — ' +
        'the API password will be sent unencrypted. Use https:// instead.'
    );
  }

  return {
    url: url.replace(/\/+$/, ''),
    user,
    apiPassword,
    insecureTls,
    readOnly,
  };
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.startsWith('127.') ||
    hostname === '::1'
  );
}
